/* routes/linkedin.js — Admin-Dashboard LinkedIn Outreach.
 * ──────────────────────────────────────────────────────────────────
 * Turns a 10k+ lead backlog (name + company) into a reviewable,
 * cap-aware outreach queue. Reads/writes the linkedin_* tables created
 * by eb-tour-agent migration v71 on the shared main Postgres.
 *
 * Human-in-the-loop by design: drafts are generated here, the founder
 * reviews them in the dashboard, and the Chrome extension only FILLS
 * LinkedIn's compose box — the founder clicks LinkedIn's own Send.
 * Nothing here auto-sends, auto-connects, or scrapes profiles.
 *
 * Mounted at /api/linkedin (open access — same as the rest of the
 * dashboard; requireAuth is a pass-through in server.js).
 *
 * Endpoints:
 *   GET   /leads        list + filter (?page,&limit,&search,&status,&channel,&tier)
 *   POST  /import       bulk import rows [{name,company,tier?,profile_url?}]
 *   GET   /batch        today's cap-aware sendable queue
 *   GET   /next         single next eligible lead (Chrome extension)
 *   GET   /stats        counts by status + caps usage + backlog/ETA
 *   GET   /templates    the inmail + note bodies
 *   POST  /templates    update a template body
 *   GET   /settings     caps + onepager_url
 *   POST  /settings     update caps + onepager_url
 *   PATCH /leads/:id    edit tier/channel/outreach_draft/company_update/profile_url
 *   POST  /leads/:id/approve · /skip · /sent
 *   POST  /leads/:id/regenerate · POST /regenerate-all
 *   POST  /leads/:id/reply   store inbound + generate reply draft (OpenAI)
 * ────────────────────────────────────────────────────────────────── */

const express = require('express');

/* Concise, factual product brief used to ground reply drafts. Written
   here in plain terms (not a copy of the marketing one-pager) so the
   LLM stays accurate without us shipping the PDF text. */
const PRODUCT_BRIEF =
`October AI is a voice-AI agent that embeds directly inside an existing
Matterport virtual tour. It is trained on the customer's own business, so
visitors can talk to it and get answers, recommendations and guidance in
real time while they explore the tour. Typical outcomes: more qualified
leads, less repetitive admin, and clearer insight into what prospects are
looking for before they reach out. Setup is quick — the agent layers on top
of the tour the company already has.`;

/* Render a template body for a lead.
   [Name] → the person's first name. Our leads are business TARGETS, so the
   person is usually not known until the user finds them on LinkedIn. In that
   case we keep the literal "[Name]" token as a visible fill-in placeholder —
   the user types the real first name (in the panel / compose box) once they
   find the decision-maker. Only substitute when we actually have a name.
   [COMPANY_UPDATE] → " " + the enrichment line (or removed entirely). */
function renderDraft(body, firstName, companyUpdate) {
  let out = String(body || '');
  const fn = String(firstName || '').trim();
  if (fn) out = out.split('[Name]').join(fn); // else leave [Name] for the user to fill
  const upd = String(companyUpdate || '').trim();
  out = out.split('[COMPANY_UPDATE]').join(upd ? ' ' + upd : '');
  return out;
}

function channelForTier(tier) {
  return tier === 'top' ? 'inmail' : 'note';
}

/* Build a LinkedIn people-search URL from name + company so the
   extension/dashboard can jump straight to the person. If we already
   stored a profile_url, the caller prefers that. */
function searchUrl(name, company) {
  const kw = [name, company].filter(Boolean).join(' ');
  return 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(kw);
}

