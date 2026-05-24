/* services/gmailSync.js — CRM Gmail-inbox sync.
 * ──────────────────────────────────────────────────────────────────
 * Daily job that pulls the last N days of email from
 *   imap.gmail.com:993  (TLS, port allowed on Railway — unlike SMTP)
 * using the existing GMAIL_USER + GMAIL_APP_PASSWORD env vars.
 *
 * Reads two folders:
 *   · INBOX         — inbound replies / cold inbound / fwd's
 *   · [Gmail]/Sent Mail — outbound from us
 *
 * For each new message:
 *   1. dedup via Message-ID (UNIQUE in crm_emails)
 *   2. resolve "the other party" address — for inbound: From; for
 *      outbound: To. Multiple To addresses → first one wins (heuristic
 *      since CRM is per-company, not per-thread).
 *   3. find-or-create a crm_contacts row by lowercased other-party
 *      address (auto-seeded category 'other'; LLM may re-categorise).
 *   4. INSERT into crm_emails (body trimmed to 6kB, hashed for clustering).
 *   5. update crm_contacts.last_email_at / subject / direction.
 *
 * Categorisation happens in a second pass after import:
 *   · email-domain match against affiliates.email → 'affiliate'
 *   · email-domain match against users.email (role='customer') → 'customer_service'
 *   · everything else → LLM-decide (Haiku 4.5) on first encounter
 *
 * Runs every 24h via node-cron in server.js. Also exposes runSync()
 * for the manual-trigger endpoint /api/crm/sync.
 * ────────────────────────────────────────────────────────────────── */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const crypto = require('crypto');

const LOOKBACK_DAYS = parseInt(process.env.CRM_LOOKBACK_DAYS || '180', 10); // ~6 months
const BODY_MAX_KB = 6;
const MY_DOMAIN = 'october-ai.com';

/* ── helpers ───────────────────────────────────────────────────── */

function sha256Short(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 32);
}

function extractAddr(rawAddrField) {
  /* mailparser returns { value: [{address, name}, ...], text } */
  if (!rawAddrField) return null;
  if (Array.isArray(rawAddrField.value) && rawAddrField.value.length) {
    return String(rawAddrField.value[0].address || '').toLowerCase().trim() || null;
  }
  return null;
}

function normaliseBody(text) {
  if (!text) return '';
  /* Strip quoted reply, signature lines, and excessive whitespace
     to improve template-cluster hashing. */
  let body = String(text);
  body = body.split(/\n[>|]/)[0];                   // crude quote-strip
  body = body.replace(/[\r\n]+/g, '\n');
  body = body.replace(/\s+/g, ' ').trim();
  return body.slice(0, BODY_MAX_KB * 1024);
}

function isOutboundFrom(addr) {
  if (!addr) return false;
  return addr.toLowerCase().endsWith('@' + MY_DOMAIN);
}

/* ── DB upserts ────────────────────────────────────────────────── */

async function findOrCreateContact(pool, email, brief, source) {
  if (!email) return null;
  const lower = email.toLowerCase();
  const existing = await pool.query(
    'SELECT id, category, llm_categorised FROM crm_contacts WHERE LOWER(email) = $1 LIMIT 1',
    [lower]
  );
  if (existing.rows.length) return existing.rows[0];

  const inserted = await pool.query(
    `INSERT INTO crm_contacts (email, brief, source, category)
     VALUES ($1, $2, $3, 'other')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, category, llm_categorised`,
    [lower, brief || null, source || 'gmail-inbound']
  );
  return inserted.rows[0];
}

