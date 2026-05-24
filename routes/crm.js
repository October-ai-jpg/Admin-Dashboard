/* routes/crm.js — Admin-Dashboard CRM.
 * ──────────────────────────────────────────────────────────────────
 * Lightweight per-founder CRM. All endpoints require requireAuth
 * (x-admin-token), mounted at /api/crm.
 *
 * Endpoints:
 *   GET    /api/crm/contacts            list + filter (?category=, ?q=)
 *   GET    /api/crm/contacts/:id        full detail + last 50 emails
 *   POST   /api/crm/contacts            manual create
 *   PATCH  /api/crm/contacts/:id        update fields (incl. category override)
 *   DELETE /api/crm/contacts/:id        soft delete (status='lost')
 *   GET    /api/crm/templates           list templates
 *   POST   /api/crm/templates           save a template
 *   DELETE /api/crm/templates/:id       delete
 *   POST   /api/crm/sync                manual trigger (background, returns immediately)
 *   GET    /api/crm/sync/status         last run info
 *
 * Categorisation auto-runs after each Gmail sync. To force re-categorise
 * a single contact, PATCH with {category: 'affiliate' | …}.
 * ────────────────────────────────────────────────────────────────── */

const express = require('express');
const multer = require('multer');
const gmailSync = require('../services/gmailSync');

