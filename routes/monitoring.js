const express = require('express');

module.exports = function(pool) {
  const router = express.Router();

  /* Helper: run query safely */
  async function query(sql, params) {
    if (!pool) return { rows: [] };
    try {
      return await pool.query(sql, params || []);
    } catch(e) {
      console.error('DB query error:', e.message, '\nSQL:', sql.substring(0, 200));
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
        query("SELECT COUNT(*) as count FROM conversations WHERE created_at > NOW() - INTERVAL '30 days' AND (had_booking_click = true OR conversion_stage = 'converted')")
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
               SUM(CASE WHEN had_booking_click = true OR conversion_stage = 'converted' THEN 1 ELSE 0 END) as converted
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
        SELECT u.id, u.name, u.email, u.plan_active, u.plan, u.created_at, u.affiliate_ref,
               u.company_name, u.account_type, u.agent_package,
               COUNT(DISTINCT t.id) as agent_count,
               COUNT(DISTINCT c.id) as conversation_count,
               COALESCE(SUM(DISTINCT t.minutes_used_this_month), 0) as minutes_used
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
        SELECT t.id, t.name, t.agent_name, t.minutes_used_this_month, t.created_at, t.active,
               cl.vertical, cl.data_score,
               COUNT(c.id) as conversation_count
        FROM tenants t
        LEFT JOIN clients cl ON cl.id = t.client_id
        LEFT JOIN conversations c ON c.tenant_id = t.id
        WHERE t.user_id = $1
        GROUP BY t.id, cl.vertical, cl.data_score
        ORDER BY t.created_at DESC
      `, [req.params.id]);

      const conversations = await query(`
        SELECT c.id, c.created_at, c.duration_seconds, c.messages_count,
               c.had_booking_click, c.conversion_stage
        FROM conversations c
        JOIN tenants t ON c.tenant_id = t.id
        WHERE t.user_id = $1
        ORDER BY c.created_at DESC LIMIT 50
      `, [req.params.id]);

      /* 2026-04-28 — emails sent to this user, persisted by the platform's
         services/email.js#_logEmailSend (migration v42 in eb-tour-agent).
         Match by user_id when present, else fall back to to_addr matching
         the user's email so logs predating v42 deploy still surface for
         this user. Limit 50 — drawer is for at-a-glance, not full audit. */
      const emails = await query(`
        SELECT id, to_addr, subject, kind, status, resend_message_id, error, sent_at
        FROM email_log
        WHERE user_id = $1 OR to_addr = $2
        ORDER BY sent_at DESC LIMIT 50
      `, [req.params.id, user.rows[0].email]);

      /* Last login proxy: most recent sessions row created. sessions are
         created by /auth/login; created_at = login time. NULL if user
         has never logged in (or session expired + cleaned). */
      const lastLogin = await query(`
        SELECT MAX(created_at) as last_login_at
        FROM sessions WHERE user_id = $1
      `, [req.params.id]);

      /* Aggregate data_score across all agents for this user — single
         "knowledge completeness" indicator for the dashboard. NULL if
         user has no agents yet. */
      const dataScore = await query(`
        SELECT ROUND(AVG(cl.data_score)) as avg_data_score
        FROM tenants t
        LEFT JOIN clients cl ON cl.id = t.client_id
        WHERE t.user_id = $1 AND cl.data_score IS NOT NULL
      `, [req.params.id]);

      res.json({
        customer: user.rows[0],
        agents: agents.rows,
        conversations: conversations.rows,
        emails: emails.rows,
        status: {
          email_verified: user.rows[0].email_verified || false,
          plan: user.rows[0].plan || 'trial',
          plan_active: user.rows[0].plan_active || false,
          plan_expires_at: user.rows[0].plan_expires_at,
          trial_ends_at: user.rows[0].trial_ends_at,
          account_type: user.rows[0].account_type || 'provider',
          agent_package: user.rows[0].agent_package || 'starter',
          stripe_customer_id: user.rows[0].stripe_customer_id || null,
          stripe_subscription_id: user.rows[0].stripe_subscription_id || null,
          tenant_count: agents.rows.length,
          last_login_at: lastLogin.rows[0]?.last_login_at || null,
          avg_data_score: dataScore.rows[0]?.avg_data_score !== null
            ? parseInt(dataScore.rows[0].avg_data_score) : null
        }
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
      where += ` AND (t.agent_name ILIKE $${paramIdx} OR t.name ILIKE $${paramIdx} OR t.client_token ILIKE $${paramIdx} OR u.name ILIKE $${paramIdx})`;
      params.push('%' + search + '%');
      paramIdx++;
    }
    if (filter && filter !== 'all') {
      where += ` AND cl.vertical = $${paramIdx}`;
      params.push(filter);
      paramIdx++;
    }

    try {
      const countResult = await query(`
        SELECT COUNT(*) as count FROM tenants t
        LEFT JOIN clients cl ON cl.id = t.client_id
        LEFT JOIN users u ON u.id = t.user_id
        ${where}
      `, params);
      const total = parseInt(countResult.rows[0]?.count || 0);

      const result = await query(`
        SELECT t.id, t.name, t.agent_name, t.minutes_used_this_month,
               t.created_at, t.user_id, t.active,
               t.client_token,
               cl.vertical,
               u.name as customer_name, u.email as customer_email,
               COUNT(DISTINCT c.id) as conversations,
               COUNT(DISTINCT CASE WHEN c.had_booking_click = true THEN c.id END) as conversions
        FROM tenants t
        LEFT JOIN clients cl ON cl.id = t.client_id
        LEFT JOIN users u ON u.id = t.user_id
        LEFT JOIN conversations c ON c.tenant_id = t.id AND c.created_at > NOW() - INTERVAL '30 days'
        ${where}
        GROUP BY t.id, cl.vertical, u.name, u.email
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
        SELECT t.*, cl.vertical,
               u.name as customer_name, u.email as customer_email
        FROM tenants t
        LEFT JOIN clients cl ON cl.id = t.client_id
        LEFT JOIN users u ON u.id = t.user_id
        WHERE t.id = $1
      `, [req.params.id]);
      if (agent.rows.length === 0) return res.status(404).json({ error: 'Not found' });

      const conversations = await query(`
        SELECT id, created_at, duration_seconds, messages_count,
               had_booking_click, conversion_stage
        FROM conversations WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT 50
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
    if (converted === 'true') {
      where += " AND (c.had_booking_click = true OR c.conversion_stage = 'converted')";
    } else if (converted === 'false') {
      where += " AND c.had_booking_click = false AND c.conversion_stage != 'converted'";
    }

    try {
      const countResult = await query(`SELECT COUNT(*) as count FROM conversations c ${where}`, params);
      const total = parseInt(countResult.rows[0]?.count || 0);

      const result = await query(`
        SELECT c.id, c.tenant_id, c.created_at, c.duration_seconds, c.messages_count,
               c.had_booking_click, c.conversion_stage, c.guest_name, c.guest_email,
               t.agent_name, t.name as tenant_name,
               u.name as customer_name
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
        SELECT c.*, t.agent_name, t.name as tenant_name,
               u.name as customer_name
        FROM conversations c
        LEFT JOIN tenants t ON c.tenant_id = t.id
        LEFT JOIN users u ON t.user_id = u.id
        WHERE c.id = $1
      `, [req.params.id]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });

      // Fetch messages from conversation_messages table
      const messages = await query(`
        SELECT role, content, created_at
        FROM conversation_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
      `, [req.params.id]);

      const convo = result.rows[0];
      convo.transcript = messages.rows;
      res.json(convo);
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
               COALESCE(SUM(ac.commission_amount), 0) as total_commission
        FROM affiliates a
        LEFT JOIN users u ON u.affiliate_ref = a.ref_code AND u.affiliate_confirmed = true
        LEFT JOIN affiliate_commissions ac ON ac.affiliate_ref = a.ref_code
        GROUP BY a.id
        ORDER BY a.created_at DESC
      `);

      // Summary using status field (not paid boolean)
      const summary = await query(`
        SELECT
          COALESCE(SUM(CASE WHEN ac.created_at > DATE_TRUNC('month', NOW()) THEN ac.commission_amount ELSE 0 END), 0) as this_month,
          COALESCE(SUM(CASE WHEN ac.status = 'paid' THEN ac.commission_amount ELSE 0 END), 0) as total_paid,
          COALESCE(SUM(CASE WHEN ac.status = 'pending' THEN ac.commission_amount ELSE 0 END), 0) as pending
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
      const apiCost = Math.round(totalMinutes * 0.15 * 100) / 100;

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
     Conversations don't have error_message column,
     so we look for failed conversion stages or short sessions
     ═══════════════════════════════════════ */
  router.get('/errors', async (req, res) => {
    try {
      // Since there's no error_message column, show conversations
      // that may indicate issues (very short sessions, drop-offs)
      const result = await query(`
        SELECT c.id, c.created_at, c.tenant_id, c.duration_seconds,
               c.messages_count, c.drop_off_turn,
               t.agent_name, t.name as tenant_name
        FROM conversations c
        LEFT JOIN tenants t ON c.tenant_id = t.id
        WHERE c.duration_seconds > 0 AND c.duration_seconds < 5
              AND c.messages_count >= 1
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
      // Production schema uses t.model_id (Matterport model id). Alias it as
      // matterport_model_id so the existing admin.js client code keeps working.
      const result = await query(`
        SELECT t.id, t.name, t.agent_name, t.property_data, t.room_mappings,
               t.model_id AS matterport_model_id, t.hotel_url,
               COALESCE(t.conversion_url, t.booking_url) AS conversion_url,
               COALESCE(t.language, 'en') AS language,
               t.compiled_context,
               t.property_details,
               cl.vertical
        FROM tenants t
        LEFT JOIN clients cl ON cl.id = t.client_id
        ORDER BY t.agent_name NULLS LAST, t.name
      `);
      res.json(result.rows);
    } catch(e) {
      console.error('Tenants query error:', e.message);
      // Minimal fallback — drop any columns that may be missing in dev DBs
      try {
        const fallback = await query(`
          SELECT t.id, t.name, t.agent_name, t.property_data, t.room_mappings,
                 cl.vertical
          FROM tenants t
          LEFT JOIN clients cl ON cl.id = t.client_id
          ORDER BY t.agent_name NULLS LAST, t.name
        `);
        res.json(fallback.rows);
      } catch(e2) {
        console.error('Tenants fallback query error:', e2.message);
        res.json([]);
      }
    }
  });

  /* ═══════════════════════════════════════
     TENANT RESET — preview (dry-run counts)
     ═══════════════════════════════════════
     GET /api/monitoring/tenants/:id/reset-preview
     Returns the exact counts that would be affected by a reset
     without mutating any data. Safe to call from the UI. */
  router.get('/tenants/:id/reset-preview', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    const tenantId = req.params.id;
    if (!tenantId) return res.status(400).json({ error: 'tenant id required' });

    try {
      // 1. Tenant info (for confirmation + UI display)
      const tenant = await query(`
        SELECT t.id, t.name, t.agent_name, t.user_id, t.minutes_used_this_month,
               COALESCE(t.minutes_quota, 0) as minutes_quota,
               u.name as customer_name, u.email as customer_email
        FROM tenants t
        LEFT JOIN users u ON u.id = t.user_id
        WHERE t.id = $1
      `, [tenantId]);
      if (tenant.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });

      // 2. Conversation count
      const convoCount = await query(
        'SELECT COUNT(*)::int AS c FROM conversations WHERE tenant_id = $1',
        [tenantId]
      );

      // 3. Message count (join through conversations)
      const msgCount = await query(`
        SELECT COUNT(*)::int AS c
        FROM conversation_messages
        WHERE conversation_id IN (SELECT id FROM conversations WHERE tenant_id = $1)
      `, [tenantId]);

      // 4. voice_usage count (may not exist on every db — guard with try)
      let voiceUsageCount = 0;
      try {
        const vu = await pool.query(
          'SELECT COUNT(*)::int AS c FROM voice_usage WHERE tenant_id = $1',
          [tenantId]
        );
        voiceUsageCount = parseInt(vu.rows[0]?.c || 0);
      } catch (e) {
        // Table may not exist — leave at 0
      }

      // 5. monthly_usage row for this user + current month
      let monthlyUsage = null;
      const userId = tenant.rows[0].user_id;
      if (userId) {
        try {
          const mu = await pool.query(
            `SELECT total_seconds, total_sessions, total_cost_cents
             FROM monthly_usage
             WHERE user_id = $1 AND month = to_char(NOW(), 'YYYY-MM')`,
            [userId]
          );
          if (mu.rows.length > 0) monthlyUsage = mu.rows[0];
        } catch (e) {
          // Table may not exist
        }
      }

      res.json({
        tenant: tenant.rows[0],
        counts: {
          conversations: parseInt(convoCount.rows[0]?.c || 0),
          messages: parseInt(msgCount.rows[0]?.c || 0),
          voiceUsageSessions: voiceUsageCount,
          minutesUsedThisMonth: parseInt(tenant.rows[0].minutes_used_this_month || 0),
          monthlyUsage: monthlyUsage
        }
      });
    } catch (e) {
      console.error('[RESET-PREVIEW] Error:', e.message);
      res.status(500).json({ error: 'Preview failed: ' + e.message });
    }
  });

  /* ═══════════════════════════════════════
     TENANT RESET — destructive reset in a transaction
     ═══════════════════════════════════════
     POST /api/monitoring/tenants/:id/reset-usage
     Body:
       confirmToken (string, required): must match tenant.id — prevents blind POSTs
       scope (object, optional): {
         deleteConversations: bool (default true),
         deleteVoiceUsage:    bool (default true),
         resetTenantMinutes:  bool (default true),
         resetMonthlyUsage:   bool (default true)
       }
     Uses a single pg client with BEGIN/COMMIT. Rolls back on any error. */
  router.post('/tenants/:id/reset-usage', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'Database not configured' });
    const tenantId = req.params.id;
    if (!tenantId) return res.status(400).json({ error: 'tenant id required' });

    const body = req.body || {};
    const confirmToken = body.confirmToken;
    if (!confirmToken || String(confirmToken) !== String(tenantId)) {
      return res.status(400).json({
        error: 'confirmToken must equal the tenant id to authorize a destructive reset'
      });
    }

    const scope = {
      deleteConversations: body.scope?.deleteConversations !== false,
      deleteVoiceUsage:    body.scope?.deleteVoiceUsage    !== false,
      resetTenantMinutes:  body.scope?.resetTenantMinutes  !== false,
      resetMonthlyUsage:   body.scope?.resetMonthlyUsage   !== false,
    };

    const client = await pool.connect();
    const deleted = {
      messages: 0,
      conversations: 0,
      voiceUsageSessions: 0,
      tenantMinutesReset: false,
      monthlyUsageReset: false
    };

    try {
      await client.query('BEGIN');

      // Lookup tenant + user_id inside the transaction for a consistent snapshot
      const tenantRes = await client.query(
        'SELECT id, name, agent_name, user_id, minutes_used_this_month FROM tenants WHERE id = $1',
        [tenantId]
      );
      if (tenantRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Tenant not found' });
      }
      const tenant = tenantRes.rows[0];
      const userId = tenant.user_id;

      // 1. Delete conversation_messages (FK cascade target)
      if (scope.deleteConversations) {
        const msgDel = await client.query(`
          DELETE FROM conversation_messages
          WHERE conversation_id IN (SELECT id FROM conversations WHERE tenant_id = $1)
        `, [tenantId]);
        deleted.messages = msgDel.rowCount || 0;

        // 2. Delete conversations
        const convoDel = await client.query(
          'DELETE FROM conversations WHERE tenant_id = $1',
          [tenantId]
        );
        deleted.conversations = convoDel.rowCount || 0;
      }

      // 3. Delete voice_usage sessions (if table exists)
      if (scope.deleteVoiceUsage) {
        try {
          const vuDel = await client.query(
            'DELETE FROM voice_usage WHERE tenant_id = $1',
            [tenantId]
          );
          deleted.voiceUsageSessions = vuDel.rowCount || 0;
        } catch (e) {
          // voice_usage may not exist — log and continue inside the transaction
          console.warn('[RESET] voice_usage delete skipped:', e.message);
        }
      }

      // 4. Reset per-tenant monthly minute counter
      if (scope.resetTenantMinutes) {
        await client.query(`
          UPDATE tenants
             SET minutes_used_this_month = 0, updated_at = NOW()
           WHERE id = $1
        `, [tenantId]);
        deleted.tenantMinutesReset = true;
      }

      // 5. Reset user-level monthly_usage for current month (if table exists and userId known)
      if (scope.resetMonthlyUsage && userId) {
        try {
          const muRes = await client.query(`
            UPDATE monthly_usage
               SET total_seconds = 0, total_sessions = 0, total_cost_cents = 0
             WHERE user_id = $1
               AND month = to_char(NOW(), 'YYYY-MM')
          `, [userId]);
          deleted.monthlyUsageReset = (muRes.rowCount || 0) > 0;
        } catch (e) {
          console.warn('[RESET] monthly_usage update skipped:', e.message);
        }
      }

      // 6. Verify post-state (still inside the tx so the SELECT sees the deletes)
      const verifyConvos = await client.query(
        'SELECT COUNT(*)::int AS c FROM conversations WHERE tenant_id = $1',
        [tenantId]
      );
      const verifyMinutes = await client.query(
        'SELECT minutes_used_this_month FROM tenants WHERE id = $1',
        [tenantId]
      );
      const conversationsLeft = parseInt(verifyConvos.rows[0]?.c || 0);
      const minutesLeft = parseInt(verifyMinutes.rows[0]?.minutes_used_this_month || 0);

      // Safety: if we were asked to delete conversations and/or reset minutes,
      // but verification doesn't confirm, roll back.
      const convoFail = scope.deleteConversations && conversationsLeft > 0;
      const minutesFail = scope.resetTenantMinutes && minutesLeft > 0;
      if (convoFail || minutesFail) {
        await client.query('ROLLBACK');
        return res.status(500).json({
          error: 'Verification failed — rolled back',
          conversationsLeft,
          minutesLeft
        });
      }

      await client.query('COMMIT');

      console.log('[RESET]', {
        tenantId,
        tenantName: tenant.agent_name || tenant.name,
        userId,
        scope,
        deleted
      });

      res.json({
        ok: true,
        tenant: { id: tenant.id, name: tenant.name, agent_name: tenant.agent_name },
        scope,
        deleted,
        verification: { conversationsLeft, minutesLeft }
      });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (rbErr) {}
      console.error('[RESET] Error — rolled back:', e.message);
      res.status(500).json({ error: 'Reset failed (rolled back): ' + e.message });
    } finally {
      client.release();
    }
  });

  /* ═══════════════════════════════════════
     DELETE users — hard wipe. Guarded against
     protected accounts (kontakt@eb-media.dk,
     any admin role).
     ═══════════════════════════════════════ */
  router.post('/users/delete', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'DB not connected' });
    const ids = Array.isArray(req.body && req.body.userIds) ? req.body.userIds : null;
    if (!ids || ids.length === 0) return res.status(400).json({ error: 'userIds[] required' });
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!ids.every(function(i) { return typeof i === 'string' && UUID.test(i); })) {
      return res.status(400).json({ error: 'userIds must be valid UUIDs' });
    }

    const rowsRes = await query('SELECT id, email, role FROM users WHERE id = ANY($1)', [ids]);
    const rows = rowsRes.rows || [];
    const PROTECTED = new Set(['kontakt@eb-media.dk']);
    const blocked = rows.filter(function(r) { return PROTECTED.has(r.email) || r.role === 'admin'; });
    if (blocked.length) {
      return res.status(403).json({
        error: 'Refusing to delete protected account(s)',
        protected: blocked.map(function(r) { return r.email; })
      });
    }

    const deleted = [];
    for (const r of rows) {
      const uid = r.id;
      try {
        await query('DELETE FROM email_tokens WHERE user_id = $1', [uid]);
        await query('DELETE FROM sessions WHERE user_id = $1', [uid]);
        await query('DELETE FROM conversation_messages WHERE tenant_id IN (SELECT id FROM tenants WHERE user_id = $1)', [uid]);
        await query('DELETE FROM conversion_events WHERE tenant_id IN (SELECT id FROM tenants WHERE user_id = $1)', [uid]);
        await query('DELETE FROM conversations WHERE tenant_id IN (SELECT id FROM tenants WHERE user_id = $1)', [uid]);
        await query('DELETE FROM data_gaps WHERE tenant_id IN (SELECT id FROM tenants WHERE user_id = $1)', [uid]);
        await query('DELETE FROM voice_usage WHERE user_id = $1', [uid]);
        await query('DELETE FROM monthly_usage WHERE user_id = $1', [uid]);
        await query('DELETE FROM affiliate_commissions WHERE user_id = $1', [uid]);
        await query('DELETE FROM followups WHERE user_id = $1', [uid]);
        await query('DELETE FROM tenants WHERE user_id = $1', [uid]);
        await query('DELETE FROM clients WHERE user_id = $1', [uid]);
        await query('DELETE FROM users WHERE id = $1', [uid]);
        deleted.push({ id: uid, email: r.email });
      } catch (e) {
        return res.status(500).json({ error: 'Failed on ' + r.email + ': ' + e.message, deleted: deleted });
      }
    }
    res.json({
      ok: true,
      deleted: deleted,
      requested: ids.length,
      notFound: ids.filter(function(i) { return !rows.some(function(r) { return r.id === i; }); })
    });
  });

  return router;
};