async function insertEmail(pool, parsed, direction, contactId) {
  const messageId = parsed.messageId || ('gmail-' + sha256Short(
    (parsed.subject || '') + (parsed.date || '') + (parsed.from?.text || '')
  ));
  const fromAddr = extractAddr(parsed.from);
  const toAddr   = extractAddr(parsed.to);
  const subject  = (parsed.subject || '').slice(0, 500);
  const bodyText = normaliseBody(parsed.text || parsed.html || '');
  const bodyHash = bodyText ? sha256Short(bodyText.toLowerCase().slice(0, 1500)) : null;
  const sentAt   = parsed.date || new Date();

  const result = await pool.query(
    `INSERT INTO crm_emails
      (contact_id, message_id, direction, from_addr, to_addr, subject, body_text, body_hash, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING id`,
    [contactId, messageId, direction, fromAddr, toAddr, subject, bodyText, bodyHash, sentAt]
  );
  return result.rowCount > 0; /* true = newly inserted, false = dup */
}

async function updateContactLastEmail(pool, contactId, parsed, direction) {
  if (!contactId) return;
  const subject = (parsed.subject || '').slice(0, 500);
  const sentAt = parsed.date || new Date();
  await pool.query(
    `UPDATE crm_contacts
       SET last_email_at        = GREATEST(COALESCE(last_email_at, '1970-01-01'::timestamptz), $1),
           last_email_subject   = CASE WHEN $1 >= COALESCE(last_email_at, '1970-01-01'::timestamptz) THEN $2 ELSE last_email_subject END,
           last_email_direction = CASE WHEN $1 >= COALESCE(last_email_at, '1970-01-01'::timestamptz) THEN $3 ELSE last_email_direction END,
           updated_at           = NOW()
     WHERE id = $4`,
    [sentAt, subject, direction, contactId]
  );
}

/* ── IMAP fetch ────────────────────────────────────────────────── */

async function fetchFolder(client, folderName, sinceDate) {
  const messages = [];
  await client.mailboxOpen(folderName, { readOnly: true });
  for await (const msg of client.fetch(
    { since: sinceDate },
    { source: true, envelope: true, uid: true }
  )) {
    try {
      const parsed = await simpleParser(msg.source);
      messages.push(parsed);
    } catch (e) {
      console.warn('[gmailSync] parse error in', folderName, ':', e.message);
    }
  }
  return messages;
}

/* ── auto-categorisation (cheap match first, LLM fallback) ─────── */

async function categoriseExistingContacts(pool) {
  /* Step 1 — affiliate match. Anyone whose email exists in `affiliates`
     gets bumped to 'affiliate' (only if currently 'other'). */
  await pool.query(`
    UPDATE crm_contacts c
       SET category = 'affiliate', updated_at = NOW()
     WHERE c.category = 'other'
       AND EXISTS (
         SELECT 1 FROM affiliates a WHERE LOWER(a.email) = LOWER(c.email)
       )
  `);

  /* Step 2 — customer match. Any contact email that matches a
     real customer in users (role='customer') gets 'customer_service'. */
  await pool.query(`
    UPDATE crm_contacts c
       SET category = 'customer_service', updated_at = NOW()
     WHERE c.category = 'other'
       AND EXISTS (
         SELECT 1 FROM users u
          WHERE LOWER(u.email) = LOWER(c.email)
            AND u.role = 'customer'
       )
  `);
}

