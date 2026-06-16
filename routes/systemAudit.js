/**
 * routes/systemAudit.js
 *
 * Read + trigger endpoints for the "System Audit" dashboard page. Backed by the
 * system_audits table (written by services/systemAudit.js) on the shared prod
 * Postgres.
 *
 *   GET  /api/system-audit/latest  — the most recent run, grouped by env/suite,
 *                                     plus a rolling pass-rate per check.
 *   GET  /api/system-audit/runs    — recent run summaries (history strip).
 *   POST /api/system-audit/run     — trigger an audit on demand (returns the
 *                                     run summary once complete).
 */
const express = require('express');
const audit = require('../services/systemAudit');

module.exports = function (pool) {
  const router = express.Router();

  async function q(sql, params) {
    if (!pool) return { rows: [] };
    try { return await pool.query(sql, params || []); }
    catch (e) { console.error('[system-audit] DB error:', e.message); return { rows: [] }; }
  }

  // Most recent run + its checks, plus 30-day pass-rate per check.
  router.get('/latest', async (req, res) => {
    try {
      const latest = await q(`SELECT run_id, MAX(ran_at) AS ran_at FROM system_audits GROUP BY run_id ORDER BY ran_at DESC LIMIT 1`);
      if (!latest.rows.length) {
        return res.json({ run: null, checks: [], rates: {} });
      }
      const runId = latest.rows[0].run_id;
      const checks = await q(
        `SELECT env, suite, check_name, status, detail, duration_ms, ran_at
           FROM system_audits WHERE run_id = $1
          ORDER BY env, suite, check_name`, [runId]);
      const rates = await q(
        `SELECT env, suite, check_name,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status='PASS')::int AS passed,
                COUNT(*) FILTER (WHERE status='FAIL')::int AS failed
           FROM system_audits
          WHERE ran_at >= NOW() - INTERVAL '30 days'
          GROUP BY env, suite, check_name`);
      const rateMap = {};
      rates.rows.forEach((r) => { rateMap[r.env + '|' + r.suite + '|' + r.check_name] = r; });
      res.json({
        run: { run_id: runId, ran_at: latest.rows[0].ran_at },
        checks: checks.rows,
        rates: rateMap
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Recent run summaries for the history strip.
  router.get('/runs', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    try {
      const rows = await q(
        `SELECT run_id,
                MAX(ran_at) AS ran_at,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status='PASS')::int AS passed,
                COUNT(*) FILTER (WHERE status='WARN')::int AS warned,
                COUNT(*) FILTER (WHERE status='FAIL')::int AS failed
           FROM system_audits
          GROUP BY run_id
          ORDER BY ran_at DESC
          LIMIT $1`, [limit]);
      res.json({ runs: rows.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual trigger. Runs the full audit and returns the summary.
  router.post('/run', async (req, res) => {
    try {
      const summary = await audit.runAudit(pool, 'manual');
      res.json({ ok: true, summary });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