/* In-memory upload for screenshot-to-contact. 8 MB cap covers any
   reasonable phone screenshot or business card photo. Only image
   mime-types accepted — anything else is rejected at multer level. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype || '')) {
      return cb(new Error('Only image uploads accepted'));
    }
    cb(null, true);
  }
});

module.exports = function (pool) {
  const router = express.Router();

  async function q(sql, params) {
    if (!pool) return { rows: [] };
    try { return await pool.query(sql, params || []); }
    catch (e) { console.error('[crm] DB error:', e.message); throw e; }
  }

  /* ─── Contacts ───────────────────────────────────────────────── */

  router.get('/contacts', async (req, res) => {
    try {
      const category = String(req.query.category || '').toLowerCase();
      const search = String(req.query.q || '').trim().toLowerCase();
      const includeNoise = String(req.query.include_noise || '') === '1';
      const onlyNoise = String(req.query.only_noise || '') === '1';
      const validCats = ['affiliate', 'customer_service', 'other'];

      const where = [];
      const params = [];
      if (validCats.includes(category)) {
        params.push(category);
        where.push('category = $' + params.length);
      }
      if (search) {
        params.push('%' + search + '%');
        const p = '$' + params.length;
        where.push(`(LOWER(email) LIKE ${p} OR LOWER(COALESCE(company, '')) LIKE ${p} OR LOWER(COALESCE(contact_person, '')) LIKE ${p})`);
      }
      /* Noise filter: by default hide status='lost' (which the
         noise-classifier sets). ?include_noise=1 shows everything,
         ?only_noise=1 shows only noise — useful for "Show noise" view. */
      if (onlyNoise) {
        where.push(`status = 'lost'`);
      } else if (!includeNoise) {
        where.push(`status != 'lost'`);
      }

      const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
      const rows = await q(
        `SELECT id, company, contact_person, email, phone, brief, status, category,
                last_email_at, last_email_subject, last_email_direction,
                /* Total calendar days, not interval-day-component. Cast
                   to date so months/years are flattened to a real day count. */
                CASE WHEN last_email_at IS NOT NULL
                     THEN (NOW()::date - last_email_at::date) END AS days_since_last_email,
                created_at, updated_at
           FROM crm_contacts
           ${whereSql}
           ORDER BY COALESCE(last_email_at, created_at) DESC NULLS LAST
           LIMIT 500`,
        params
      );

      /* Per-category counts — excludes noise (status='lost') by
         default so tab badges reflect what the user actually sees.
         Also returns a separate `noise` total so the "Show noise"
         toggle can show how many are hidden. */
      const countsExclNoise = await q(
        `SELECT category, COUNT(*) AS n
           FROM crm_contacts WHERE status != 'lost'
          GROUP BY category`
      );
      const noiseTotal = await q(
        `SELECT COUNT(*) AS n FROM crm_contacts WHERE status = 'lost'`
      );
      const countMap = { affiliate: 0, customer_service: 0, other: 0, total: 0, noise: 0 };
      for (const r of countsExclNoise.rows) {
        countMap[r.category] = parseInt(r.n, 10);
        countMap.total += parseInt(r.n, 10);
      }
      countMap.noise = parseInt(noiseTotal.rows[0]?.n || 0, 10);

      res.json({ ok: true, contacts: rows.rows, counts: countMap });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* On-demand: re-run the noise classifier across all contacts.
     Use after deploying new noise patterns. Soft — won't demote
     contacts the user has manually edited. */
  router.post('/cleanup-noise', async (req, res) => {
    try {
      const flagged = await gmailSync.classifyNoiseExisting(pool);
      res.json({ ok: true, flagged });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/contacts/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const c = await q(
        `SELECT id, company, contact_person, email, phone, brief, status, category,
                owner_notes, source, last_email_at, last_email_subject, last_email_direction,
                llm_categorised, created_at, updated_at
           FROM crm_contacts WHERE id = $1`,
        [id]
      );
      if (!c.rows.length) return res.status(404).json({ error: 'Not found' });

      const emails = await q(
        `SELECT id, direction, from_addr, to_addr, subject,
                LEFT(body_text, 800) AS body_preview, sent_at
           FROM crm_emails WHERE contact_id = $1
           ORDER BY sent_at DESC LIMIT 50`,
        [id]
      );

      res.json({ ok: true, contact: c.rows[0], emails: emails.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/contacts', async (req, res) => {
    try {
      const { company, contact_person, email, phone, brief, category, owner_notes, status } = req.body || {};
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
        return res.status(400).json({ error: 'Valid email required' });
      }
      const cat = ['affiliate', 'customer_service', 'other'].includes(category) ? category : 'other';
      const st = ['new','active','dormant','lost','converted'].includes(status) ? status : 'new';

      const row = await q(
        `INSERT INTO crm_contacts (company, contact_person, email, phone, brief, category, owner_notes, status, source)
         VALUES ($1, $2, LOWER($3), $4, $5, $6, $7, $8, 'manual')
         ON CONFLICT (email) DO UPDATE SET
           company        = COALESCE(EXCLUDED.company, crm_contacts.company),
           contact_person = COALESCE(EXCLUDED.contact_person, crm_contacts.contact_person),
           phone          = COALESCE(EXCLUDED.phone, crm_contacts.phone),
           brief          = COALESCE(EXCLUDED.brief, crm_contacts.brief),
           owner_notes    = COALESCE(EXCLUDED.owner_notes, crm_contacts.owner_notes),
           updated_at     = NOW()
         RETURNING *`,
        [company || null, contact_person || null, String(email), phone || null,
         brief || null, cat, owner_notes || null, st]
      );
      res.json({ ok: true, contact: row.rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.patch('/contacts/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const fields = req.body || {};
      const set = [];
      const params = [];
      const allowed = ['company','contact_person','phone','brief','status','category','owner_notes'];
      let categoryEdited = false;
      for (const k of allowed) {
        if (k in fields) {
          if (k === 'category' && !['affiliate','customer_service','other'].includes(fields[k])) continue;
          if (k === 'status'   && !['new','active','dormant','lost','converted'].includes(fields[k])) continue;
          params.push(fields[k]);
          set.push(k + ' = $' + params.length);
          if (k === 'category') categoryEdited = true;
        }
      }
      if (!set.length) return res.status(400).json({ error: 'No valid fields' });
      /* Manual category edit also flips llm_categorised=true so the
         next sync's LLM-recategorise loop leaves this row alone. */
      if (categoryEdited) set.push('llm_categorised = true');
      set.push('updated_at = NOW()');
      params.push(id);
      const row = await q(
        `UPDATE crm_contacts SET ${set.join(', ')}
          WHERE id = $${params.length}
          RETURNING *`,
        params
      );
      if (!row.rows.length) return res.status(404).json({ error: 'Not found' });
      res.json({ ok: true, contact: row.rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/contacts/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      await q(`UPDATE crm_contacts SET status = 'lost', updated_at = NOW() WHERE id = $1`, [id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ─── Screenshot → contact (vision extract) ───────────────────
     Founder drops/pastes a screenshot of an email signature, LinkedIn
     profile, business card, or any contact-info image. Claude Haiku
     4.5 (vision) extracts company / name / email / phone / brief and
     a category hint. We then upsert the contact and return it so the
     UI can open the drawer for review.

     Robustness:
       · 8MB cap, image-mime-type whitelist via multer
       · Strict JSON parsing — strips markdown fences, retries with
         a stricter prompt if first parse fails
       · No-API-key → 503 with a clear message (Anthropic key may be
         missing on this Railway service)
       · If extraction returns no email → 422 with what we DID see,
         so the user can edit manually
       · Always returns the structured extraction even if the upsert
         fails, so the founder doesn't lose the parsed data
   */
  router.post('/contacts/from-image', upload.single('image'), async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'No image uploaded (field name: image)' });
      }
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({
          error: 'Vision extraction unavailable: ANTHROPIC_API_KEY missing on Admin-Dashboard service'
        });
      }

      let Anthropic;
      try { Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk'); }
      catch (e) { return res.status(503).json({ error: 'Anthropic SDK unavailable: ' + e.message }); }
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const mediaType = req.file.mimetype || 'image/png';
      const base64 = req.file.buffer.toString('base64');

      const systemPrompt =
`You extract contact information from a screenshot.
The image may show: an email signature, a LinkedIn profile, a business
card, a Stripe / payment confirmation, a Calendly booking confirmation,
a CRM card, a website "Contact" section — anything with contact data.

Return ONLY a single JSON object with these exact keys (no markdown
fences, no commentary). Use null for any field you cannot reliably
read. Do not invent values:

{
  "company": string | null,
  "contact_person": string | null,
  "email": string | null,
  "phone": string | null,
  "brief": string | null,
  "category_hint": "affiliate" | "customer_service" | "other"
}

Rules:
- email: lowercase, single valid address. If multiple, pick the
  primary one (work email > personal).
- phone: keep the user's formatting (+45 12 34 56 78). Strip "tel:" prefix.
  If multiple, pick the work / direct number.
- brief: 1-2 short sentences (≤200 chars) describing who they are,
  factual only. No marketing language. Example: "Real-estate photographer
  in Aarhus, runs DronesByTheBay. Found us via Matterport partner page."
- category_hint:
    "affiliate"        — partner, reseller, agency, referral marketer
    "customer_service" — existing paying customer needing help
    "other"            — lead, prospect, vendor, journalist, anything else
  Default to "other" if uncertain.
- If the image contains NO usable contact info, return all-null fields
  with category_hint="other". Don't refuse.`;

      async function callClaude(extraStrictness) {
        const resp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          system: systemPrompt + (extraStrictness ? '\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY the JSON object — no prose, no markdown fences, no leading/trailing characters.' : ''),
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              { type: 'text', text: 'Extract the contact info from this screenshot. Return only the JSON object.' }
            ]
          }]
        });
        return (resp.content?.[0]?.text || '').trim();
      }

      function tryParse(raw) {
        if (!raw) return null;
        /* Strip markdown fences ```json ... ``` if Claude added them. */
        let cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        /* If there's prose before/after, snip out the JSON object. */
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
        try { return JSON.parse(cleaned); }
        catch (e) { return null; }
      }

      let parsed = null;
      try {
        parsed = tryParse(await callClaude(false));
        if (!parsed) parsed = tryParse(await callClaude(true));
      } catch (e) {
        return res.status(502).json({ error: 'Vision call failed: ' + e.message });
      }

      if (!parsed) {
        return res.status(502).json({ error: 'Could not parse a structured response from Claude' });
      }

      /* Sanitise extracted fields. */
      const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 200) : null) || null;
      const email = clean(parsed.email, 200);
      const emailLower = email ? email.toLowerCase() : null;
      const validEmail = emailLower && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower);
      const company   = clean(parsed.company, 200);
      const person    = clean(parsed.contact_person, 120);
      const phone     = clean(parsed.phone, 40);
      const brief     = clean(parsed.brief, 400);
      const catHint   = ['affiliate','customer_service','other'].includes(parsed.category_hint)
        ? parsed.category_hint : 'other';

      if (!validEmail) {
        /* No usable email — return the extraction so the user can edit
           the form manually instead of losing the parsed data. */
        return res.status(422).json({
          error: 'No valid email detected in the image',
          extracted: { company, contact_person: person, email: emailLower, phone, brief, category_hint: catHint }
        });
      }

      /* Upsert contact (insert OR back-fill fields on existing rows). */
      const row = await pool.query(
        `INSERT INTO crm_contacts
           (company, contact_person, email, phone, brief, category, status, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'new', 'screenshot-upload')
         ON CONFLICT (email) DO UPDATE SET
           company        = COALESCE(crm_contacts.company,        EXCLUDED.company),
           contact_person = COALESCE(crm_contacts.contact_person, EXCLUDED.contact_person),
           phone          = COALESCE(crm_contacts.phone,          EXCLUDED.phone),
           brief          = COALESCE(crm_contacts.brief,          EXCLUDED.brief),
           /* Only override category if existing row was the default 'other'
              AND hasn't been LLM-categorised — preserve manual edits. */
           category       = CASE
                              WHEN crm_contacts.category = 'other' AND crm_contacts.llm_categorised = false
                                THEN EXCLUDED.category
                              ELSE crm_contacts.category
                            END,
           /* Lift status off 'lost' (noise) when a human deliberately
              uploaded this contact. */
           status         = CASE WHEN crm_contacts.status = 'lost' THEN 'new' ELSE crm_contacts.status END,
           updated_at     = NOW()
         RETURNING *`,
        [company, person, emailLower, phone, brief, catHint]
      );

      res.json({
        ok: true,
        contact: row.rows[0],
        extracted: { company, contact_person: person, email: emailLower, phone, brief, category_hint: catHint }
      });
    } catch (e) {
      console.error('[crm/from-image]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /* ─── AI reply suggestion ─────────────────────────────────────
     Generates a draft email tailored to this contact, written in the
     founder's natural voice — learned from their last 15 outbound
     mails on file. Use cases:
       1. New contact (e.g. from Upwork SDR screenshot) → cold outreach
          first-touch in your style.
       2. Existing contact with email history → reply suggestion that
          fits the thread + your voice.

     Robustness mirrors /from-image: 503 with clear msg if no API key,
     502 on Claude failure, strict JSON parsing with one retry. */
  router.post('/contacts/:id/suggest-reply', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY missing on Admin-Dashboard service' });
      }

      const contactRes = await q(
        `SELECT id, company, contact_person, email, brief, category, status, owner_notes,
                last_email_subject, last_email_direction
           FROM crm_contacts WHERE id = $1`,
        [id]
      );
      if (!contactRes.rows.length) return res.status(404).json({ error: 'Contact not found' });
      const contact = contactRes.rows[0];

      /* Style corpus: last 15 outbound emails from ANY contact. We
         strip subject + body and feed as raw examples — Claude learns
         tone, length, sign-off, formality from these. */
      const stylePool = await q(
        `SELECT subject, body_text
           FROM crm_emails
          WHERE direction = 'outbound'
            AND body_text IS NOT NULL AND LENGTH(body_text) > 30
          ORDER BY sent_at DESC NULLS LAST
          LIMIT 15`
      );

      /* Thread context: last 5 emails to/from this contact. Used so
         the suggestion picks up the conversation rather than starting
         from zero on warm threads. */
      const threadRes = await q(
        `SELECT direction, subject, body_text, sent_at
           FROM crm_emails WHERE contact_id = $1
          ORDER BY sent_at DESC NULLS LAST
          LIMIT 5`,
        [id]
      );
      const hasThread = threadRes.rows.length > 0;

      let Anthropic;
      try { Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk'); }
      catch (e) { return res.status(503).json({ error: 'Anthropic SDK unavailable: ' + e.message }); }
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      /* Build the system prompt with the style + context corpus. We
         emphasise: copy the founder's voice, don't invent facts, never
         claim things the data doesn't support. */
      const styleExamples = stylePool.rows.length
        ? stylePool.rows.slice(0, 15).map((e, i) =>
            `--- Past outbound email #${i + 1} ---\nSubject: ${e.subject || '(no subject)'}\n${(e.body_text || '').slice(0, 1200)}`
          ).join('\n\n')
        : '(no outbound style samples available yet)';

      const threadCtx = hasThread
        ? threadRes.rows.reverse().map(e =>
            `[${e.direction.toUpperCase()}] ${e.sent_at ? new Date(e.sent_at).toISOString().slice(0,10) : ''} — ${e.subject || '(no subject)'}\n${(e.body_text || '').slice(0, 800)}`
          ).join('\n\n---\n\n')
        : 'No prior email history with this contact.';

      const systemPrompt =
`You are drafting an email on behalf of the founder of October AI — a voice-AI
agent product for Matterport virtual tours. The founder's writing style is
visible in the OUTBOUND EMAIL EXAMPLES below. Match it closely:
  · tone (formal vs casual)
  · length (short vs long)
  · sign-off style
  · whether the founder uses bullet points, links, etc.
  · Danish or English (mirror what they normally use with similar contacts)

Rules:
  · Never invent facts. Stick to what's in the contact's brief, owner notes,
    and the thread context.
  · If the contact came from an Upwork SDR (brief mentions partner program,
    AI-agent, or similar), this is a FIRST-TOUCH cold email after an SDR
    intro — keep it short, reference the prior conversation, and propose a
    concrete next step (15-min call).
  · If there IS thread context, treat the next message as a REPLY to the
    most recent inbound email.
  · Output STRICT JSON with exactly two keys (no markdown, no prose):
      { "subject": "string", "body": "string" }
  · "body" uses real line breaks (\\n) — not literal "\\n" strings.
  · Do not include "Dear" or overly formal greetings unless the examples do.`;

      const userPrompt =
`CONTACT
  Name:    ${contact.contact_person || '(unknown)'}
  Email:   ${contact.email}
  Company: ${contact.company || '(unknown)'}
  Category: ${contact.category}
  Brief:   ${contact.brief || '(none)'}
  Notes:   ${contact.owner_notes || '(none)'}

THREAD CONTEXT (most recent last)
${threadCtx}

OUTBOUND EMAIL EXAMPLES (founder's voice — match this)
${styleExamples}

TASK
${hasThread ? 'Draft the next reply to this contact, matching the founder\'s voice.' : 'Draft a first-touch email to this contact, matching the founder\'s voice.'}
Output only the JSON object.`;

      async function callClaude(strict) {
        const resp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1200,
          system: systemPrompt + (strict ? '\n\nIMPORTANT: previous output was not valid JSON. Return ONLY the JSON object.' : ''),
          messages: [{ role: 'user', content: userPrompt }]
        });
        return (resp.content?.[0]?.text || '').trim();
      }
      function tryParse(raw) {
        if (!raw) return null;
        let cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        const s = cleaned.indexOf('{'); const e = cleaned.lastIndexOf('}');
        if (s !== -1 && e > s) cleaned = cleaned.slice(s, e + 1);
        try { return JSON.parse(cleaned); } catch { return null; }
      }

      let parsed = null;
      try {
        parsed = tryParse(await callClaude(false));
        if (!parsed) parsed = tryParse(await callClaude(true));
      } catch (e) {
        return res.status(502).json({ error: 'Claude call failed: ' + e.message });
      }
      if (!parsed || !parsed.body) {
        return res.status(502).json({ error: 'Claude returned no usable draft' });
      }

      res.json({
        ok: true,
        suggestion: {
          subject: String(parsed.subject || '').slice(0, 500),
          body:    String(parsed.body || '').slice(0, 6000)
        },
        usedStyleSamples: stylePool.rows.length,
        usedThreadMessages: threadRes.rows.length,
        isReply: hasThread
      });
    } catch (e) {
      console.error('[crm/suggest-reply]', e);
      res.status(500).json({ error: e.message });
    }
  });

  /* ─── Templates ──────────────────────────────────────────────── */

  router.get('/templates', async (req, res) => {
    try {
      const rows = await q(
        `SELECT id, name, subject, body_text, usage_count, auto_detected, updated_at
           FROM crm_templates
           ORDER BY usage_count DESC, updated_at DESC
           LIMIT 100`
      );
      res.json({ ok: true, templates: rows.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/templates', async (req, res) => {
    try {
      const { name, subject, body_text } = req.body || {};
      if (!body_text || !name) return res.status(400).json({ error: 'name + body_text required' });
      const row = await q(
        `INSERT INTO crm_templates (name, subject, body_text, auto_detected)
         VALUES ($1, $2, $3, false) RETURNING *`,
        [String(name).slice(0, 200), String(subject || '').slice(0, 500), String(body_text).slice(0, 6000)]
      );
      res.json({ ok: true, template: row.rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/templates/:id', async (req, res) => {
    try {
      await q(`DELETE FROM crm_templates WHERE id = $1`, [String(req.params.id)]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ─── Sync trigger + status ──────────────────────────────────── */

  router.post('/sync', async (req, res) => {
    /* Fire and forget — sync can take minutes on first run. */
    res.json({ ok: true, started: true });
    setImmediate(async () => {
      try {
        const result = await gmailSync.runSync(pool);
        await gmailSync.refreshTemplateClusters(pool);
        console.log('[crm/sync] done:', result);
      } catch (e) {
        console.error('[crm/sync] failed:', e.message);
      }
    });
  });

  router.post('/sync/full', async (req, res) => {
    /* One-time full mailbox backfill — fetches everything (no date floor).
       Fires and returns; client polls /sync/status. */
    res.json({ ok: true, started: true });
    setImmediate(async () => {
      try {
        const result = await gmailSync.runFullBackfill(pool);
        await gmailSync.refreshTemplateClusters(pool);
        console.log('[crm/sync/full] done:', result);
      } catch (e) {
        console.error('[crm/sync/full] failed:', e.message);
      }
    });
  });

  router.get('/sync/status', async (req, res) => {
    try {
      const row = await q(
        `SELECT id, started_at, finished_at, status, emails_imported, contacts_new, error_message
           FROM crm_sync_runs ORDER BY started_at DESC LIMIT 1`
      );
      res.json({ ok: true, lastRun: row.rows[0] || null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
