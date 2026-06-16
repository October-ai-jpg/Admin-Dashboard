/**
 * services/systemAudit.js
 *
 * Automatic system-audit WATCHDOG. Runs ~3× daily (node-cron) + once at boot.
 * It black-box tests EVERY critical branch of the October AI platform from the
 * OUTSIDE (Admin-Dashboard is a separate Railway service), so even a fully
 * broken prod app still gets audited + alarmed.
 *
 * WHY THIS EXISTS
 *   2026-06-16 the prod voice-sample endpoint 500'd for weeks unnoticed (two
 *   hidden bugs: Cartesia sunset sonic-2 + a wrong import path on main). We only
 *   found it by accident. This watchdog catches that whole CLASS of regressions
 *   automatically and emails an alert the moment a previously-green check fails.
 *
 * TWO SUITES
 *   PROD  (read-only)    — runtime health on www.october-ai.com. Never writes,
 *                          never burns LLM credits beyond a greeting + 4 TTS
 *                          samples. Catches the exact sonic/import bug + key /
 *                          config / embed / landing regressions.
 *   STAGING (destructive)— full real-user journey (signup → trialing sub →
 *                          verify → agent build → voice LLM turn → affiliate),
 *                          then self-cleans all e2e-test-* data. Only runs when
 *                          AUDIT_STAGING_ENABLED=true AND AUDIT_STAGING_DATABASE_URL
 *                          is set (it needs DB access to resolve client_token +
 *                          poll compiled_context, exactly like the main-app
 *                          scripts/e2e-full-flow-audit.js it mirrors).
 *
 * Playwright is a devDependency in the main app, so this watchdog uses ONLY
 * fetch + ws + pg — all already present in Admin-Dashboard.
 *
 * Results are written to system_audits (one row per check). After each run, if
 * any check that is FAILing now was NOT failing in the previous run (a
 * green→red transition), exactly ONE alert email is sent via Resend (HTTPS) and
 * logged to email_log with kind='audit_alert'. Still-failing checks do not
 * re-alert (no spam).
 */
const cron = require('node-cron');
const crypto = require('crypto');
const WebSocket = require('ws');
const { Pool } = require('pg');

/* ── Config (all env-driven) ── */
const PROD_URL      = (process.env.AUDIT_PROD_URL || 'https://www.october-ai.com').replace(/\/+$/, '');
const STAGING_URL   = (process.env.AUDIT_STAGING_URL || '').replace(/\/+$/, '');
const ADMIN_TOKEN   = process.env.AUDIT_ADMIN_TOKEN || process.env.ADMIN_SECRET || 'october-admin-2026';
const STAGING_ON    = String(process.env.AUDIT_STAGING_ENABLED || '') === 'true';
const STAGING_DB    = process.env.AUDIT_STAGING_DATABASE_URL || '';
const RESEND_KEY    = process.env.RESEND_API_KEY || '';
const ALERT_TO      = process.env.AUDIT_ALERT_TO || 'kontakt@eb-media.dk';
const ALERT_FROM    = process.env.AUDIT_ALERT_FROM || 'October AI <hello@october-ai.com>';
const CANARY_TENANT = process.env.AUDIT_CANARY_TENANT || '';
const CANARY_TOKEN  = process.env.AUDIT_CANARY_TOKEN || '';
const CRON_EXPR     = process.env.AUDIT_CRON || '0 6,14,22 * * *';   // 3× daily, local time
const VOICE_KEYS    = ['us_female', 'us_male', 'australian', 'british'];

/* ── Small result helpers ──
   A check fn either returns a string (→ PASS with that detail), returns
   { status, detail } to force WARN, or throws (→ FAIL). */
function WARN(detail) { return { status: 'WARN', detail: detail || '' }; }
function keyOf(r) { return r.env + '|' + r.suite + '|' + r.check_name; }

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 15000);
  try { return await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {})); }
  finally { clearTimeout(t); }
}

/* ══════════════════════════════════════════
   SCHEMA
   ══════════════════════════════════════════ */
