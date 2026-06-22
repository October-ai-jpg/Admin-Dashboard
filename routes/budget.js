/**
 * routes/budget.js
 *
 * Self-editable burn-rate / runway tool for the "Budget" dashboard page.
 * Everything is editable from the UI and persisted in Postgres — no env
 * vars. Backed by two tables on the shared prod pool:
 *
 *   finance_budget          — singleton (id=1) config: fixed-cost line
 *                             items (JSONB), Meta-ads daily spend, a
 *                             variable/API monthly figure, and the current
 *                             bank balance.
 *   finance_balance_history — one row per day the balance is saved, so the
 *                             chart can show the real bank balance over
 *                             time alongside the projected runway line.
 *
 *   GET  /api/budget   — config + computed (burn, runway) + balance history
 *   PUT  /api/budget   — save the editable config; snapshots today's balance
 *
 * All amounts are in DKK.
 */
const express = require('express');

/* Seed the singleton with the founder's current numbers (from the planning
   sheet) so the page is useful immediately; every value stays editable. */
const SEED_LINE_ITEMS = [
  { label: 'Matterport',   monthly_dkk: 600 },
  { label: 'Telenor',      monthly_dkk: 220 },
  { label: 'Railway',      monthly_dkk: 130 },
  { label: 'SDR',          monthly_dkk: 4680 },
  { label: 'Apollo',       monthly_dkk: 384 },
  { label: 'Calendly',     monthly_dkk: 65 },
  { label: 'Make',         monthly_dkk: 65 },
  { label: 'Capture 3D',   monthly_dkk: 135 },
  { label: 'Deepgram',     monthly_dkk: 375 },
  { label: 'G-workspace',  monthly_dkk: 130 },
  { label: 'Claude',       monthly_dkk: 600 },
  { label: 'Squarespace',  monthly_dkk: 300 }
];
const SEED_META_ADS_DAILY = 440;
const SEED_API_USAGE = 1000;