module.exports = function (pool) {
  const router = express.Router();

  async function q(sql, params) {
    if (!pool) return { rows: [] };
    try { return await pool.query(sql, params || []); }
    catch (e) { console.error('[linkedin] DB error:', e.message); throw e; }
  }

  function guardPool(res) {
    if (!pool) { res.status(503).json({ error: 'Database not configured' }); return false; }
    return true;
  }

  async function getTemplates() {
    const r = await q(`SELECT channel, body FROM linkedin_templates`);
    const map = { inmail: '', note: '' };
    for (const row of r.rows) map[row.channel] = row.body;
    return map;
  }

  async function getSettings() {
    const r = await q(`SELECT id, inmail_daily_cap, note_daily_cap, note_weekly_cap, onepager_url FROM linkedin_settings WHERE id = 1`);
    return r.rows[0] || { inmail_daily_cap: 2, note_daily_cap: 15, note_weekly_cap: 100, onepager_url: '' };
  }

  /* ─── Leads list (paginated + filtered) ──────────────────────── */
  router.get('/leads', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const page  = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10) || 50));
      const offset = (page - 1) * limit;
      const search = String(req.query.search || '').trim().toLowerCase();
      const status = String(req.query.status || '').trim();
      const channel = String(req.query.channel || '').trim();
      const tier = String(req.query.tier || '').trim();

      const where = [];
      const params = [];
      if (['draft_ready','approved','sent','replied','skipped'].includes(status)) {
        params.push(status); where.push('status = $' + params.length);
      }
      if (['inmail','note'].includes(channel)) {
        params.push(channel); where.push('channel = $' + params.length);
      }
      if (['top','standard'].includes(tier)) {
        params.push(tier); where.push('tier = $' + params.length);
      }
      if (search) {
        params.push('%' + search + '%');
        const p = '$' + params.length;
        where.push(`(LOWER(name) LIKE ${p} OR LOWER(COALESCE(company,'')) LIKE ${p})`);
      }
      const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

      const totalRes = await q(`SELECT COUNT(*)::int AS n FROM linkedin_leads ${whereSql}`, params);
      const total = totalRes.rows[0] ? totalRes.rows[0].n : 0;

      const rowsRes = await q(
        `SELECT id, name, first_name, company, profile_url, tier, channel, status,
                outreach_draft, company_update, reply_text, reply_draft, reply_status,
                sent_at, replied_at, created_at, updated_at
           FROM linkedin_leads
           ${whereSql}
           ORDER BY
             CASE status WHEN 'replied' THEN 0 WHEN 'draft_ready' THEN 1 WHEN 'approved' THEN 2
                         WHEN 'sent' THEN 3 ELSE 4 END,
             CASE channel WHEN 'inmail' THEN 0 ELSE 1 END,
             created_at DESC
           LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      const leads = rowsRes.rows.map(row => ({
        ...row,
        search_url: row.profile_url || searchUrl(row.name, row.company)
      }));
      res.json({
        ok: true,
        leads,
        total,
        page,
        totalPages: Math.max(1, Math.ceil(total / limit))
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Import (bulk, client sends ~500-row chunks) ────────────── */
  router.post('/import', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
      const sourceFile = String((req.body && req.body.source_file) || '').slice(0, 200) || null;
      if (!rows.length) return res.status(400).json({ error: 'rows[] required' });
      if (rows.length > 1000) return res.status(400).json({ error: 'Max 1000 rows per chunk' });

      const tpl = await getTemplates();

      const vals = [];
      const seen = new Set();
      for (const r of rows) {
        const name = String((r && r.name) || '').trim();
        if (!name) continue;
        const company = String((r && r.company) || '').trim() || null;
        /* Dedup within the chunk — ON CONFLICT DO NOTHING does not
           deduplicate rows inserted by the same statement. */
        const key = name.toLowerCase() + '|' + (company || '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const tier = (r && r.tier === 'top') ? 'top' : 'standard';
        const channel = channelForTier(tier);
        const profileUrl = (r && r.profile_url) ? String(r.profile_url).trim().slice(0, 500) : null;
        /* Leads are business targets: `name` is the business/company, not a
           person. Only set first_name if the client explicitly hands us a
           known contact; otherwise leave it null so the draft keeps the
           [Name] placeholder until the user finds the person via search. */
        const firstName = (r && typeof r.first_name === 'string' && r.first_name.trim())
          ? r.first_name.trim() : null;
        const draft = renderDraft(tpl[channel], firstName, '');
        vals.push({ name, firstName, company, profileUrl, tier, channel, draft });
      }
      if (!vals.length) return res.json({ ok: true, imported: 0, skipped: rows.length });

      /* Bulk INSERT via UNNEST — single round-trip. ON CONFLICT on the
         (lower(name), lower(company)) unique index skips duplicates. */
      const cols = {
        name: vals.map(v => v.name),
        first_name: vals.map(v => v.firstName),
        company: vals.map(v => v.company),
        profile_url: vals.map(v => v.profileUrl),
        tier: vals.map(v => v.tier),
        channel: vals.map(v => v.channel),
        outreach_draft: vals.map(v => v.draft)
      };
      const ins = await q(
        `INSERT INTO linkedin_leads (name, first_name, company, profile_url, tier, channel, outreach_draft, source_file)
         SELECT t.name, t.first_name, t.company, t.profile_url, t.tier, t.channel, t.outreach_draft, $8::text
         FROM UNNEST(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]
         ) AS t(name, first_name, company, profile_url, tier, channel, outreach_draft)
         ON CONFLICT (LOWER(name), LOWER(COALESCE(company, ''))) DO NOTHING
         RETURNING id`,
        [cols.name, cols.first_name, cols.company, cols.profile_url, cols.tier, cols.channel, cols.outreach_draft, sourceFile]
      );
      const imported = ins.rows.length;
      res.json({ ok: true, imported, skipped: rows.length - imported });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Cap usage helper (sent counts per channel) ─────────────── */
  async function capUsage() {
    const r = await q(
      `SELECT channel,
              COUNT(*) FILTER (WHERE sent_at >= date_trunc('day', NOW()))::int  AS today,
              COUNT(*) FILTER (WHERE sent_at >= date_trunc('week', NOW()))::int  AS week,
              COUNT(*) FILTER (WHERE sent_at >= date_trunc('month', NOW()))::int AS month
         FROM linkedin_leads
        WHERE status IN ('sent','replied') AND sent_at IS NOT NULL
        GROUP BY channel`
    );
    const out = { inmail: { today: 0, week: 0, month: 0 }, note: { today: 0, week: 0, month: 0 } };
    for (const row of r.rows) if (out[row.channel]) out[row.channel] = { today: row.today, week: row.week, month: row.month };
    return out;
  }

  /* ─── Today's batch (cap-aware) ──────────────────────────────── */
  router.get('/batch', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const settings = await getSettings();
      const usage = await capUsage();
      const inmailRemaining = Math.max(0, settings.inmail_daily_cap - usage.inmail.today);
      const noteDailyRemaining = Math.max(0, settings.note_daily_cap - usage.note.today);
      const noteWeeklyRemaining = Math.max(0, settings.note_weekly_cap - usage.note.week);
      const noteRemaining = Math.min(noteDailyRemaining, noteWeeklyRemaining);

      async function pick(channel, n) {
        if (n <= 0) return [];
        const r = await q(
          `SELECT id, name, first_name, company, profile_url, tier, channel, status, outreach_draft, company_update
             FROM linkedin_leads
            WHERE channel = $1 AND status IN ('draft_ready','approved')
            ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END,
                     CASE tier WHEN 'top' THEN 0 ELSE 1 END,
                     created_at ASC
            LIMIT $2`,
          [channel, n]
        );
        return r.rows.map(row => ({ ...row, search_url: row.profile_url || searchUrl(row.name, row.company) }));
      }

      const inmail = await pick('inmail', inmailRemaining);
      const note = await pick('note', noteRemaining);

      res.json({
        ok: true,
        caps: {
          inmail: { cap: settings.inmail_daily_cap, used_today: usage.inmail.today, remaining: inmailRemaining },
          note: {
            daily_cap: settings.note_daily_cap, used_today: usage.note.today,
            weekly_cap: settings.note_weekly_cap, used_week: usage.note.week,
            remaining: noteRemaining
          }
        },
        inmail, note
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Next single lead (Chrome extension) ────────────────────── */
  router.get('/next', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const channel = ['inmail','note'].includes(String(req.query.channel || '')) ? req.query.channel : null;
      const params = [];
      let chanSql = '';
      if (channel) { params.push(channel); chanSql = 'AND channel = $1'; }
      const r = await q(
        `SELECT id, name, first_name, company, profile_url, tier, channel, status, outreach_draft, company_update
           FROM linkedin_leads
          WHERE status IN ('draft_ready','approved') ${chanSql}
          ORDER BY CASE status WHEN 'approved' THEN 0 ELSE 1 END,
                   CASE channel WHEN 'inmail' THEN 0 ELSE 1 END,
                   CASE tier WHEN 'top' THEN 0 ELSE 1 END,
                   created_at ASC
          LIMIT 1`,
        params
      );
      if (!r.rows.length) return res.json({ ok: true, lead: null });
      const lead = r.rows[0];
      lead.search_url = lead.profile_url || searchUrl(lead.name, lead.company);
      res.json({ ok: true, lead });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Stats ──────────────────────────────────────────────────── */
  router.get('/stats', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const settings = await getSettings();
      const usage = await capUsage();
      const byStatus = await q(`SELECT status, COUNT(*)::int AS n FROM linkedin_leads GROUP BY status`);
      const counts = { draft_ready: 0, approved: 0, sent: 0, replied: 0, skipped: 0, total: 0 };
      for (const row of byStatus.rows) { counts[row.status] = row.n; counts.total += row.n; }

      const backlog = counts.draft_ready + counts.approved;
      /* Naive ETA: remaining sendable / weekly send capacity (both channels). */
      const weeklyCapacity = (settings.inmail_daily_cap * 5) + Math.min(settings.note_daily_cap * 5, settings.note_weekly_cap);
      const etaWeeks = weeklyCapacity > 0 ? Math.ceil(backlog / weeklyCapacity) : null;

      res.json({
        ok: true,
        counts,
        backlog,
        eta_weeks: etaWeeks,
        weekly_capacity: weeklyCapacity,
        caps: {
          inmail: { cap: settings.inmail_daily_cap, used_today: usage.inmail.today, used_month: usage.inmail.month },
          note: { daily_cap: settings.note_daily_cap, used_today: usage.note.today, weekly_cap: settings.note_weekly_cap, used_week: usage.note.week }
        }
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Templates ──────────────────────────────────────────────── */
  router.get('/templates', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const r = await q(`SELECT channel, body, updated_at FROM linkedin_templates ORDER BY channel`);
      res.json({ ok: true, templates: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/templates', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const channel = String((req.body && req.body.channel) || '');
      const body = String((req.body && req.body.body) || '');
      if (!['inmail','note'].includes(channel)) return res.status(400).json({ error: 'channel must be inmail|note' });
      if (!body.trim()) return res.status(400).json({ error: 'body required' });
      const r = await q(
        `INSERT INTO linkedin_templates (channel, body) VALUES ($1, $2)
         ON CONFLICT (channel) DO UPDATE SET body = EXCLUDED.body, updated_at = NOW()
         RETURNING channel, body, updated_at`,
        [channel, body.slice(0, 4000)]
      );
      res.json({ ok: true, template: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Settings ───────────────────────────────────────────────── */
  router.get('/settings', async (req, res) => {
    if (!guardPool(res)) return;
    try { res.json({ ok: true, settings: await getSettings() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/settings', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const b = req.body || {};
      const clampInt = (v, def, min, max) => {
        const n = parseInt(v, 10);
        if (isNaN(n)) return def;
        return Math.min(max, Math.max(min, n));
      };
      const cur = await getSettings();
      const inmail = clampInt(b.inmail_daily_cap, cur.inmail_daily_cap, 0, 200);
      const noteDaily = clampInt(b.note_daily_cap, cur.note_daily_cap, 0, 1000);
      const noteWeekly = clampInt(b.note_weekly_cap, cur.note_weekly_cap, 0, 5000);
      const onepager = (b.onepager_url != null) ? String(b.onepager_url).trim().slice(0, 500) : cur.onepager_url;
      const r = await q(
        `UPDATE linkedin_settings
            SET inmail_daily_cap = $1, note_daily_cap = $2, note_weekly_cap = $3, onepager_url = $4, updated_at = NOW()
          WHERE id = 1
          RETURNING id, inmail_daily_cap, note_daily_cap, note_weekly_cap, onepager_url`,
        [inmail, noteDaily, noteWeekly, onepager]
      );
      res.json({ ok: true, settings: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Edit a lead (manual override) ──────────────────────────── */
  router.patch('/leads/:id', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const id = String(req.params.id || '');
      const fields = req.body || {};
      const cur = await q(`SELECT * FROM linkedin_leads WHERE id = $1`, [id]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
      const lead = cur.rows[0];

      let tier = lead.tier, channel = lead.channel;
      let companyUpdate = lead.company_update, outreachDraft = lead.outreach_draft;
      let profileUrl = lead.profile_url;
      let firstName = lead.first_name;
      let firstNameChanged = false;
      let tierChanged = false;

      if (fields.tier && ['top','standard'].includes(fields.tier) && fields.tier !== tier) {
        tier = fields.tier; channel = channelForTier(tier); tierChanged = true;
      }
      if (fields.channel && ['inmail','note'].includes(fields.channel)) {
        channel = fields.channel; // explicit channel override wins
      }
      if ('company_update' in fields) companyUpdate = String(fields.company_update || '').slice(0, 500);
      if ('profile_url' in fields) profileUrl = String(fields.profile_url || '').trim().slice(0, 500) || null;
      /* The person found via LinkedIn search — sets the [Name] token. */
      if ('first_name' in fields) {
        firstName = String(fields.first_name || '').trim().slice(0, 80) || null;
        firstNameChanged = true;
      }

      /* If a draft-affecting field changed and the user didn't hand us an
         explicit draft, re-render from the matching template. */
      if ('outreach_draft' in fields) {
        outreachDraft = String(fields.outreach_draft || '').slice(0, 4000);
      } else if (tierChanged || firstNameChanged || ('company_update' in fields) || (fields.channel && fields.channel !== lead.channel)) {
        const tpl = await getTemplates();
        outreachDraft = renderDraft(tpl[channel], firstName, companyUpdate);
      }

      const r = await q(
        `UPDATE linkedin_leads
            SET tier = $1, channel = $2, company_update = $3, outreach_draft = $4, profile_url = $5, first_name = $6, updated_at = NOW()
          WHERE id = $7 RETURNING *`,
        [tier, channel, companyUpdate, outreachDraft, profileUrl, firstName, id]
      );
      res.json({ ok: true, lead: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Status transitions ─────────────────────────────────────── */
  function statusEndpoint(path, sql) {
    router.post('/leads/:id/' + path, async (req, res) => {
      if (!guardPool(res)) return;
      try {
        const r = await q(sql + ' WHERE id = $1 RETURNING *', [String(req.params.id)]);
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true, lead: r.rows[0] });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }
  statusEndpoint('approve', `UPDATE linkedin_leads SET status = 'approved', updated_at = NOW()`);
  statusEndpoint('skip',    `UPDATE linkedin_leads SET status = 'skipped', updated_at = NOW()`);
  statusEndpoint('sent',    `UPDATE linkedin_leads SET status = 'sent', sent_at = NOW(), updated_at = NOW()`);

  /* ─── Delete a single lead ───────────────────────────────────── */
  router.delete('/leads/:id', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const r = await q(`DELETE FROM linkedin_leads WHERE id = $1 RETURNING id`, [String(req.params.id)]);
      if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true, deleted: 1 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Purge (bulk delete) — by source_file, or everything ─────────
     Guarded: require explicit ?confirm=1 to wipe everything, so a stray
     call can't nuke the whole queue. Mainly for cleaning up test imports. */
  router.post('/purge', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const sourceFile = String((req.body && req.body.source_file) || '').trim();
      if (sourceFile) {
        const r = await q(`DELETE FROM linkedin_leads WHERE source_file = $1`, [sourceFile]);
        return res.json({ ok: true, deleted: r.rowCount || 0, scope: 'source_file:' + sourceFile });
      }
      if (String((req.body && req.body.confirm) || '') !== '1') {
        return res.status(400).json({ error: 'Pass { source_file } to target an import, or { confirm: "1" } to wipe ALL leads' });
      }
      const r = await q(`DELETE FROM linkedin_leads`);
      res.json({ ok: true, deleted: r.rowCount || 0, scope: 'all' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Regenerate drafts from current template ────────────────── */
  router.post('/leads/:id/regenerate', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const tpl = await getTemplates();
      const cur = await q(`SELECT * FROM linkedin_leads WHERE id = $1`, [String(req.params.id)]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
      const lead = cur.rows[0];
      const draft = renderDraft(tpl[lead.channel], lead.first_name, lead.company_update);
      const r = await q(`UPDATE linkedin_leads SET outreach_draft = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [draft, lead.id]);
      res.json({ ok: true, lead: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/regenerate-all', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const tpl = await getTemplates();
      /* Only re-render leads we haven't acted on yet (draft_ready), so we
         never clobber an approved/edited draft. Done set-based per channel. */
      let updated = 0;
      for (const channel of ['inmail','note']) {
        const r = await q(
          `UPDATE linkedin_leads
              SET outreach_draft = replace(
                    replace($1, '[Name]', COALESCE(first_name, '[Name]')),
                    '[COMPANY_UPDATE]',
                    CASE WHEN COALESCE(company_update,'') = '' THEN '' ELSE ' ' || company_update END
                  ),
                  updated_at = NOW()
            WHERE channel = $2 AND status = 'draft_ready'`,
          [tpl[channel], channel]
        );
        updated += r.rowCount || 0;
      }
      res.json({ ok: true, updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /* ─── Reply drafting (positive → demo link; question → answer) ─ */
  router.post('/leads/:id/reply', async (req, res) => {
    if (!guardPool(res)) return;
    try {
      const id = String(req.params.id || '');
      const inbound = String((req.body && req.body.inbound) || '').trim();
      if (!inbound) return res.status(400).json({ error: 'inbound message required' });

      const cur = await q(`SELECT * FROM linkedin_leads WHERE id = $1`, [id]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
      const lead = cur.rows[0];
      const settings = await getSettings();

      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({ error: 'OPENAI_API_KEY missing on Admin-Dashboard service' });
      }

      const onepager = settings.onepager_url || '';
      const systemPrompt =
`You draft a short, warm LinkedIn reply on behalf of the founder of October AI.

PRODUCT (ground every claim in this — never invent features):
${PRODUCT_BRIEF}

The reply is to a prospect who already received a cold outreach message and
has now responded. Read their inbound message and choose:
  • If they are POSITIVE / interested / say yes to a demo → thank them briefly
    and share the demo link: ${onepager || '(no demo link configured — say you will follow up with details)'}.
  • If they ask a QUESTION → answer it concisely and accurately from the PRODUCT
    description above, then offer the demo.
  • If they decline or are not interested → reply graciously, no pressure, leave
    the door open.

Rules:
  • Match the founder's tone: friendly, direct, lower-case-friendly, no corporate fluff.
  • Keep it short (2-5 sentences). No subject line — this is a LinkedIn DM.
  • Mirror the prospect's language (Danish or English).
  • Output ONLY the reply text — no preamble, no quotes, no markdown.`;

      const userPrompt =
`Lead: ${lead.name}${lead.company ? ' (' + lead.company + ')' : ''}
The outreach we sent them:
"""${(lead.outreach_draft || '').slice(0, 1500)}"""

Their inbound reply:
"""${inbound.slice(0, 1500)}"""

Write the founder's reply.`;

      let replyDraft = '';
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            max_tokens: 400,
            temperature: 0.6
          }),
          signal: AbortSignal.timeout(25000)
        });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          return res.status(502).json({ error: 'OpenAI error ' + r.status + ': ' + t.slice(0, 200) });
        }
        const data = await r.json();
        replyDraft = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
      } catch (e) {
        return res.status(502).json({ error: 'OpenAI call failed: ' + e.message });
      }
      if (!replyDraft) return res.status(502).json({ error: 'OpenAI returned no draft' });

      const upd = await q(
        `UPDATE linkedin_leads
            SET reply_text = $1, reply_draft = $2, reply_status = 'drafted',
                status = 'replied', replied_at = NOW(), updated_at = NOW()
          WHERE id = $3 RETURNING *`,
        [inbound.slice(0, 4000), replyDraft.slice(0, 4000), id]
      );
      res.json({ ok: true, lead: upd.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
