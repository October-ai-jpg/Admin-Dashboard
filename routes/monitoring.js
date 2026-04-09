const express = require('express');

module.exports = function(pool) {
  const router = express.Router();

  /* Helper: run query safely */
  async function query(sql, params) {
    if (!pool) return { rows: [] };
    try {
      return await pool.query(sql, params || []);
    } catch(e) {
      console.error('DB query error:', e.message);
      return { rows: [] };
    }
  }

  /* ═══════════════════════════════════════
     OVERVIEW — key metrics
     ═══════════════════════════════════════ */
  router.get('/overview', async (req, res) => {
    try {
      const [customers, agents, conversations, affiliates, minutes, conversions] = await Promise.all([
        query('SELECT COUNT(*) as count FROM users'),
        query('SELECT COUNT(*) as count FROM tenants'),
        query("SELECT COUNT(*) as count FROM conversations WHERE created_at > NOW() - INTERVAL '30 days'"),
        query('SELECT COUNT(*) as count FROM affiliates'),
        query('SELECT COALESCE(SUM(minutes_used_this_month), 0) as total FROM tenants'),
        query("SELECT COUNT(*) as count FROM conversations WHERE created_at > NOW() - INTERVAL '30 days' AND converted = true")
      ]);

      const totalConvos = parseInt(conversations.rows[0]?.count || 0);
      const totalConversions = parseInt(conversions.rows[0]?.count || 0);

      // MRR from active paying users
      const mrr = await query("SELECT COUNT(*) as count FROM users WHERE plan_active = true");
      const mrrVal = parseInt(mrr.rows[0]?.count || 0) * 149;

      // Avg session duration
      const avgDuration = await query("SELECT COALESCE(AVG(duration_seconds), 0) as avg FROM conversations WHERE created_at > NOW() - INTERVAL '30 days' AND duration_seconds > 0");

      res.json({
        customers: parseInt(customers.rows[0]?.count || 0),
        agents: parseInt(agents.rows[0]?.count || 0),
        conversations: totalConvos,
        affiliates: parseInt(affiliates.rows[0]?.count || 0),
        mrr: mrrVal,
        minutesUsed: parseInt(minutes.rows[0]?.total || 0),
        conversionRate: totalConvos > 0 ? Math.round((totalConversions / totalConvos) * 100) : 0,
        avgSessionDuration: Math.round(parseFloat(avgDuration.rows[0]?.avg || 0))
      });
    } catch(e) {
      console.error('Overview error:', e);
      res.json({ customers: 0, agents: 0, conversations: 0, affiliates: 0, mrr: 0, minutesUsed: 0, conversionRate: 0, avgSessionDuration: 0 });
    }
  });

  /* ═══════════════════════════════════════
     OVERVIEW — charts data
     ═══════════════════════════════════════ */
  router.get('/overview/charts', async (req, res) => {
    try {
      // Conversations per day (30 days)
      const convosPerDay = await query(`
        SELECT DATE(created_at) as day, COUNT(*) as count
        FROM conversations
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY day
      `);

      // MRR over time (12 months) — approximate from user signups
      const mrrOverTime = await query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
               COUNT(*) as new_users
        FROM users
        WHERE created_at > NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', created_at)
        ORDER BY month
      `);

      // Conversion rate per day (30 days)
      const convRatePerDay = await query(`
        SELECT DATE(created_at) as day,
               COUNT(*) as total,
               SUM(CASE WHEN converted = true THEN 1 ELSE 0 END) as converted
        FROM conversations
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY day
      `);

      res.json({
        conversationsPerDay: convosPerDay.rows,
        mrrOverTime: mrrOverTime.rows,
        conversionRatePerDay: convRatePerDay.rows.map(r => ({
          day: r.day,
          rate: parseInt(r.total) > 0 ? Math.round((parseInt(r.converted) / parseInt(r.total)) * 100) : 0
        }))
      });
    } catch(e) {
      console.error('Charts error:', e);
      res.json({ conversationsPerDay: [], mrrOverTime: [], conversionRatePerDay: [] });
    }
  });

  /* ═══════════════════════════════════════
     CUSTOMERS
     ═══════════════════════════════════════ */
  router.get('/customers', async (req, res) => {
    const { search, filter, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (search) {
      where += ` AND (u.name ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx})`;
      params.push('%' + search + '%');
      paramIdx++;
    }
    if (filter === 'active') { where += ' AND u.plan_active = true'; }
    else if (filter === 'inactive') { where += ' AND u.plan_active = false'; }

    try {
      const countResult = await query(`SELECT COUNT(DISTINCT u.id) as count FROM users u ${where}`, params);
      const total = parseInt(countResult.rows[0]?.count || 0);

      const result = await query(`
        SELECT u.id, u.name, u.email, u.plan_active, u.created_at, u.affiliate_ref,
               COUNT(DISTINCT t.id) as agent_count,
               COUNT(DISTINCT c.id) as conversation_count,
               COALESCE(SUM(t.minutes_used_this_month), 0) as minutes_used
        FROM users u
        LEFT JOIN tenants t ON t.user_id = u.id
        LEFT JOIN conversations c ON c.tenant_id = t.id AND c.created_at > NOW() - INTERVAL '30 days'
        ${where}
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `, [...params, parseInt(limit), offset]);

      res.json({ customers: result.rows, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
    } catch(e) {
      console.error('Customers error:', e);
      res.json({ customers: [], total: 0, page: 1, pages: 0 });
    }
  });

  router.get('/customers/:id', async (req, res) => {
    try {
      const user = await query('SELECT * FROM users WHERE id = $1', [req.params.id]);
      if (user.rows.length === 0) return res.status(404).json({ error: 'Not found' });

      const agents = await query(`
        SELECT t.*, COUNT(c.id) as conversation_count
        FROM tenants t
        LEFT JOIN conversations c ON c.tenant_id = t.id
        WHERE t.user_id = $1
        GROUP BY t.id
        ORDER BY t.created_at DESC
      `, [req.params.id]);

      const conversations = await query(`
        SELECT c.* FROM conversations c
        JOIN tenants t ON c.tenant_id = t.id
        WHERE t.user_id = $1
        ORDER BY c.created_at DESC LIMIT 50
      `, [req.params.id]);

      res.json({
        customer: user.rows[0],
        agents: agents.rows,
        conversations: conversations.rows
      });
    } catch(e) {
      console.error('Customer detail error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /* ═══════════════════════════════════════
     AGENTS
     ═══════════════════════════════════════ */
  router.get('/agents', async (req, res) => {
    const { search, filter, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (search) {
      where += ` AND (t.agent_name ILIKE $${paramIdx} OR t.property_name ILIKE $${paramIdx})`;
      params.push('%' + search + '%');
      paramIdx++;
    }
    if (filter && filter !== 'all') {
      where += ` AND t.vertical = $${paramIdx}`;
      params.push(filter);
      paramIdx++;
    }

    try {
      const countResult = await query(`SELECT COUNT(*) as count FROM tenants t ${where}`, params);
      const total = parseInt(countResult.rows[0]?.count || 0);

      const result = await query(`
        SELECT t.id, t.agent_name, t.property_name, t.vertical, t.minutes_used_this_month,
               t.created_at, t.user_id,
               u.name as customer_name, u.email as customer_email,
               COUNT(DISTINCT c.id) as conversations,
               SUM(CASE WHEN c.converted = true THEN 1 ELSE 0 END) as conversions
        FROM tenants t
        LEFT JOIN users u ON u.id = t.user_id
        LEFT JOIN conversations c ON c.tenant_id = t.id AND c.created_at > NOW() - INTERVAL '30 days'
        ${where}
        GROUP BY t.id, u.name, u.email
        ORDER BY t.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `, [...params, parseInt(limit), offset]);

      res.json({ agents: result.rows, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
    } catch(e) {
      console.error('Agents error:', e);
      res.json({ agents: [], total: 0, page: 1, pages: 0 });
    }
  });

  router.get('/agents/:id', async (req, res) => {
    try {
      const agent = await query(`
        SELECT t.*, u.name as customer_name, u.email as customer_email
        FROM tenants t
        LEFT JOIN users u ON u.id = t.user_id
        WHERE t.id = $1
      `, [req.params.id]);
      if (agent.rows.length === 0) return res.status(404).json({ error: 'Not found' });

      const conversations = await query(`
        SELECT * FROM conversations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50
      `, [req.params.id]);

      res.json({ agent: agent.rows[0], conversations: conversations.rows });
    } catch(e) {
      console.error('Agent detail error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  /* ═══════════════════════════════════════
     CONVERSATIONS
     ═══════════════════════════════════════ */
  router.get('/conversations', async (req, res) => {
    const { agent, date_from, date_to, converted, page = 1, limit = 25 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (agent) {
      where += ` AND c.tenant_id = $${paramIdx}`;
      params.push(agent);
      paramIdx++;
    }
    if (date_from) {
      where += ` AND c.created_at >= $${paramIdx}`;
      params.push(date_from);
      paramIdx++;
    }
    if (date_to) {
      where += ` AND c.created_at <= $${paramIdx}`;
      params.push(date_to);
      paramIdx++;
    }
    if (converted === 'true') { where += ' AND c.converted = true'; }
    else if (converted === 'false') { where += ' AND (c.converted = false OR c.converted IS NULL)'; }

    try {
      const countResult = await query(`SELECT COUNT(*) as count FROM conversations c ${where}`, params);
      const total = parseInt(countResult.rows[0]?.count || 0);

      const result = await query(`
        SELECT c.*, t.agent_name, t.property_name, u.name as customer_name
        FROM conversations c
        LEFT JOIN tenants t ON c.tenant_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        ${where}
        ORDER BY c.created_at DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
      `, [...params, parseInt(limit), offset]);

      res.json({ conversations: result.rows, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
    } catch(e) {
      console.error('Conversations error:', e);
      res.json({ conversations: [], total: 0, page: 1, pages: 0 });
    }
  });

  router.get('/conversations/:id', async (req, res) => {
    try {
      const result = await query(`
        SELECT c.*, t.agent_name, t.property_name, u.name as customer_name
        FROM conversations c
        LEFT JOIN tenants t ON c.tenant_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        WHERE c.id = $1
      `, [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
      res.json(result.rows[0]);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  /* ═══════════════════════════════════════
     AFFILIATES
     ═══════════════════════════════════════ */
  router.get('/affiliates', async (req, res) => {
    try {
      const result = await query(`
        SELECT a.*,
               COUNT(DISTINCT u.id) as active_clients,
               COALESCE(SUM(ac.commission_amount), 0) as total_earned
        FROM affiliates a
        LEFT JOIN users u ON u.affiliate_ref = a.ref_code
        LEFT JOIN affiliate_commissions ac ON ac.affiliate_ref = a.ref_code
        GROUP BY a.id
        ORDER BY a.created_at DESC
      `);

      // Summary
      const summary = await query(`
        SELECT
          COALESCE(SUM(CASE WHEN ac.created_at > DATE_TRUNC('month', NOW()) THEN ac.commission_amount ELSE 0 END), 0) as this_month,
          COALESCE(SUM(CASE WHEN ac.paid = true THEN ac.commission_amount ELSE 0 END), 0) as total_paid,
          COALESCE(SUM(CASE WHEN ac.paid = false OR ac.paid IS NULL THEN ac.commission_amount ELSE 0 END), 0) as pending
        FROM affiliate_commissions ac
      `);

      res.json({
        affiliates: result.rows,
        summary: summary.rows[0] || { this_month: 0, total_paid: 0, pending: 0 }
      });
    } catch(e) {
      console.error('Affiliates error:', e);
      res.json({ affiliates: [], summary: { this_month: 0, total_paid: 0, pending: 0 } });
    }
  });

  /* ═══════════════════════════════════════
     REVENUE
     ═══════════════════════════════════════ */
  router.get('/revenue', async (req, res) => {
    try {
      const activeUsers = await query("SELECT COUNT(*) as count FROM users WHERE plan_active = true");
      const subscriptionRevenue = parseInt(activeUsers.rows[0]?.count || 0) * 149;

      const minutesUsed = await query('SELECT COALESCE(SUM(minutes_used_this_month), 0) as total FROM tenants');
      const totalMinutes = parseInt(minutesUsed.rows[0]?.total || 0);
      const apiCost = Math.round(totalMinutes * 0.15 * 100) / 100; // est $0.15/min

      const commissions = await query(`
        SELECT COALESCE(SUM(commission_amount), 0) as total
        FROM affiliate_commissions
        WHERE created_at > DATE_TRUNC('month', NOW())
      `);

      const monthlyCommissions = parseFloat(commissions.rows[0]?.total || 0);

      // 12-month revenue chart
      const revenueChart = await query(`
        SELECT TO_CHAR(DATE_TRUNC('month', u.created_at), 'YYYY-MM') as month,
               COUNT(*) * 149 as revenue
        FROM users u
        WHERE u.plan_active = true AND u.created_at > NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', u.created_at)
        ORDER BY month
      `);

      res.json({
        subscriptionRevenue,
        overageRevenue: 0,
        totalRevenue: subscriptionRevenue,
        apiCosts: apiCost,
        affiliateCommissions: monthlyCommissions,
        infrastructure: 50,
        profit: subscriptionRevenue - apiCost - monthlyCommissions - 50,
        margin: subscriptionRevenue > 0 ? Math.round(((subscriptionRevenue - apiCost - monthlyCommissions - 50) / subscriptionRevenue) * 100) : 0,
        chart: revenueChart.rows
      });
    } catch(e) {
      console.error('Revenue error:', e);
      res.json({ subscriptionRevenue: 0, overageRevenue: 0, totalRevenue: 0, apiCosts: 0, affiliateCommissions: 0, infrastructure: 0, profit: 0, margin: 0, chart: [] });
    }
  });

  /* ═══════════════════════════════════════
     ERROR LOG (for System Health)
     ═══════════════════════════════════════ */
  router.get('/errors', async (req, res) => {
    try {
      const result = await query(`
        SELECT c.id, c.created_at, c.tenant_id, c.error_message,
               t.agent_name, t.property_name
        FROM conversations c
        LEFT JOIN tenants t ON c.tenant_id = t.id
        WHERE c.error_message IS NOT NULL AND c.error_message != ''
        ORDER BY c.created_at DESC
        LIMIT 50
      `);
      res.json(result.rows);
    } catch(e) {
      console.error('Errors query failed:', e);
      res.json([]);
    }
  });

  /* ═══════════════════════════════════════
     TENANTS LIST — for sandbox "Load from tenant"
     ═══════════════════════════════════════ */
  router.get('/tenants', async (req, res) => {
    try {
      const result = await query(`
        SELECT id, agent_name, property_name, vertical, property_data, room_mappings
        FROM tenants ORDER BY agent_name
      `);
      res.json(result.rows);
    } catch(e) {
      res.json([]);
    }
  });

  return router;
};