module.exports = function (pool) {
  const router = express.Router();
  let schemaReady = false;

  async function ensureSchema() {
    if (schemaReady || !pool) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finance_budget (
        id                 INT PRIMARY KEY DEFAULT 1,
        line_items         JSONB    NOT NULL DEFAULT '[]'::jsonb,
        meta_ads_daily_dkk NUMERIC  NOT NULL DEFAULT 0,
        api_usage_dkk      NUMERIC  NOT NULL DEFAULT 0,
        bank_balance_dkk   NUMERIC  NOT NULL DEFAULT 0,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT finance_budget_singleton CHECK (id = 1)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finance_balance_history (
        recorded_on      DATE PRIMARY KEY DEFAULT CURRENT_DATE,
        bank_balance_dkk NUMERIC NOT NULL,
        monthly_burn_dkk NUMERIC NOT NULL
      )`);
    /* Seed the singleton once. */
    await pool.query(
      `INSERT INTO finance_budget (id, line_items, meta_ads_daily_dkk, api_usage_dkk, bank_balance_dkk)
       VALUES (1, $1::jsonb, $2, $3, 0)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(SEED_LINE_ITEMS), SEED_META_ADS_DAILY, SEED_API_USAGE]
    );
    schemaReady = true;
  }

  /* Clean an incoming line-items array → [{label, monthly_dkk}]. */
  function cleanLineItems(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .map(function (it) {
        const label = String((it && it.label) || '').trim().slice(0, 80);
        const monthly = Number((it && it.monthly_dkk) || 0);
        return { label: label, monthly_dkk: isFinite(monthly) && monthly >= 0 ? monthly : 0 };
      })
      .filter(function (it) { return it.label !== ''; })
      .slice(0, 100);
  }

  function num(v, fallback) {
    const n = Number(v);
    return isFinite(n) && n >= 0 ? n : (fallback || 0);
  }

  /* Build the full payload (config + computed + history) from a config row. */
  async function buildPayload(row) {
    const lineItems = Array.isArray(row.line_items) ? row.line_items : [];
    const fixedTotal = lineItems.reduce(function (s, it) { return s + Number(it.monthly_dkk || 0); }, 0);
    const metaDaily = Number(row.meta_ads_daily_dkk || 0);
    const metaMonthly = metaDaily * 30;
    const apiUsage = Number(row.api_usage_dkk || 0);
    const totalBurn = fixedTotal + metaMonthly + apiUsage;
    const bank = Number(row.bank_balance_dkk || 0);

    const runwayMonths = totalBurn > 0 ? bank / totalBurn : null;
    let runwayDate = null;
    if (runwayMonths != null && isFinite(runwayMonths)) {
      const d = new Date();
      d.setDate(d.getDate() + Math.round(runwayMonths * 30.44));
      runwayDate = d.toISOString().slice(0, 10);
    }

    const hist = await pool.query(
      `SELECT to_char(recorded_on,'YYYY-MM-DD') AS recorded_on,
              bank_balance_dkk::float8 AS bank_balance_dkk,
              monthly_burn_dkk::float8 AS monthly_burn_dkk
         FROM finance_balance_history
        ORDER BY recorded_on ASC`
    );

    return {
      config: {
        line_items: lineItems,
        meta_ads_daily_dkk: metaDaily,
        api_usage_dkk: apiUsage,
        bank_balance_dkk: bank,
        updated_at: row.updated_at
      },
      computed: {
        fixed_total_dkk: fixedTotal,
        meta_monthly_dkk: metaMonthly,
        api_usage_dkk: apiUsage,
        total_burn_dkk: totalBurn,
        runway_months: runwayMonths,
        runway_date: runwayDate
      },
      history: hist.rows
    };
  }

  async function getRow() {
    const r = await pool.query('SELECT * FROM finance_budget WHERE id = 1');
    return r.rows[0] || { line_items: SEED_LINE_ITEMS, meta_ads_daily_dkk: 0, api_usage_dkk: 0, bank_balance_dkk: 0, updated_at: null };
  }

  /* GET — current config + computed burn/runway + balance history. */
  router.get('/', async function (req, res) {
    try {
      if (!pool) return res.status(503).json({ error: 'no_db' });
      await ensureSchema();
      const row = await getRow();
      res.json(await buildPayload(row));
    } catch (e) {
      console.error('[budget] GET error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /* PUT — save editable config + snapshot today's bank balance / burn. */
  router.put('/', async function (req, res) {
    try {
      if (!pool) return res.status(503).json({ error: 'no_db' });
      await ensureSchema();
      const b = req.body || {};
      const lineItems = cleanLineItems(b.line_items);
      const metaDaily = num(b.meta_ads_daily_dkk);
      const apiUsage = num(b.api_usage_dkk);
      const bank = num(b.bank_balance_dkk);

      await pool.query(
        `UPDATE finance_budget
            SET line_items = $1::jsonb,
                meta_ads_daily_dkk = $2,
                api_usage_dkk = $3,
                bank_balance_dkk = $4,
                updated_at = NOW()
          WHERE id = 1`,
        [JSON.stringify(lineItems), metaDaily, apiUsage, bank]
      );

      const row = await getRow();
      const payload = await buildPayload(row);

      /* Snapshot today's balance + burn so the chart has a real series. */
      await pool.query(
        `INSERT INTO finance_balance_history (recorded_on, bank_balance_dkk, monthly_burn_dkk)
         VALUES (CURRENT_DATE, $1, $2)
         ON CONFLICT (recorded_on)
         DO UPDATE SET bank_balance_dkk = EXCLUDED.bank_balance_dkk,
                       monthly_burn_dkk = EXCLUDED.monthly_burn_dkk`,
        [bank, payload.computed.total_burn_dkk]
      );

      /* Re-read history so the response reflects the new snapshot. */
      res.json(await buildPayload(row));
    } catch (e) {
      console.error('[budget] PUT error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