async function categoriseWithLLM(pool, limit = 25) {
  /* Re-categorise contacts that are still 'other' and not yet
     llm-categorised — uses Haiku 4.5 for cheap classification.
     Skipped silently if ANTHROPIC_API_KEY missing. */
  if (!process.env.ANTHROPIC_API_KEY) return 0;

  const candidates = await pool.query(
    `SELECT c.id, c.email, c.company, c.brief,
            (SELECT string_agg(LEFT(e.subject, 80), ' || ' ORDER BY e.sent_at DESC)
               FROM crm_emails e
              WHERE e.contact_id = c.id LIMIT 5) AS recent_subjects
       FROM crm_contacts c
      WHERE c.category = 'other'
        AND c.llm_categorised = false
        AND (
          EXISTS (SELECT 1 FROM crm_emails e WHERE e.contact_id = c.id)
          OR c.brief IS NOT NULL
        )
      ORDER BY c.updated_at DESC
      LIMIT $1`,
    [limit]
  );
  if (!candidates.rows.length) return 0;

  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk'); }
  catch (e) { return 0; }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let categorised = 0;
  for (const row of candidates.rows) {
    const userPrompt =
`Classify this contact into exactly one category. Output ONLY the category key — no other text.

Categories:
  - affiliate          : Partners, resellers, agencies, referral programs
  - customer_service   : Existing paying customers asking for help
  - other              : Leads, prospects, vendors, recruiters, journalists, anything else

Contact:
  Email: ${row.email}
  Company: ${row.company || '(unknown)'}
  Brief: ${row.brief || '(none)'}
  Recent email subjects: ${row.recent_subjects || '(none)'}

Output one of: affiliate | customer_service | other`;

    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 12,
        messages: [{ role: 'user', content: userPrompt }]
      });
      const decision = (resp.content?.[0]?.text || '').trim().toLowerCase();
      const valid = ['affiliate', 'customer_service', 'other'].includes(decision) ? decision : 'other';

      await pool.query(
        `UPDATE crm_contacts
            SET category = $1, llm_categorised = true, updated_at = NOW()
          WHERE id = $2`,
        [valid, row.id]
      );
      categorised++;
    } catch (e) {
      console.warn('[gmailSync] LLM categorise error for', row.email, ':', e.message);
      await pool.query(
        `UPDATE crm_contacts SET llm_categorised = true WHERE id = $1`, [row.id]
      );
    }
  }
  return categorised;
}

/* ── seed: copy known affiliates + customers in on first run ─── */

async function seedFromExistingTables(pool) {
  /* Idempotent — ON CONFLICT (email) DO NOTHING means re-running is safe. */
  await pool.query(`
    INSERT INTO crm_contacts (company, contact_person, email, phone, category, source, status)
    SELECT
      COALESCE(NULLIF(TRIM(a.business_name), ''), NULLIF(TRIM(a.full_name), '')) AS company,
      a.full_name AS contact_person,
      LOWER(a.email)  AS email,
      a.phone,
      'affiliate'     AS category,
      'seed-affiliate' AS source,
      'active'        AS status
    FROM affiliates a
    WHERE a.email IS NOT NULL
    ON CONFLICT (email) DO NOTHING
  `).catch(() => {}); /* affiliates table or columns might not exist on fresh DB */

  await pool.query(`
    INSERT INTO crm_contacts (company, contact_person, email, category, source, status)
    SELECT
      NULL,
      COALESCE(u.full_name, u.email) AS contact_person,
      LOWER(u.email) AS email,
      'customer_service' AS category,
      'seed-user' AS source,
      'active' AS status
    FROM users u
    WHERE u.role = 'customer'
      AND u.email IS NOT NULL
    ON CONFLICT (email) DO NOTHING
  `).catch(() => {});
}

/* ── main entrypoint ─────────────────────────────────────────── */

