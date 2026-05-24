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
const gmailSync = require('../services/gmailSync');

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

      const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
      const rows = await q(
        `SELECT id, company, contact_person, email, phone, brief, status, category,
                last_email_at, last_email_subject, last_email_direction,
                EXTRACT(DAY FROM NOW() - last_email_at)::int AS days_since_last_email,
                created_at, updated_at
           FROM crm_contacts
           ${whereSql}
           ORDER BY COALESCE(last_email_at, created_at) DESC NULLS LAST
           LIMIT 500`,
        params
      );

      /* Per-category counts so sidebar badges can stay live. */
      const counts = await q(
        `SELECT category, COUNT(*) AS n FROM crm_contacts GROUP BY category`
      );
      const countMap = { affiliate: 0, customer_service: 0, other: 0, total: 0 };
      for (const r of counts.rows) {
        countMap[r.category] = parseInt(r.n, 10);
        countMap.total += parseInt(r.n, 10);
      }

      res.json({ ok: true, contacts: rows.rows, counts: countMap });
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
      for (const k of allowed) {
        if (k in fields) {
          if (k === 'category' && !['affiliate','customer_service','other'].includes(fields[k])) continue;
          if (k === 'status'   && !['new','active','dormant','lost','converted'].includes(fields[k])) continue;
          params.push(fields[k]);
          set.push(k + ' = $' + params.length);
        }
      }
      if (!set.length) return res.status(400).json({ error: 'No valid fields' });
      params.push(id);
      const row = await q(
        `UPDATE crm_contacts SET ${set.join(', ')}, updated_at = NOW(),
                                  llm_categorised = CASE WHEN $${params.length - (set.length - 1)} IS NOT NULL THEN true ELSE llm_categorised END
          WHERE id = $${params.length} RETURNING *`,
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
