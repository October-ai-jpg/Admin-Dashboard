/**
 * routes/emailMarketing.js
 *
 * Read-only endpoints for the "E-mail Marketing" dashboard page. Hits the
 * SAME Postgres as -october-ai (email_captures table, populated by the
 * 10-second early-access popup — see -october-ai routes/emailCapture.js).
 *
 *   GET /api/email-marketing/stats?days=N
 *     Totals (all-time + in-range + today), per-day signups for the chart,
 *     source breakdown, and the most recent captures.
 */
const express = require('express');

module.exports = function(pool) {
  const router = express.Router();

  async function q(sql, params) {
    if (!pool) return { rows: [] };
    try { return await pool.query(sql, params || []); }
    catch (e) { console.error('[email-marketing] DB error:', e.message); return { rows: [] }; }
  }

  function rangeDays(req) {
    const n = parseInt(req.query.days, 10);
    if (Number.isFinite(n) && n > 0 && n <= 365) return n;
    return 30;
  }

  router.get('/stats', async (req, res) => {
    const days = rangeDays(req);
    try {
      const [totals, daily, sources, recent] = await Promise.all([
        q(`SELECT
             COUNT(*)::int                                                   AS total,
             COUNT(*) FILTER (WHERE status = 'subscribed')::int              AS subscribed,
             COUNT(*) FILTER (WHERE status = 'unsubscribed')::int            AS unsubscribed,
             COUNT(*) FILTER (WHERE created_at >= NOW() - ($1::int || ' days')::interval)::int AS in_range,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int  AS last_7d,
             COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int          AS today
           FROM email_captures`, [days]),
        q(`SELECT DATE_TRUNC('day', created_at)::date AS day, COUNT(*)::int AS n
             FROM email_captures
            WHERE created_at >= NOW() - ($1::int || ' days')::interval
            GROUP BY day ORDER BY day ASC`, [days]),
        q(`SELECT COALESCE(NULLIF(utm_source,''), source, '(direct)') AS source, COUNT(*)::int AS n
             FROM email_captures
            WHERE created_at >= NOW() - ($1::int || ' days')::interval
            GROUP BY 1 ORDER BY n DESC LIMIT 20`, [days]),
        q(`SELECT id, email, source, page_path, country, status, welcomed, created_at
             FROM email_captures
            ORDER BY created_at DESC LIMIT 200`)
      ]);

      res.json({
        range_days: days,
        totals: totals.rows[0] || {},
        daily: daily.rows,
        sources: sources.rows,
        recent: recent.rows
      });
    } catch (e) {
      console.error('[email-marketing/stats]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