async function runSync(pool) {
  if (!pool) throw new Error('No DB pool');
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('Gmail credentials missing (GMAIL_USER, GMAIL_APP_PASSWORD)');
  }

  const runRow = await pool.query(
    `INSERT INTO crm_sync_runs (status) VALUES ('running') RETURNING id`
  );
  const runId = runRow.rows[0].id;

  let imported = 0;
  let contactsBefore = 0;
  try {
    const cb = await pool.query('SELECT COUNT(*) AS n FROM crm_contacts');
    contactsBefore = parseInt(cb.rows[0].n || 0, 10);
  } catch (e) {}

  try {
    await seedFromExistingTables(pool);

    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000);
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      logger: false
    });
    await client.connect();

    /* INBOX — inbound */
    const inbound = await fetchFolder(client, 'INBOX', since);
    for (const msg of inbound) {
      const fromAddr = extractAddr(msg.from);
      if (!fromAddr || isOutboundFrom(fromAddr)) continue; /* skip self-sent in inbox */
      const contact = await findOrCreateContact(pool, fromAddr, null, 'gmail-inbound');
      const wasNew = await insertEmail(pool, msg, 'inbound', contact?.id);
      if (wasNew) imported++;
      if (contact?.id) await updateContactLastEmail(pool, contact.id, msg, 'inbound');
    }

    /* Sent Mail — outbound. Gmail folder is localised ("[Gmail]/Sent Mail"). */
    let outbound = [];
    try {
      outbound = await fetchFolder(client, '[Gmail]/Sent Mail', since);
    } catch (e) {
      try { outbound = await fetchFolder(client, '[Google Mail]/Sent Mail', since); }
      catch (e2) { console.warn('[gmailSync] cannot open Sent folder:', e2.message); }
    }
    for (const msg of outbound) {
      const toAddr = extractAddr(msg.to);
      if (!toAddr || isOutboundFrom(toAddr)) continue;
      const contact = await findOrCreateContact(pool, toAddr, null, 'gmail-outbound');
      const wasNew = await insertEmail(pool, msg, 'outbound', contact?.id);
      if (wasNew) imported++;
      if (contact?.id) await updateContactLastEmail(pool, contact.id, msg, 'outbound');
    }

    await client.logout();

    /* Categorise */
    await categoriseExistingContacts(pool);
    await categoriseWithLLM(pool, 25);

    const ca = await pool.query('SELECT COUNT(*) AS n FROM crm_contacts');
    const contactsAfter = parseInt(ca.rows[0].n || 0, 10);

    await pool.query(
      `UPDATE crm_sync_runs
          SET status = 'ok', finished_at = NOW(),
              emails_imported = $1, contacts_new = $2
        WHERE id = $3`,
      [imported, Math.max(0, contactsAfter - contactsBefore), runId]
    );

    return { ok: true, imported, contactsNew: Math.max(0, contactsAfter - contactsBefore) };
  } catch (e) {
    console.error('[gmailSync] FAIL:', e);
    await pool.query(
      `UPDATE crm_sync_runs SET status='failed', finished_at=NOW(), error_message=$1 WHERE id=$2`,
      [String(e.message || e).slice(0, 1000), runId]
    ).catch(() => {});
    throw e;
  }
}

/* ── template-detection: cluster outbound emails by body_hash ── */

async function refreshTemplateClusters(pool) {
  /* Find body_hash groups with 3+ outbound emails over the last 90d
     — these are recurring patterns we can surface as templates. */
  const rows = await pool.query(`
    SELECT body_hash, COUNT(*) AS uses,
           MIN(subject) AS sample_subject,
           (SELECT body_text FROM crm_emails e2
             WHERE e2.body_hash = e.body_hash AND e2.direction = 'outbound'
             ORDER BY e2.sent_at DESC LIMIT 1) AS sample_body
      FROM crm_emails e
     WHERE e.direction = 'outbound'
       AND e.body_hash IS NOT NULL
       AND e.sent_at > NOW() - INTERVAL '90 days'
     GROUP BY body_hash
    HAVING COUNT(*) >= 3
     ORDER BY uses DESC
     LIMIT 25
  `);
  for (const r of rows.rows) {
    await pool.query(
      `INSERT INTO crm_templates (name, subject, body_text, usage_count, auto_detected, cluster_key)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT DO NOTHING`, /* no UNIQUE on cluster_key so we use a separate check */
      [
        (r.sample_subject || 'Recurring template').slice(0, 80),
        (r.sample_subject || '').slice(0, 500),
        (r.sample_body || '').slice(0, 6000),
        parseInt(r.uses, 10),
        r.body_hash
      ]
    ).catch(() => {});
    /* Update usage count if it already exists for this cluster_key. */
    await pool.query(
      `UPDATE crm_templates SET usage_count = $1, updated_at = NOW()
        WHERE cluster_key = $2 AND auto_detected = true`,
      [parseInt(r.uses, 10), r.body_hash]
    ).catch(() => {});
  }
}

module.exports = {
  runSync,
  seedFromExistingTables,
  categoriseExistingContacts,
  categoriseWithLLM,
  refreshTemplateClusters
};