async function ensureSchema(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_audits (
      id BIGSERIAL PRIMARY KEY,
      run_id UUID NOT NULL,
      env TEXT NOT NULL,
      suite TEXT NOT NULL,
      check_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PASS','WARN','FAIL')),
      detail TEXT,
      duration_ms INTEGER,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_audits_run ON system_audits(run_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_system_audits_ran_at ON system_audits(ran_at DESC)`);
}

/* Set of check-keys that were FAILing in the most recent PRIOR run. */
async function previousFailKeys(pool) {
  const set = new Set();
  if (!pool) return set;
  try {
    const prev = await pool.query(
      `SELECT run_id FROM system_audits ORDER BY ran_at DESC LIMIT 1`
    );
    if (!prev.rows.length) return set;
    const runId = prev.rows[0].run_id;
    const rows = await pool.query(
      `SELECT env, suite, check_name FROM system_audits WHERE run_id = $1 AND status = 'FAIL'`,
      [runId]
    );
    rows.rows.forEach((r) => set.add(keyOf(r)));
  } catch (e) { console.warn('[audit] previousFailKeys:', e.message); }
  return set;
}

async function persist(pool, runId, results) {
  if (!pool) return;
  for (const r of results) {
    try {
      await pool.query(
        `INSERT INTO system_audits (run_id, env, suite, check_name, status, detail, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [runId, r.env, r.suite, r.check_name, r.status, (r.detail || '').slice(0, 2000), r.duration_ms || null]
      );
    } catch (e) { console.warn('[audit] persist row:', e.message); }
  }
}

/* ══════════════════════════════════════════
   CHECK RUNNER — times + grades a single check
   ══════════════════════════════════════════ */
async function runCheck(results, env, suite, name, fn) {
  const t = Date.now();
  try {
    const out = await fn();
    if (out && typeof out === 'object' && out.status) {
      results.push({ env, suite, check_name: name, status: out.status, detail: out.detail || '', duration_ms: Date.now() - t });
    } else {
      results.push({ env, suite, check_name: name, status: 'PASS', detail: (typeof out === 'string' ? out : ''), duration_ms: Date.now() - t });
    }
  } catch (e) {
    results.push({ env, suite, check_name: name, status: 'FAIL', detail: (e && e.message) || String(e), duration_ms: Date.now() - t });
  }
}

/* ══════════════════════════════════════════
   PROD READ-ONLY SUITE
   ══════════════════════════════════════════ */
