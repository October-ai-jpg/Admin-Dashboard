/**
 * routes/traffic.js
 *
 * Read-only endpoints for the Traffic dashboard. Hits the SAME Postgres
 * as -october-ai (DATABASE_URL points at postgres.railway.internal).
 *
 *   GET /api/traffic/overview?days=N
 *     Top-line KPIs: visitors, sessions, pageviews, avg engaged ms,
 *     bounce rate. Reads from traffic_daily_pages for past full days,
 *     UNION with raw traffic_events for "today".
 *
 *   GET /api/traffic/timeseries?days=N
 *     Per-day pageviews + sessions for the line chart.
 *
 *   GET /api/traffic/pages?days=N&limit=50
 *     Per-page rollup: pageviews, unique_visitors, avg_engaged_ms,
 *     scroll-100 %, exit-rate, bounce-rate. Sorted by pageviews DESC.
 *
 *   GET /api/traffic/sources?days=N
 *     Per source/medium breakdown (sessions, visitors).
 *
 *   GET /api/traffic/page-detail?path=/x&days=N
 *     Drill-down: scroll distribution, top CTAs (label + count),
 *     top outbound hosts, exit-rate, top entry sources for this page.
 */
const express = require('express');

module.exports = function(pool) {
  const router = express.Router();

  async function q(sql, params) {
    if (!pool) return { rows: [] };
    try { return await pool.query(sql, params || []); }
    catch (e) { console.error('[traffic] DB error:', e.message); return { rows: [] }; }
  }

  function rangeDays(req) {
    const n = parseInt(req.query.days, 10);
    if (Number.isFinite(n) && n > 0 && n <= 365) return n;
    return 30;
  }

  /* OVERVIEW — KPIs ────────────────────────────────────────────────
     We union the pre-aggregated days (traffic_daily_pages) with the
     current day computed live from traffic_events, so the dashboard
     never lags by 24h. */
  router.get('/overview', async (req, res) => {
    const days = rangeDays(req);
    try {
      const [past, todayPv, todayUniques, todayEngaged, todayExits, todaySessions] = await Promise.all([
        q(`SELECT
             COALESCE(SUM(pageviews),0)::int        AS pageviews,
             COALESCE(SUM(unique_visitors),0)::int  AS visitors,
             COALESCE(SUM(unique_sessions),0)::int  AS sessions,
             COALESCE(SUM(exit_count),0)::int       AS exits,
             COALESCE(SUM(bounce_count),0)::int     AS bounces,
             COALESCE(AVG(avg_engaged_ms) FILTER (WHERE avg_engaged_ms > 0),0)::int AS avg_engaged_ms
           FROM traffic_daily_pages
           WHERE day >= CURRENT_DATE - ($1::int - 1) AND day < CURRENT_DATE`,
          [days]),
        q(`SELECT COUNT(*)::int AS n FROM traffic_events WHERE event_type='pageview' AND ts >= CURRENT_DATE`),
        q(`SELECT COUNT(DISTINCT visitor_id)::int AS n FROM traffic_events WHERE ts >= CURRENT_DATE`),
        q(`SELECT COALESCE(AVG(sess_ms),0)::int AS ms FROM (
              SELECT session_id, SUM(COALESCE((payload->>'dwell_ms')::int,0)) AS sess_ms
                FROM traffic_events WHERE event_type='heartbeat' AND ts >= CURRENT_DATE
               GROUP BY session_id
            ) s`),
        q(`SELECT COUNT(*)::int AS n FROM (
              SELECT DISTINCT ON (session_id) session_id
                FROM traffic_events WHERE event_type='pageview' AND ts >= CURRENT_DATE
               ORDER BY session_id, ts DESC
            ) e`),
        q(`SELECT COUNT(DISTINCT session_id)::int AS n FROM traffic_events WHERE ts >= CURRENT_DATE`)
      ]);
      const p = past.rows[0] || {};
      const totalPv = (p.pageviews || 0) + (todayPv.rows[0]?.n || 0);
      const totalVis = (p.visitors || 0) + (todayUniques.rows[0]?.n || 0);   // approx — visitor_ids may overlap day/today
      const totalSess = (p.sessions || 0) + (todaySessions.rows[0]?.n || 0); // approx — same caveat
      const totalExits = (p.exits || 0) + (todayExits.rows[0]?.n || 0);
      // avg engaged: weight past + today
      const avgEngaged = todayEngaged.rows[0]?.ms
        ? Math.round(((p.avg_engaged_ms || 0) + todayEngaged.rows[0].ms) / 2)
        : (p.avg_engaged_ms || 0);
      const bounceRate = totalSess > 0 ? Math.round((p.bounces || 0) / totalSess * 1000) / 10 : 0;
      res.json({
        days,
        pageviews: totalPv,
        visitors: totalVis,
        sessions: totalSess,
        avg_engaged_ms: avgEngaged,
        bounce_rate: bounceRate,
        exits: totalExits
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* TIMESERIES — daily pageviews + sessions for the line chart. */
  router.get('/timeseries', async (req, res) => {
    const days = rangeDays(req);
    try {
      // Past days from rollup
      const past = await q(
        `SELECT day::text AS day,
                SUM(pageviews)::int       AS pageviews,
                SUM(unique_sessions)::int AS sessions,
                SUM(unique_visitors)::int AS visitors
           FROM traffic_daily_pages
          WHERE day >= CURRENT_DATE - ($1::int - 1) AND day < CURRENT_DATE
          GROUP BY day ORDER BY day`,
        [days]
      );
      const today = await q(
        `SELECT CURRENT_DATE::text AS day,
                COUNT(*) FILTER (WHERE event_type='pageview')::int          AS pageviews,
                COUNT(DISTINCT session_id)::int                              AS sessions,
                COUNT(DISTINCT visitor_id)::int                              AS visitors
           FROM traffic_events
          WHERE ts >= CURRENT_DATE`
      );
      const rows = past.rows.slice();
      if (today.rows[0] && today.rows[0].pageviews > 0) rows.push(today.rows[0]);
      res.json({ days, series: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* PAGES — top pages by pageviews, with engagement. */
  router.get('/pages', async (req, res) => {
    const days = rangeDays(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    try {
      const past = await q(
        `SELECT path,
                SUM(pageviews)::int                  AS pageviews,
                SUM(unique_visitors)::int            AS unique_visitors,
                SUM(unique_sessions)::int            AS unique_sessions,
                COALESCE(AVG(avg_engaged_ms) FILTER (WHERE avg_engaged_ms > 0), 0)::int AS avg_engaged_ms,
                SUM(scroll_100_count)::int           AS scroll_100,
                SUM(cta_clicks)::int                 AS cta_clicks,
                SUM(exit_count)::int                 AS exits,
                SUM(bounce_count)::int               AS bounces
           FROM traffic_daily_pages
          WHERE day >= CURRENT_DATE - ($1::int - 1) AND day < CURRENT_DATE
          GROUP BY path`,
        [days]
      );
      // Merge in today's live numbers
      const today = await q(
        `SELECT path,
                COUNT(*) FILTER (WHERE event_type='pageview')::int                                AS pageviews,
                COUNT(DISTINCT visitor_id) FILTER (WHERE event_type='pageview')::int              AS unique_visitors,
                COUNT(DISTINCT session_id) FILTER (WHERE event_type='pageview')::int              AS unique_sessions,
                COUNT(*) FILTER (WHERE event_type='scroll' AND (payload->>'pct')::int >= 100)::int AS scroll_100,
                COUNT(*) FILTER (WHERE event_type='cta')::int                                     AS cta_clicks
           FROM traffic_events
          WHERE ts >= CURRENT_DATE
          GROUP BY path`
      );
      const merged = new Map();
      past.rows.forEach(r => merged.set(r.path, r));
      today.rows.forEach(t => {
        const cur = merged.get(t.path) || {
          path: t.path, pageviews: 0, unique_visitors: 0, unique_sessions: 0,
          avg_engaged_ms: 0, scroll_100: 0, cta_clicks: 0, exits: 0, bounces: 0
        };
        cur.pageviews       = (cur.pageviews || 0) + t.pageviews;
        cur.unique_visitors = (cur.unique_visitors || 0) + t.unique_visitors;
        cur.unique_sessions = (cur.unique_sessions || 0) + t.unique_sessions;
        cur.scroll_100      = (cur.scroll_100 || 0) + t.scroll_100;
        cur.cta_clicks      = (cur.cta_clicks || 0) + t.cta_clicks;
        merged.set(t.path, cur);
      });
      const out = Array.from(merged.values())
        .filter(r => (r.pageviews || 0) > 0)
        .sort((a, b) => b.pageviews - a.pageviews)
        .slice(0, limit)
        .map(r => ({
          ...r,
          scroll_100_pct: r.pageviews > 0 ? Math.round((r.scroll_100 || 0) / r.pageviews * 1000) / 10 : 0,
          exit_pct: r.unique_sessions > 0 ? Math.round((r.exits || 0) / r.unique_sessions * 1000) / 10 : 0,
          bounce_pct: r.unique_sessions > 0 ? Math.round((r.bounces || 0) / r.unique_sessions * 1000) / 10 : 0
        }));
      res.json({ days, pages: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* SOURCES — UTM / referrer breakdown for the period. */
  router.get('/sources', async (req, res) => {
    const days = rangeDays(req);
    try {
      const past = await q(
        `SELECT source, medium, campaign,
                SUM(sessions)::int AS sessions,
                SUM(visitors)::int AS visitors
           FROM traffic_daily_sources
          WHERE day >= CURRENT_DATE - ($1::int - 1) AND day < CURRENT_DATE
          GROUP BY source, medium, campaign
          ORDER BY sessions DESC LIMIT 50`,
        [days]
      );
      res.json({ days, sources: past.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* PAGE-DETAIL — drill-down for one path. Reads raw events (full
     period) so the dashboard can show scroll distribution and top CTAs
     even for low-traffic pages that don't show in the rollup. */
  router.get('/page-detail', async (req, res) => {
    const days = rangeDays(req);
    const path = String(req.query.path || '').slice(0, 500);
    if (!path) return res.status(400).json({ error: 'path required' });
    try {
      const [scrolls, ctas, outbounds, sources] = await Promise.all([
        q(`SELECT (payload->>'pct')::int AS pct, COUNT(*)::int AS n
             FROM traffic_events
            WHERE event_type='scroll' AND path=$1
              AND ts >= CURRENT_DATE - ($2::int - 1)
            GROUP BY pct ORDER BY pct`, [path, days]),
        q(`SELECT payload->>'label' AS label, COUNT(*)::int AS n
             FROM traffic_events
            WHERE event_type='cta' AND path=$1
              AND ts >= CURRENT_DATE - ($2::int - 1)
            GROUP BY label ORDER BY n DESC LIMIT 20`, [path, days]),
        q(`SELECT payload->>'host' AS host, COUNT(*)::int AS n
             FROM traffic_events
            WHERE event_type='outbound' AND path=$1
              AND ts >= CURRENT_DATE - ($2::int - 1)
            GROUP BY host ORDER BY n DESC LIMIT 20`, [path, days]),
        q(`SELECT COALESCE(NULLIF(utm_source,''),
                          NULLIF(regexp_replace(COALESCE(referrer,''),'^https?://([^/]+).*$','\\1'),''),
                          '(direct)') AS source,
                  COUNT(DISTINCT session_id)::int AS sessions
             FROM traffic_events
            WHERE path=$1 AND event_type='pageview'
              AND ts >= CURRENT_DATE - ($2::int - 1)
            GROUP BY 1 ORDER BY sessions DESC LIMIT 15`, [path, days])
      ]);
      res.json({
        path, days,
        scroll_distribution: scrolls.rows,
        top_ctas: ctas.rows,
        top_outbounds: outbounds.rows,
        top_sources: sources.rows
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