async function runProdReadonly(results) {
  const E = 'prod', S = 'readonly';
  const base = PROD_URL;

  await runCheck(results, E, S, 'health', async () => {
    const r = await fetchWithTimeout(base + '/health', {}, 15000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json().catch(() => ({}));
    if (j.db !== 'connected') throw new Error('db=' + j.db);
    return 'status=' + j.status + ' db=' + j.db + ' build=' + (j.build || '?');
  });

  await runCheck(results, E, S, 'diag_keys', async () => {
    const r = await fetchWithTimeout(base + '/api/diag', { headers: { Authorization: 'Bearer ' + ADMIN_TOKEN } }, 15000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json().catch(() => ({}));
    const missing = [];
    ['deepgramKey', 'openaiKey', 'cartesiaKey', 'groqKey', 'stripeKey', 'stripeWebhookSecret'].forEach((k) => {
      if (!j[k] || j[k] === 'MISSING') missing.push(k);
    });
    if (missing.length) throw new Error('missing keys: ' + missing.join(', '));
    return 'all keys set; stripe=' + j.stripeKey;
  });

  // The exact bug we just fixed: every voice sample must return audio/wav.
  for (const vk of VOICE_KEYS) {
    await runCheck(results, E, S, 'voice_sample_' + vk, async () => {
      if (!CANARY_TOKEN) return WARN('AUDIT_CANARY_TOKEN not set — sample check skipped');
      const r = await fetchWithTimeout(base + '/client/' + CANARY_TOKEN + '/voices/sample/' + vk, {}, 25000);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (!/audio\/wav|audio\/x-wav|application\/octet-stream/i.test(ct)) throw new Error('content-type=' + ct);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1000) throw new Error('tiny payload ' + buf.length + ' bytes');
      if (buf.slice(0, 4).toString('ascii') !== 'RIFF') throw new Error('no RIFF header');
      return buf.length + ' bytes wav';
    });
  }

  await runCheck(results, E, S, 'tour_config', async () => {
    if (!CANARY_TENANT) return WARN('AUDIT_CANARY_TENANT not set — config check skipped');
    const r = await fetchWithTimeout(base + '/api/tour/' + CANARY_TENANT + '/config', {}, 15000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json().catch(() => ({}));
    if (!j.voiceToken) throw new Error('config missing voiceToken');
    return 'voiceToken issued; agent=' + (j.agentName || '?');
  });

  await runCheck(results, E, S, 'embed_js', async () => {
    const r = await fetchWithTimeout(base + '/embed.js', {}, 15000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    if (txt.length < 500) throw new Error('embed.js too small (' + txt.length + ' bytes)');
    if (!/tenant|october|config/i.test(txt)) throw new Error('embed.js missing expected boot markers');
    return txt.length + ' bytes';
  });

  await runCheck(results, E, S, 'landing_home', async () => {
    const r = await fetchWithTimeout(base + '/', {}, 15000);
    if (!r.ok && r.status !== 304) throw new Error('HTTP ' + r.status);
    return 'HTTP ' + r.status;
  });

  await runCheck(results, E, S, 'landing_pricing', async () => {
    const r = await fetchWithTimeout(base + '/pricing', {}, 15000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = await r.text();
    if (!/get started|start free|month/i.test(txt)) throw new Error('pricing page missing expected CTA markers');
    return 'HTTP ' + r.status + ', markers present';
  });

  // Voice greeting only (WARN-only). No test_user_text on prod — it closes the
  // socket there (per ops notes) and would burn an LLM turn. A greeting alone
  // proves the agent boots.
  await runCheck(results, E, S, 'voice_ws_greeting', async () => {
    if (!CANARY_TENANT) return WARN('AUDIT_CANARY_TENANT not set — WS check skipped');
    const cfg = await fetchWithTimeout(base + '/api/tour/' + CANARY_TENANT + '/config', {}, 15000)
      .then((r) => r.json()).catch(() => ({}));
    const wsBase = base.replace(/^http/, 'ws');
    const proof = await new Promise((resolve) => {
      const res = { open: false, greeting: false, error: null };
      let ws;
      const guard = setTimeout(() => { try { ws && ws.close(); } catch (_) {} resolve(res); }, 25000);
      try { ws = new WebSocket(wsBase + '/ws/voice'); } catch (e) { res.error = e.message; clearTimeout(guard); return resolve(res); }
      ws.on('open', () => {
        res.open = true;
        ws.send(JSON.stringify({
          type: 'session_init', tenantId: CANARY_TENANT, token: cfg.voiceToken || undefined,
          client_version: 'audit-watchdog', testMode: true,
          pageMeta: { host: 'audit.local', url: 'https://audit.local/' }
        }));
      });
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === 'error') res.error = m.message || m.reason || 'error';
        if (m.type === 'transcript' && m.role === 'assistant' && m.text) {
          res.greeting = true; clearTimeout(guard); try { ws.close(); } catch (_) {} resolve(res);
        }
      });
      ws.on('error', (e) => { res.error = e.message; });
      ws.on('close', () => { clearTimeout(guard); resolve(res); });
    });
    if (!proof.open) throw new Error('WS did not open' + (proof.error ? ' (' + proof.error + ')' : ''));
    if (!proof.greeting) return WARN('WS opened but no greeting transcript' + (proof.error ? ' (' + proof.error + ')' : ''));
    return 'WS open + greeting received';
  });
}

/* ══════════════════════════════════════════
   STAGING DESTRUCTIVE SUITE
   Mirrors scripts/e2e-full-flow-audit.js using fetch + ws + pg.
   ══════════════════════════════════════════ */
async function runStagingDestructive(results) {
  const E = 'staging', S = 'destructive';
  const base = STAGING_URL;
  const wsBase = base.replace(/^http/, 'ws');
  const ts = Date.now();
  const EMAIL = 'e2e-test-audit-' + ts + '@example.com';
  const PASSWORD = 'Auditflow12';
  const NAME = 'E2E Audit';
  const REF = 'E2EAU' + String(ts).slice(-5);
  const TOUR_MODEL = 'SxQL3iGyoDo';

  const post = async (path, body) => {
    const r = await fetchWithTimeout(base + path, {
      method: 'POST', headers: { Authorization: 'Bearer ' + ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }, 30000);
    return r.json().catch(() => ({}));
  };
  const get = async (path) => {
    const r = await fetchWithTimeout(base + path, { headers: { Authorization: 'Bearer ' + ADMIN_TOKEN } }, 20000);
    return r.json().catch(() => ({}));
  };

  const db = new Pool({ connectionString: STAGING_DB, ssl: { rejectUnauthorized: false }, max: 2 });
  const q1 = async (sql, p) => (await db.query(sql, p || [])).rows[0];

  let userId = null, tenantId = null, clientToken = null, customerId = null, subscriptionId = null;

  try {
    // seed affiliate so attribution is testable
    await db.query(
      "INSERT INTO affiliates (ref_code,name,email,status,commission_rate) VALUES ($1,$2,$3,'active',0.25) ON CONFLICT (ref_code) DO NOTHING",
      [REF, 'E2E Audit Aff', 'e2e-test-aff-' + ts + '@example.com']
    ).catch(() => {});

    // 1. SIGNUP (direct POST to /auth/signup, affiliate attribution in body)
    await runCheck(results, E, S, 'signup', async () => {
      await post('/auth/signup', { name: NAME, email: EMAIL, password: PASSWORD, affiliate_ref: REF });
      const u = await get('/api/admin/test/user/' + EMAIL);
      if (!u.user) throw new Error('no user row after /auth/signup');
      userId = u.user.id;
      const tRow = await q1('SELECT id, client_token FROM tenants WHERE user_id=$1 ORDER BY created_at LIMIT 1', [userId]);
      tenantId = tRow && tRow.id; clientToken = tRow && tRow.client_token;
      if (!tenantId || !clientToken) throw new Error('no tenant/client_token provisioned at signup');
      return 'user + default agent created';
    });

    // 1b. affiliate attribution (WARN-only — cookie path varies)
    await runCheck(results, E, S, 'affiliate_attribution', async () => {
      const u = await get('/api/admin/test/user/' + EMAIL);
      if (u.user && u.user.affiliate_ref === REF) return 'users.affiliate_ref=' + REF;
      return WARN('affiliate_ref=' + (u.user && u.user.affiliate_ref));
    });

    // 2. PROVISION trialing subscription + checkout webhook (free-month quota)
    await runCheck(results, E, S, 'billing_trial_provision', async () => {
      const prov = await post('/api/admin/test/provision-trial-subscription', { email: EMAIL });
      customerId = prov.customerId; subscriptionId = prov.subscriptionId;
      if (prov.status !== 'trialing') throw new Error('provision status=' + prov.status + ' ' + (prov.error || ''));
      await post('/api/admin/test/stripe-event', {
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_audit_' + ts, subscription: subscriptionId, customer: customerId, metadata: { type: 'volume_checkout', userId, qty: '1' } } }
      });
      const u = await get('/api/admin/test/user/' + EMAIL);
      if (!u.user || u.user.plan !== 'volume') throw new Error('plan=' + (u.user && u.user.plan) + ' (expected volume)');
      return 'trialing sub + plan=volume';
    });

    await runCheck(results, E, S, 'billing_free_month_quota', async () => {
      const u = await get('/api/admin/test/user/' + EMAIL);
      if (u.user && u.user.monthly_minutes_quota === 500) return 'free-month quota=500';
      return WARN('quota=' + (u.user && u.user.monthly_minutes_quota) + ' (expected 500)');
    });

    // 3. EMAIL VERIFICATION
    await runCheck(results, E, S, 'email_verify', async () => {
      const tok = await get('/api/admin/test/email-token/' + EMAIL);
      if (!tok || !tok.token) return WARN('no verification token issued (email send may have failed)');
      const vr = await fetchWithTimeout(base + '/auth/verify?token=' + tok.token, { redirect: 'manual' }, 15000);
      if (!(vr.status >= 200 && vr.status < 400)) throw new Error('/auth/verify HTTP ' + vr.status);
      const u = await get('/api/admin/test/user/' + EMAIL);
      if (!u.user || u.user.email_verified !== true) throw new Error('email_verified=' + (u.user && u.user.email_verified));
      return 'token accepted + email_verified=true';
    });

    // 4. AGENT BUILDER — save every field through the real authed update route
    await runCheck(results, E, S, 'agent_builder_save', async () => {
      if (!clientToken) throw new Error('no client_token (signup failed earlier)');
      const r = await fetchWithTimeout(base + '/client/' + clientToken + '/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentName: 'Aria',
          property_data: 'Bright 3-bedroom apartment in central Copenhagen. 95 m2, south-facing balcony, renovated kitchen, close to Metro. Asking price 4.2M DKK.',
          propertyUrl: 'https://example.com/listing/cph-95m2',
          bookingUrl: 'https://example.com/book-viewing',
          language: 'en',
          matterportUrl: TOUR_MODEL,
          tourProvider: 'matterport'
        })
      }, 20000);
      if (!(r.status >= 200 && r.status < 300)) throw new Error('update HTTP ' + r.status);
      // poll DB up to ~25s for compiled_context (fire-and-forget LLM compile)
      let persisted = null;
      for (let i = 0; i < 25; i++) {
        persisted = await q1('SELECT agent_name, model_id, tour_provider, property_data, compiled_context FROM tenants WHERE id=$1', [tenantId]);
        if (persisted && persisted.compiled_context && persisted.compiled_context.length > 40) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      if (!persisted || persisted.agent_name !== 'Aria') throw new Error('agent_name=' + (persisted && persisted.agent_name));
      if (persisted.model_id !== TOUR_MODEL) throw new Error('model_id=' + persisted.model_id);
      if (!persisted.property_data || !/Copenhagen/.test(persisted.property_data)) throw new Error('property_data missing');
      if (!persisted.compiled_context || persisted.compiled_context.length <= 40) {
        return WARN('saved but compiled_context len=' + (persisted.compiled_context || '').length);
      }
      return 'all fields persisted + context compiled (' + persisted.compiled_context.length + ' chars)';
    });

    // 5. VOICE — config + full LLM turn (one cheap turn)
    await runCheck(results, E, S, 'voice_full_turn', async () => {
      if (!tenantId) throw new Error('no tenantId');
      const cfg = await fetchWithTimeout(base + '/api/tour/' + tenantId + '/config', {}, 15000).then((r) => r.json()).catch(() => ({}));
      if (!cfg.voiceToken) throw new Error('config missing voiceToken');
      const proof = await new Promise((resolve) => {
        const res = { open: false, greeting: false, reply: false, error: null };
        let greetingSeen = false, sentTurn = false, replySeen = false, ws;
        const guard = setTimeout(() => { try { ws && ws.close(); } catch (_) {} resolve(res); }, 40000);
        try { ws = new WebSocket(wsBase + '/ws/voice'); } catch (e) { res.error = e.message; clearTimeout(guard); return resolve(res); }
        ws.on('open', () => {
          res.open = true;
          ws.send(JSON.stringify({
            type: 'session_init', tenantId, token: cfg.voiceToken || undefined,
            client_version: 'audit-watchdog', testMode: true,
            pageMeta: { host: 'example.com', url: 'https://example.com/listing/cph-95m2' }
          }));
        });
        ws.on('message', (raw, isBinary) => {
          if (isBinary) return;
          let m; try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.type === 'error') res.error = m.message || m.reason || 'error';
          if (m.type === 'transcript' && m.role === 'assistant' && m.text) {
            if (!greetingSeen) {
              greetingSeen = true; res.greeting = true;
              setTimeout(() => { if (!sentTurn) { sentTurn = true; ws.send(JSON.stringify({ type: 'test_user_text', text: 'Can you tell me about this apartment?' })); } }, 800);
            } else if (sentTurn && !replySeen) {
              replySeen = true; res.reply = true; clearTimeout(guard); try { ws.close(); } catch (_) {} resolve(res);
            }
          }
        });
        ws.on('error', (e) => { res.error = e.message; });
        ws.on('close', () => { clearTimeout(guard); resolve(res); });
      });
      if (!proof.open) throw new Error('WS did not open' + (proof.error ? ' (' + proof.error + ')' : ''));
      if (!proof.greeting) throw new Error('no greeting' + (proof.error ? ' (' + proof.error + ')' : ''));
      if (!proof.reply) return WARN('greeting OK but no LLM reply captured within timeout');
      return 'WS open + greeting + LLM reply (full pipeline live)';
    });

  } catch (e) {
    results.push({ env: E, suite: S, check_name: 'suite_error', status: 'FAIL', detail: (e && e.message) || String(e), duration_ms: 0 });
  } finally {
    // CLEANUP — server-side endpoints + belt-and-suspenders direct DB
    try { if (customerId) await post('/api/admin/test/cleanup-stripe-customer', { customerId }); } catch (_) {}
    try { await post('/api/admin/cleanup-test-data', {}); } catch (_) {}
    try {
      await db.query('DELETE FROM affiliate_commissions WHERE affiliate_ref=$1', [REF]).catch(() => {});
      if (userId) {
        await db.query('DELETE FROM tenants WHERE user_id=$1', [userId]).catch(() => {});
        await db.query('DELETE FROM clients WHERE user_id=$1', [userId]).catch(() => {});
        await db.query('DELETE FROM sessions WHERE user_id=$1', [userId]).catch(() => {});
        await db.query('DELETE FROM email_tokens WHERE user_id=$1', [userId]).catch(() => {});
      }
      await db.query('DELETE FROM users WHERE email=$1', [EMAIL]).catch(() => {});
      await db.query('DELETE FROM affiliates WHERE ref_code=$1', [REF]).catch(() => {});
    } catch (_) {}
    try { await db.end(); } catch (_) {}
  }
}

/* ══════════════════════════════════════════
   ALERT — Resend HTTPS (no npm dep) + email_log
   ══════════════════════════════════════════ */
async function sendAlert(pool, runId, failures) {
  const lines = failures.map((f) => '• [' + f.env + '/' + f.suite + '] ' + f.check_name + ' — ' + (f.detail || '')).join('\n');
  const subject = '🚨 October AI audit: ' + failures.length + ' check(s) FAILED';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a">' +
    '<h2 style="margin:0 0 12px">October AI — system audit alert</h2>' +
    '<p>The automatic watchdog detected <b>' + failures.length + '</b> newly-failing check(s):</p>' +
    '<pre style="background:#f6f6f6;padding:14px;border-radius:8px;white-space:pre-wrap;font-size:13px">' +
      failures.map((f) => '[' + f.env + '/' + f.suite + '] ' + f.check_name + '\n   ' + (f.detail || '')).join('\n\n') +
    '</pre>' +
    '<p style="color:#666;font-size:12px">Run ' + runId + ' · ' + new Date().toISOString() +
      ' · open the Admin Dashboard → System Audit for full history.</p>' +
    '</div>';

  let status = 'failed', messageId = null, errMsg = null;
  if (!RESEND_KEY) {
    errMsg = 'RESEND_API_KEY not set — alert email disabled';
    console.error('[audit] ' + errMsg + '\n' + lines);
  } else {
    try {
      const r = await fetchWithTimeout('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_TO], subject, html })
      }, 15000);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.id) { status = 'sent'; messageId = j.id; }
      else { errMsg = 'Resend HTTP ' + r.status + ' ' + JSON.stringify(j).slice(0, 200); }
    } catch (e) { errMsg = e.message; }
  }

  // Log to the shared email_log so it surfaces in the Email-Marketing flow view.
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO email_log (user_id, to_addr, subject, kind, resend_message_id, status, error)
         VALUES (NULL, $1, $2, 'audit_alert', $3, $4, $5)`,
        [ALERT_TO, subject, messageId, status, errMsg]
      );
    } catch (e) { console.warn('[audit] email_log insert:', e.message); }
  }
  console.log('[audit] alert ' + status + (messageId ? ' id=' + messageId : '') + (errMsg ? ' err=' + errMsg : ''));
}

/* ══════════════════════════════════════════
   ORCHESTRATION
   ══════════════════════════════════════════ */
async function runAudit(pool, trigger) {
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  console.log('[audit] run start (' + (trigger || 'manual') + ') id=' + runId);

  const prevFail = await previousFailKeys(pool);
  const results = [];

  await runProdReadonly(results).catch((e) => {
    results.push({ env: 'prod', suite: 'readonly', check_name: 'suite_error', status: 'FAIL', detail: e.message, duration_ms: 0 });
  });

  if (STAGING_ON && STAGING_URL && STAGING_DB) {
    await runStagingDestructive(results).catch((e) => {
      results.push({ env: 'staging', suite: 'destructive', check_name: 'suite_error', status: 'FAIL', detail: e.message, duration_ms: 0 });
    });
  } else if (STAGING_ON && (!STAGING_URL || !STAGING_DB)) {
    results.push({ env: 'staging', suite: 'destructive', check_name: 'suite_config', status: 'WARN', detail: 'AUDIT_STAGING_ENABLED but AUDIT_STAGING_URL/AUDIT_STAGING_DATABASE_URL missing', duration_ms: 0 });
  }

  await persist(pool, runId, results);

  const curFail = results.filter((r) => r.status === 'FAIL');
  const newFail = curFail.filter((r) => !prevFail.has(keyOf(r)));
  if (newFail.length) await sendAlert(pool, runId, curFail);

  const pass = results.filter((r) => r.status === 'PASS').length;
  const warn = results.filter((r) => r.status === 'WARN').length;
  console.log('[audit] run done id=' + runId + ' — ' + pass + ' pass, ' + warn + ' warn, ' + curFail.length + ' fail (' +
    newFail.length + ' new) in ' + (Date.now() - startedAt) + 'ms');
  return { runId, pass, warn, fail: curFail.length, newFail: newFail.length, durationMs: Date.now() - startedAt, results };
}

/* Start the watchdog: ensure schema, register cron, run once at boot. */
function startWatchdog(pool) {
  ensureSchema(pool).then(() => {
    console.log('[audit] schema ready; cron=' + CRON_EXPR + ' staging=' + (STAGING_ON ? 'on' : 'off'));
    // boot run (slight delay so the rest of the app finishes warming up)
    setTimeout(() => { runAudit(pool, 'boot').catch((e) => console.error('[audit] boot run:', e.message)); }, 30000);
    if (cron.validate(CRON_EXPR)) {
      cron.schedule(CRON_EXPR, () => { runAudit(pool, 'cron').catch((e) => console.error('[audit] cron run:', e.message)); });
    } else {
      console.error('[audit] invalid AUDIT_CRON expression: ' + CRON_EXPR);
    }
  }).catch((e) => console.error('[audit] ensureSchema failed:', e.message));
}

module.exports = { startWatchdog, runAudit, ensureSchema, CRON_EXPR };
