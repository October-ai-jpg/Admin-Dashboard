/* ═══════════════════════════════════════════════
   OCTOBER AI — ADMIN DASHBOARD JS
   ═══════════════════════════════════════════════ */

var TOKEN = localStorage.getItem('october_admin_token');
if (!TOKEN) window.location.href = '/';

var CURRENT_PAGE = 'overview';
var REFRESH_INTERVAL = null;
var CHARTS = {};

/* ── Auth helper ── */
function api(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'x-admin-token': TOKEN, 'Content-Type': 'application/json' }, opts.headers || {});
  return fetch(url, opts).then(function(r) {
    if (r.status === 401) { logout(); throw new Error('Unauthorized'); }
    return r.json();
  });
}

function logout() {
  localStorage.removeItem('october_admin_token');
  window.location.href = '/';
}

/* ── Sidebar navigation ── */
document.querySelectorAll('.sidebar-link[data-page]').forEach(function(link) {
  link.addEventListener('click', function() {
    navigateTo(this.getAttribute('data-page'));
  });
});

document.getElementById('sidebarToggle').addEventListener('click', function() {
  document.getElementById('sidebar').classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed');
});

function navigateTo(page) {
  CURRENT_PAGE = page;
  // Update sidebar
  document.querySelectorAll('.sidebar-link').forEach(function(l) { l.classList.remove('active'); });
  var activeLink = document.querySelector('[data-page="' + page + '"]');
  if (activeLink) activeLink.classList.add('active');
  // Show page
  document.querySelectorAll('.page-container').forEach(function(p) { p.style.display = 'none'; });
  var container = document.getElementById('page-' + page);
  if (container) { container.style.display = 'block'; }
  // Load page content
  loadPage(page);
  // Clear auto-refresh
  if (REFRESH_INTERVAL) clearInterval(REFRESH_INTERVAL);
  if (page === 'overview') REFRESH_INTERVAL = setInterval(function() { loadPage('overview'); }, 60000);
  if (page === 'health') REFRESH_INTERVAL = setInterval(function() { loadPage('health'); }, 30000);
}

/* ── Page loader ── */
function loadPage(page) {
  switch(page) {
    case 'overview': loadOverview(); break;
    case 'customers': loadCustomers(); break;
    case 'agents': loadAgents(); break;
    case 'conversations': loadConversations(); break;
    case 'affiliates': loadAffiliates(); break;
    case 'revenue': loadRevenue(); break;
    case 'health': loadHealth(); break;
    case 'sandbox': loadSandbox(); break;
    case 'prompts': loadPrompts(); break;
    case 'configurations': loadConfigurations(); break;
    case 'test-history': loadTestHistory(); break;
  }
}

/* ── Escape HTML ── */
function esc(s) { if (!s) return ''; var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

/* ── Format numbers ── */
function fmtNum(n) { return (n || 0).toLocaleString(); }
function fmtMoney(n) { return '$' + (n || 0).toLocaleString(); }
function fmtDuration(s) {
  if (!s || s <= 0) return '0s';
  var m = Math.floor(s / 60), r = Math.round(s % 60);
  return m === 0 ? r + 's' : m + 'm ' + r + 's';
}
function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ── Toast ── */
function showToast(msg, type) {
  var el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast' + (type === 'error' ? ' error' : '') + (type === 'success' ? ' success' : '');
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 2500);
}

/* ═══════════════════════════════════════════════
   OVERVIEW
   ═══════════════════════════════════════════════ */
function loadOverview() {
  var c = document.getElementById('page-overview');

  api('/api/monitoring/overview').then(function(data) {
    var html = '<div class="page-label">PLATFORM OVERVIEW</div>'
      + '<h1 class="page-heading">October AI — Live Dashboard</h1>'
      + '<p class="page-sub">Auto-refreshes every 60 seconds</p>'
      + '<div class="kpi-grid">'
      + kpiCard('Total Customers', fmtNum(data.customers))
      + kpiCard('Active Agents', fmtNum(data.agents))
      + kpiCard('Conversations (30d)', fmtNum(data.conversations))
      + kpiCard('Active Affiliates', fmtNum(data.affiliates))
      + kpiCard('MRR', fmtMoney(data.mrr))
      + kpiCard('Minutes Used', fmtNum(data.minutesUsed))
      + kpiCard('Conversion Rate', data.conversionRate + '%')
      + kpiCard('Avg Session', fmtDuration(data.avgSessionDuration))
      + '</div>'
      + '<div class="chart-grid">'
      + '<div class="chart-card"><h3>Conversations (30 days)</h3><canvas id="chartConvos"></canvas></div>'
      + '<div class="chart-card"><h3>MRR Over Time</h3><canvas id="chartMRR"></canvas></div>'
      + '<div class="chart-card"><h3>Conversion Rate (30 days)</h3><canvas id="chartConvRate"></canvas></div>'
      + '</div>';
    c.innerHTML = html;

    // Load charts
    api('/api/monitoring/overview/charts').then(function(charts) {
      renderChart('chartConvos', 'line',
        charts.conversationsPerDay.map(function(r) { return fmtDateShort(r.day); }),
        charts.conversationsPerDay.map(function(r) { return parseInt(r.count); }),
        'Conversations'
      );
      renderChart('chartMRR', 'bar',
        charts.mrrOverTime.map(function(r) { return r.month; }),
        charts.mrrOverTime.map(function(r) { return parseInt(r.new_users) * 149; }),
        'MRR ($)'
      );
      renderChart('chartConvRate', 'line',
        charts.conversionRatePerDay.map(function(r) { return fmtDateShort(r.day); }),
        charts.conversionRatePerDay.map(function(r) { return r.rate; }),
        'Conversion %'
      );
    });
  });
}

function kpiCard(label, value) {
  return '<div class="kpi-card"><div class="kpi-label">' + label + '</div><div class="kpi-value">' + value + '</div></div>';
}

function renderChart(id, type, labels, data, label) {
  var ctx = document.getElementById(id);
  if (!ctx) return;
  if (CHARTS[id]) CHARTS[id].destroy();

  var color = '#1A1A1A';
  var bgColor = 'rgba(26,26,26,0.08)';

  CHARTS[id] = new Chart(ctx, {
    type: type,
    data: {
      labels: labels,
      datasets: [{
        label: label,
        data: data,
        borderColor: color,
        backgroundColor: type === 'bar' ? color : bgColor,
        borderWidth: 2,
        fill: type === 'line',
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { font: { size: 10 } } }
      }
    }
  });
}

/* ═══════════════════════════════════════════════
   CUSTOMERS
   ═══════════════════════════════════════════════ */
var customersState = { page: 1, search: '', filter: '' };

function loadCustomers() {
  var c = document.getElementById('page-customers');
  var q = 'page=' + customersState.page + '&limit=25';
  if (customersState.search) q += '&search=' + encodeURIComponent(customersState.search);
  if (customersState.filter) q += '&filter=' + customersState.filter;

  api('/api/monitoring/customers?' + q).then(function(data) {
    var html = '<div class="page-label">CUSTOMERS</div>'
      + '<h1 class="page-heading">All Customers</h1>'
      + '<p class="page-sub">View and manage your customer base.</p>'
      + '<div class="table-controls">'
      + '<input class="search-input" placeholder="Search by name or email..." value="' + esc(customersState.search) + '" onkeyup="if(event.key===\'Enter\'){customersState.search=this.value;customersState.page=1;loadCustomers()}">'
      + filterBtn('All', '', 'customers') + filterBtn('Active', 'active', 'customers') + filterBtn('Inactive', 'inactive', 'customers')
      + '</div>'
      + '<table class="data-table"><thead><tr>'
      + '<th>Name</th><th>Email</th><th>Status</th><th>Agents</th><th>Conversations</th><th>Minutes</th><th>Since</th>'
      + '</tr></thead><tbody>';

    data.customers.forEach(function(cu) {
      html += '<tr onclick="showCustomerDetail(\'' + cu.id + '\')">'
        + '<td>' + esc(cu.name) + '</td>'
        + '<td>' + esc(cu.email) + '</td>'
        + '<td>' + (cu.plan_active ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>') + '</td>'
        + '<td>' + (cu.agent_count || 0) + '</td>'
        + '<td>' + (cu.conversation_count || 0) + '</td>'
        + '<td>' + (cu.minutes_used || 0) + '</td>'
        + '<td>' + fmtDate(cu.created_at) + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    html += pagination(data.page, data.pages, 'customers');
    html += '<div class="detail-overlay" id="customerDetail"><button class="detail-close" onclick="closeDetail(\'customerDetail\')">&times;</button><div id="customerDetailContent"></div></div>';
    c.innerHTML = html;
  });
}

function showCustomerDetail(id) {
  api('/api/monitoring/customers/' + id).then(function(data) {
    var cu = data.customer;
    var html = '<div class="detail-title">' + esc(cu.name) + '</div>'
      + '<div class="detail-subtitle">' + esc(cu.email) + '</div>'
      + '<div class="detail-section"><h4>Account</h4>'
      + detailRow('Status', cu.plan_active ? 'Active' : 'Inactive')
      + detailRow('Since', fmtDate(cu.created_at))
      + detailRow('Affiliate Ref', cu.affiliate_ref || 'None')
      + '</div>'
      + '<div class="detail-section"><h4>Agents (' + data.agents.length + ')</h4>';
    data.agents.forEach(function(a) {
      html += detailRow(esc(a.agent_name || a.name || 'Agent'), (a.conversation_count || 0) + ' conversations');
    });
    html += '</div>'
      + '<div class="detail-section"><h4>Recent Conversations</h4>';
    data.conversations.slice(0, 10).forEach(function(cv) {
      var cvConverted = cv.had_booking_click || cv.conversion_stage === 'converted';
      html += detailRow(fmtDate(cv.created_at), fmtDuration(cv.duration_seconds) + (cvConverted ? ' (converted)' : ''));
    });
    html += '</div>';

    document.getElementById('customerDetailContent').innerHTML = html;
    document.getElementById('customerDetail').classList.add('open');
  });
}

/* ═══════════════════════════════════════════════
   AGENTS
   ═══════════════════════════════════════════════ */
var agentsState = { page: 1, search: '', filter: '' };

function loadAgents() {
  var c = document.getElementById('page-agents');
  var q = 'page=' + agentsState.page + '&limit=25';
  if (agentsState.search) q += '&search=' + encodeURIComponent(agentsState.search);
  if (agentsState.filter) q += '&filter=' + agentsState.filter;

  api('/api/monitoring/agents?' + q).then(function(data) {
    var html = '<div class="page-label">AGENTS</div>'
      + '<h1 class="page-heading">All Agents</h1>'
      + '<p class="page-sub">Every agent across all customers.</p>'
      + '<div class="table-controls">'
      + '<input class="search-input" placeholder="Search agents..." value="' + esc(agentsState.search) + '" onkeyup="if(event.key===\'Enter\'){agentsState.search=this.value;agentsState.page=1;loadAgents()}">'
      + filterBtn('All', '', 'agents') + filterBtn('Hotel', 'hotel', 'agents') + filterBtn('Education', 'education', 'agents') + filterBtn('Real Estate', 'real_estate_sale', 'agents')
      + '</div>'
      + '<table class="data-table"><thead><tr>'
      + '<th>Agent Name</th><th>Customer</th><th>Vertical</th><th>Conversations</th><th>Conversions</th><th>Rate</th><th>Minutes</th>'
      + '</tr></thead><tbody>';

    data.agents.forEach(function(a) {
      var rate = parseInt(a.conversations) > 0 ? Math.round((parseInt(a.conversions) / parseInt(a.conversations)) * 100) : 0;
      html += '<tr onclick="showAgentDetail(\'' + a.id + '\')">'
        + '<td>' + esc(a.agent_name || a.name || 'Agent') + '</td>'
        + '<td>' + esc(a.customer_name || '-') + '</td>'
        + '<td>' + esc(a.vertical || '-') + '</td>'
        + '<td>' + (a.conversations || 0) + '</td>'
        + '<td>' + (a.conversions || 0) + '</td>'
        + '<td>' + rate + '%</td>'
        + '<td>' + (a.minutes_used_this_month || 0) + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    html += pagination(data.page, data.pages, 'agents');
    html += '<div class="detail-overlay" id="agentDetail"><button class="detail-close" onclick="closeDetail(\'agentDetail\')">&times;</button><div id="agentDetailContent"></div></div>';
    c.innerHTML = html;
  });
}

function showAgentDetail(id) {
  api('/api/monitoring/agents/' + id).then(function(data) {
    var a = data.agent;
    var html = '<div class="detail-title">' + esc(a.agent_name || a.name || 'Agent') + '</div>'
      + '<div class="detail-subtitle">' + esc(a.customer_name) + ' &middot; ' + esc(a.customer_email) + '</div>'
      + '<div class="detail-section"><h4>Details</h4>'
      + detailRow('Vertical', a.vertical || '-')
      + detailRow('Minutes Used', a.minutes_used_this_month || 0)
      + detailRow('Created', fmtDate(a.created_at))
      + '</div>';

    if (a.room_mappings) {
      html += '<div class="detail-section"><h4>Room Mappings</h4><pre style="font-size:12px;overflow-x:auto;background:var(--cream);padding:12px;border-radius:8px">' + esc(JSON.stringify(a.room_mappings, null, 2)) + '</pre></div>';
    }

    html += '<div class="detail-section"><h4>Recent Conversations</h4>';
    data.conversations.slice(0, 10).forEach(function(cv) {
      var agentCvConverted = cv.had_booking_click || cv.conversion_stage === 'converted';
      html += detailRow(fmtDate(cv.created_at), fmtDuration(cv.duration_seconds) + (agentCvConverted ? ' (converted)' : ''));
    });
    html += '</div>';

    document.getElementById('agentDetailContent').innerHTML = html;
    document.getElementById('agentDetail').classList.add('open');
  });
}

/* ═══════════════════════════════════════════════
   CONVERSATIONS
   ═══════════════════════════════════════════════ */
var convosState = { page: 1, agent: '', converted: '' };

function loadConversations() {
  var c = document.getElementById('page-conversations');
  var q = 'page=' + convosState.page + '&limit=25';
  if (convosState.agent) q += '&agent=' + convosState.agent;
  if (convosState.converted) q += '&converted=' + convosState.converted;

  api('/api/monitoring/conversations?' + q).then(function(data) {
    var html = '<div class="page-label">CONVERSATIONS</div>'
      + '<h1 class="page-heading">All Conversations</h1>'
      + '<p class="page-sub">Every conversation across the platform.</p>'
      + '<div class="table-controls">'
      + filterBtn('All', '', 'convos') + filterBtn('Converted', 'true', 'convos') + filterBtn('Not Converted', 'false', 'convos')
      + '</div>'
      + '<table class="data-table"><thead><tr>'
      + '<th>Date</th><th>Agent</th><th>Customer</th><th>Duration</th><th>Messages</th><th>Converted</th>'
      + '</tr></thead><tbody>';

    data.conversations.forEach(function(cv) {
      var isConverted = cv.had_booking_click || cv.conversion_stage === 'converted';
      html += '<tr onclick="showConversationDetail(\'' + cv.id + '\')">'
        + '<td>' + fmtDate(cv.created_at) + '</td>'
        + '<td>' + esc(cv.agent_name || cv.tenant_name || '-') + '</td>'
        + '<td>' + esc(cv.customer_name || '-') + '</td>'
        + '<td>' + fmtDuration(cv.duration_seconds) + '</td>'
        + '<td>' + (cv.messages_count || '-') + '</td>'
        + '<td>' + (isConverted ? '<span class="badge badge-active">Yes</span>' : '<span class="badge badge-inactive">No</span>') + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    html += pagination(data.page, data.pages, 'convos');
    html += '<div class="detail-overlay" id="convoDetail"><button class="detail-close" onclick="closeDetail(\'convoDetail\')">&times;</button><div id="convoDetailContent"></div></div>';
    c.innerHTML = html;
  });
}

function showConversationDetail(id) {
  api('/api/monitoring/conversations/' + id).then(function(cv) {
    var isConverted = cv.had_booking_click || cv.conversion_stage === 'converted';
    var html = '<div class="detail-title">Conversation</div>'
      + '<div class="detail-subtitle">' + fmtDate(cv.created_at) + ' &middot; ' + esc(cv.agent_name || cv.tenant_name || 'Unknown Agent') + '</div>'
      + '<div class="detail-section"><h4>Details</h4>'
      + detailRow('Duration', fmtDuration(cv.duration_seconds))
      + detailRow('Messages', cv.messages_count || 0)
      + detailRow('Converted', isConverted ? 'Yes' : 'No')
      + detailRow('Stage', cv.conversion_stage || '-')
      + detailRow('Customer', cv.customer_name || '-')
      + detailRow('Guest', cv.guest_name || '-')
      + '</div>';

    if (cv.transcript) {
      html += '<div class="detail-section"><h4>Transcript</h4>'
        + '<div class="transcript-panel">';
      try {
        var msgs = typeof cv.transcript === 'string' ? JSON.parse(cv.transcript) : cv.transcript;
        if (Array.isArray(msgs)) {
          msgs.forEach(function(m) {
            html += '<div class="transcript-msg"><span class="role ' + (m.role || 'user') + '">[' + (m.role || 'user') + ']</span>' + esc(m.content || m.text || '') + '</div>';
          });
        }
      } catch(e) {
        html += '<pre style="font-size:12px;white-space:pre-wrap">' + esc(typeof cv.transcript === 'string' ? cv.transcript : JSON.stringify(cv.transcript)) + '</pre>';
      }
      html += '</div></div>';
    }

    document.getElementById('convoDetailContent').innerHTML = html;
    document.getElementById('convoDetail').classList.add('open');
  });
}

/* ═══════════════════════════════════════════════
   AFFILIATES
   ═══════════════════════════════════════════════ */
function loadAffiliates() {
  var c = document.getElementById('page-affiliates');

  api('/api/monitoring/affiliates').then(function(data) {
    var s = data.summary;
    var html = '<div class="page-label">AFFILIATES</div>'
      + '<h1 class="page-heading">Affiliate Partners</h1>'
      + '<p class="page-sub">Performance and commission tracking.</p>'
      + '<div class="kpi-grid">'
      + kpiCard('Commission This Month', fmtMoney(s.this_month))
      + kpiCard('Total Paid Out', fmtMoney(s.total_paid))
      + kpiCard('Pending Commissions', fmtMoney(s.pending))
      + '</div>'
      + '<table class="data-table"><thead><tr>'
      + '<th>Name</th><th>Email</th><th>Ref Code</th><th>Active Clients</th><th>Total Earned</th><th>Since</th>'
      + '</tr></thead><tbody>';

    data.affiliates.forEach(function(a) {
      html += '<tr>'
        + '<td>' + esc(a.name) + '</td>'
        + '<td>' + esc(a.email) + '</td>'
        + '<td><code>' + esc(a.ref_code) + '</code></td>'
        + '<td>' + (a.active_clients || 0) + '</td>'
        + '<td>' + fmtMoney(a.total_earned) + '</td>'
        + '<td>' + fmtDate(a.created_at) + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    c.innerHTML = html;
  });
}

/* ═══════════════════════════════════════════════
   REVENUE
   ═══════════════════════════════════════════════ */
function loadRevenue() {
  var c = document.getElementById('page-revenue');

  api('/api/monitoring/revenue').then(function(data) {
    var html = '<div class="page-label">REVENUE</div>'
      + '<h1 class="page-heading">Revenue & Profit</h1>'
      + '<p class="page-sub">Monthly breakdown of revenue, costs, and profit.</p>'
      + '<div class="revenue-grid">'
      + '<div class="revenue-card"><div class="kpi-label">Subscription Revenue</div><div class="kpi-value">' + fmtMoney(data.subscriptionRevenue) + '</div></div>'
      + '<div class="revenue-card"><div class="kpi-label">Total Revenue</div><div class="kpi-value">' + fmtMoney(data.totalRevenue) + '</div></div>'
      + '<div class="revenue-card highlight"><div class="kpi-label">Net Profit</div><div class="kpi-value">' + fmtMoney(data.profit) + '</div><div style="font-size:12px;margin-top:4px;opacity:0.7">' + data.margin + '% margin</div></div>'
      + '</div>'
      + '<div class="kpi-grid">'
      + kpiCard('API Costs', fmtMoney(data.apiCosts))
      + kpiCard('Affiliate Commissions', fmtMoney(data.affiliateCommissions))
      + kpiCard('Infrastructure', fmtMoney(data.infrastructure))
      + '</div>'
      + '<div class="chart-card"><h3>Revenue Over Time (12 months)</h3><canvas id="chartRevenue" style="max-height:300px"></canvas></div>';

    c.innerHTML = html;

    if (data.chart && data.chart.length > 0) {
      renderChart('chartRevenue', 'bar',
        data.chart.map(function(r) { return r.month; }),
        data.chart.map(function(r) { return parseInt(r.revenue); }),
        'Revenue ($)'
      );
    }
  });
}

/* ═══════════════════════════════════════════════
   SYSTEM HEALTH
   ═══════════════════════════════════════════════ */
function loadHealth() {
  var c = document.getElementById('page-health');

  var html = '<div class="page-label">SYSTEM HEALTH</div>'
    + '<h1 class="page-heading">Service Status</h1>'
    + '<p class="page-sub">Live status of all services. Checks every 30 seconds.</p>'
    + '<div class="health-grid" id="healthGrid">'
    + healthCard('October AI DB', 'checking', 'database')
    + healthCard('OpenAI API', 'checking', 'openai')
    + healthCard('Deepgram API', 'checking', 'deepgram')
    + healthCard('Cartesia API', 'checking', 'cartesia')
    + '</div>'
    + '<div class="section-title">Recent Errors</div>'
    + '<div id="errorLog">Loading...</div>';
  c.innerHTML = html;

  api('/api/health-check').then(function(data) {
    Object.keys(data).forEach(function(key) {
      var el = document.getElementById('health-' + key);
      if (el) {
        var d = data[key];
        var dot = el.querySelector('.health-dot');
        var lat = el.querySelector('.health-latency');
        dot.className = 'health-dot ' + (d.status === 'online' ? 'online' : 'offline');
        lat.textContent = d.latency ? d.latency + 'ms' : d.status;
      }
    });
  });

  api('/api/monitoring/errors').then(function(errors) {
    var el = document.getElementById('errorLog');
    if (errors.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);font-size:13px">No recent errors.</p>';
      return;
    }
    var html = '<table class="data-table"><thead><tr><th>Date</th><th>Agent</th><th>Duration</th><th>Messages</th><th>Drop-off</th></tr></thead><tbody>';
    errors.forEach(function(e) {
      html += '<tr><td>' + fmtDate(e.created_at) + '</td><td>' + esc(e.agent_name || e.tenant_name || '-') + '</td><td>' + fmtDuration(e.duration_seconds) + '</td><td>' + (e.messages_count || 0) + '</td><td>Turn ' + (e.drop_off_turn || '-') + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  });
}

function healthCard(name, status, id) {
  return '<div class="health-card" id="health-' + id + '">'
    + '<div class="health-dot ' + status + '"></div>'
    + '<div><div class="health-name">' + name + '</div><div class="health-latency">Checking...</div></div>'
    + '</div>';
}

/* ═══════════════════════════════════════════════
   SANDBOX — Full Agent Builder
   ═══════════════════════════════════════════════ */
var sandboxWs = null;
var isRecording = false;
var recordingStream = null;
var recordingCtx = null;
var recordingProcessor = null;
var audioChunks = [];
var playbackCtx = null;
var incomingAudio = [];
var debugLog = [];
var wsReconnectAttempts = 0;
var roomEditorMode = 'json'; // 'json' or 'visual'
var cachedTenants = null;

function loadSandbox() {
  var c = document.getElementById('page-sandbox');

  // --- Error banner placeholder ---
  var html = '<div id="sbKeyBanner"></div>'
    + '<div class="page-label">AGENT BUILDER</div>'
    + '<h1 class="page-heading">Sandbox</h1>'
    + '<p class="page-sub">Test voice agents with your own configuration.</p>'
    + '<div class="sandbox-layout">'

    // ═══ LEFT: CONFIG PANEL ═══
    + '<div class="sandbox-config">'

    // Matterport
    + '<div class="form-group">'
    + '<label class="form-label">Matterport Model ID <span class="sb-tooltip" data-tip="Paste a Matterport model ID or full URL. Find it in your Matterport account under the model\'s share link.">?</span></label>'
    + '<div style="display:flex;gap:8px"><input class="form-input" id="sbModelId" placeholder="e.g. NCPe9NFNKew or full URL" style="flex:1">'
    + '<button class="btn btn-outline btn-sm" onclick="loadTour()">Apply</button></div>'
    + '</div>'

    // Load from Tenant
    + '<div class="form-group">'
    + '<label class="form-label">Load from Tenant <span class="sb-tooltip" data-tip="Load all settings from an existing tenant in the database — populates model ID, property data, room mappings, and vertical.">?</span></label>'
    + '<select class="form-select" id="sbTenantSelect" onchange="loadTenantData(this.value)"><option value="">— Select a tenant —</option></select>'
    + '</div>'

    // Vertical
    + '<div class="form-group">'
    + '<label class="form-label">Vertical <span class="sb-tooltip" data-tip="The business type. Determines the default system prompt and agent behavior.">?</span></label>'
    + '<select class="form-select" id="sbVertical" onchange="resetPrompt()">'
    + '<option value="hotel">Hotel</option><option value="education">Education</option><option value="retail">Retail</option>'
    + '<option value="real_estate_sale">Real Estate (Sale)</option><option value="real_estate_development">Real Estate (Development)</option><option value="other">Other</option></select></div>'

    // LLM Model
    + '<div class="form-group">'
    + '<label class="form-label">LLM Model <span class="sb-tooltip" data-tip="The OpenAI model used for generating responses. gpt-5.4-mini matches production.">?</span></label>'
    + '<select class="form-select" id="sbModel"><option value="gpt-5.4-mini">gpt-5.4-mini (production)</option><option value="gpt-4o-mini">gpt-4o-mini</option><option value="gpt-4o">gpt-4o</option><option value="gpt-4-turbo">gpt-4-turbo</option></select></div>'

    // Temperature
    + '<div class="form-group">'
    + '<label class="form-label">Temperature: <span id="sbTempVal">0.7</span> <span class="sb-tooltip" data-tip="Controls randomness. 0 = deterministic and focused. 1 = creative and varied. Production uses 0.7.">?</span></label>'
    + '<input type="range" id="sbTemp" min="0" max="1" step="0.1" value="0.7" style="width:100%" oninput="document.getElementById(\'sbTempVal\').textContent=this.value"></div>'

    // System Prompt
    + '<div class="form-group">'
    + '<label class="form-label">System Prompt <span class="sb-tooltip" data-tip="The instructions that define the agent\'s personality and behavior. This is sent as the system message to OpenAI.">?</span></label>'
    + '<textarea class="form-textarea" id="sbPrompt" rows="6" placeholder="Enter system prompt..."></textarea>'
    + '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">'
    + '<button class="btn btn-outline btn-sm" onclick="resetPrompt()">Reset to default</button>'
    + '<button class="btn btn-outline btn-sm" onclick="savePromptAsTemplate()">Save as template</button>'
    + '</div></div>'

    // Property Data
    + '<div class="form-group">'
    + '<label class="form-label">Property Data <span class="sb-tooltip" data-tip="Business information the agent will reference — rooms, prices, amenities, policies, etc. Paste manually or sync from a URL.">?</span></label>'
    + '<textarea class="form-textarea" id="sbData" rows="4" placeholder="Paste property/business data here..."></textarea>'
    + '<div style="display:flex;gap:8px;margin-top:8px;align-items:center">'
    + '<input class="form-input" id="sbSyncUrl" placeholder="https://example.com" style="flex:1;min-height:0;padding:7px 12px">'
    + '<button class="btn btn-outline btn-sm" onclick="syncFromURL()" id="sbSyncBtn">Sync</button>'
    + '</div></div>'

    // Room Mappings
    + '<div class="form-group">'
    + '<label class="form-label">Room Mappings <span class="sb-tooltip" data-tip="Maps room names to Matterport sweep IDs. The agent uses these to navigate the tour when a visitor asks to see a specific room.">?</span></label>'
    + '<div style="display:flex;gap:8px;margin-bottom:8px">'
    + '<button class="btn btn-outline btn-sm" onclick="setRoomEditorMode(\'json\')" id="rmJsonBtn" style="font-weight:600">JSON</button>'
    + '<button class="btn btn-outline btn-sm" onclick="setRoomEditorMode(\'visual\')" id="rmVisualBtn">Visual Editor</button>'
    + '</div>'
    + '<div id="roomJsonEditor"><textarea class="form-textarea" id="sbMappings" rows="3" placeholder=\'{"sweepId1": {"label": "Deluxe Room"}}\'></textarea>'
    + '<div id="sbMappingsError" style="color:var(--red);font-size:12px;margin-top:4px;display:none"></div></div>'
    + '<div id="roomVisualEditor" style="display:none">'
    + '<div id="roomList"></div>'
    + '<button class="btn btn-outline btn-sm" onclick="addRoom()" style="margin-top:8px">+ Add room</button>'
    + '<details style="margin-top:8px;font-size:12px;color:var(--muted)"><summary style="cursor:pointer">How to find Sweep IDs</summary>'
    + '<div style="padding:8px 0">1. Open your Matterport tour<br>2. Press <kbd>U</kbd> on your keyboard<br>3. Click on the location<br>4. Copy the Sweep ID shown</div></details>'
    + '</div></div>'

    // Action buttons
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">'
    + '<button class="btn btn-dark" onclick="applyAndRestart()" style="flex:1">Apply &amp; Restart Session</button>'
    + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">'
    + '<button class="btn btn-outline btn-sm" onclick="saveSandboxConfig()">Save configuration</button>'
    + '<button class="btn btn-outline btn-sm" onclick="exportSystemPrompt()">Export system prompt</button>'
    + '</div>'

    + '</div>' // end sandbox-config

    // ═══ RIGHT: LIVE PANEL ═══
    + '<div class="sandbox-live">'

    // Tour
    + '<div class="sandbox-tour" id="sbTourContainer"><div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:14px">Enter a Matterport Model ID and click Apply</div></div>'

    // Voice section
    + '<div class="sandbox-voice">'
    + '<div style="display:flex;align-items:center;gap:12px;justify-content:center">'
    + '<button class="mic-btn" id="micBtn" onclick="toggleMic()" disabled>'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
    + '</button>'
    + '<div style="flex:1;display:flex;gap:6px">'
    + '<input class="form-input" id="sbTextInput" placeholder="Type a message..." style="flex:1;min-height:0;padding:10px 14px" onkeydown="if(event.key===\'Enter\'){sendTextInput();event.preventDefault()}" disabled>'
    + '<button class="btn btn-dark btn-sm" onclick="sendTextInput()" id="sbSendBtn" disabled>Send</button>'
    + '</div></div>'
    + '<div class="voice-status" id="voiceStatus">Start a session to begin</div>'
    + '<div class="latency-bar" id="latencyBar"><span>STT: —</span><span>LLM: —</span><span>TTS: —</span><span>Total: —</span></div>'
    + '<div class="transcript-panel" id="transcriptPanel"></div>'

    // Debug panel
    + '<details class="debug-panel" id="debugPanel">'
    + '<summary>Debug Log</summary>'
    + '<div id="debugContent"><div style="color:var(--muted);font-size:12px">No turns yet.</div></div>'
    + '<button class="btn btn-outline btn-sm" onclick="clearDebugLog()" style="margin-top:8px">Clear debug log</button>'
    + '</details>'

    + '</div>' // end sandbox-voice
    + '</div>' // end sandbox-live
    + '</div>'; // end sandbox-layout

  c.innerHTML = html;

  // Init
  resetPrompt();
  loadTenantDropdown();
  checkAPIKeys();
  initTooltips();
}

/* ── API Key Banner ── */
function checkAPIKeys() {
  api('/api/check-keys').then(function(keys) {
    var missing = [];
    if (!keys.openai) missing.push('OPENAI_API_KEY');
    if (!keys.deepgram) missing.push('DEEPGRAM_API_KEY');
    if (!keys.cartesia) missing.push('CARTESIA_API_KEY');
    var banner = document.getElementById('sbKeyBanner');
    if (banner && missing.length > 0) {
      banner.innerHTML = '<div class="sb-error-banner">Missing API key' + (missing.length > 1 ? 's' : '') + ': <strong>' + missing.join(', ') + '</strong> — add ' + (missing.length > 1 ? 'them' : 'it') + ' in Railway Variables</div>';
    } else if (banner) {
      banner.innerHTML = '';
    }
  }).catch(function() {});
}

/* ── Tooltips ── */
function initTooltips() {
  document.querySelectorAll('.sb-tooltip').forEach(function(el) {
    el.addEventListener('mouseenter', function(e) {
      var tip = document.createElement('div');
      tip.className = 'tooltip-popup';
      tip.textContent = e.target.getAttribute('data-tip');
      document.body.appendChild(tip);
      var r = e.target.getBoundingClientRect();
      tip.style.left = Math.min(r.left, window.innerWidth - 280) + 'px';
      tip.style.top = (r.bottom + 6) + 'px';
      e.target._tip = tip;
    });
    el.addEventListener('mouseleave', function(e) {
      if (e.target._tip) { e.target._tip.remove(); e.target._tip = null; }
    });
  });
}

/* ── Matterport Tour ── */
function loadTour() {
  var raw = (document.getElementById('sbModelId').value || '').trim();
  if (!raw) { showToast('Enter a Model ID or URL', 'error'); return; }
  // Extract model ID from URL if pasted
  var modelId = raw;
  var match = raw.match(/[?&]m=([^&]+)/);
  if (match) modelId = match[1];
  // Also handle direct Matterport URLs like my.matterport.com/show/?m=XXX
  if (raw.includes('matterport.com') && !match) {
    var parts = raw.split('/');
    modelId = parts[parts.length - 1] || parts[parts.length - 2] || raw;
  }
  document.getElementById('sbModelId').value = modelId;
  document.getElementById('sbTourContainer').innerHTML = '<iframe src="https://my.matterport.com/show/?m=' + encodeURIComponent(modelId) + '&play=1&qs=1" allowfullscreen style="width:100%;height:100%;border:none"></iframe>';
  showToast('Tour loaded', 'success');
}

/* ── Reset Prompt to Default ── */
function resetPrompt() {
  var vertical = document.getElementById('sbVertical');
  if (!vertical) return;
  var prompts = {
    hotel: 'You are a virtual employee for a hotel. You are embedded inside a 3D virtual tour of the property. Your job is to greet visitors, understand what they are looking for, recommend the right room type, and guide them towards making a booking. Be warm, professional, and knowledgeable. Keep responses concise (2-3 sentences max). Ask questions to understand the guest needs.',
    education: 'You are a virtual employee for an educational institution. You are embedded inside a 3D virtual tour of the campus. Your job is to greet prospective students, answer questions about programs, facilities, and campus life, and guide them towards scheduling a visit or applying. Be enthusiastic and informative. Keep responses concise.',
    retail: 'You are a virtual employee for a retail showroom. You are embedded inside a 3D virtual tour. Your job is to greet visitors, understand what they are looking for, and guide them towards making a purchase or booking a consultation. Be helpful and knowledgeable. Keep responses concise.',
    real_estate_sale: 'You are a virtual employee for a real estate agency. You are embedded inside a 3D virtual tour of a property for sale. Highlight key features, answer questions about the property and neighborhood, and guide buyers towards scheduling a viewing. Be professional and informative. Keep responses concise.',
    real_estate_development: 'You are a virtual employee for a real estate development. You are embedded inside a 3D virtual tour of a new project. Showcase the project, answer questions about units and amenities, and guide buyers towards booking a consultation. Be professional and enthusiastic. Keep responses concise.',
    other: 'You are a virtual employee embedded inside a 3D virtual tour. Greet visitors, answer their questions, and guide them towards a conversion action. Be helpful and professional. Keep responses concise.'
  };
  var el = document.getElementById('sbPrompt');
  if (el) el.value = prompts[vertical.value] || prompts.other;
}

/* ── Save Prompt as Template ── */
function savePromptAsTemplate() {
  var content = document.getElementById('sbPrompt').value;
  if (!content) { showToast('Prompt is empty', 'error'); return; }
  var html = '<h2>Save as Template</h2>'
    + '<div class="form-group"><label class="form-label">Template Name</label><input class="form-input" id="tmplName" placeholder="e.g. Hotel v2 - warm tone"></div>'
    + '<button class="btn btn-dark" onclick="doSaveTemplate()">Save</button>';
  showModal(html);
}
function doSaveTemplate() {
  var name = document.getElementById('tmplName').value;
  if (!name) { showToast('Enter a name', 'error'); return; }
  var content = document.getElementById('sbPrompt').value;
  var vertical = document.getElementById('sbVertical').value;
  api('/api/prompts', { method: 'POST', body: JSON.stringify({ name: name, vertical: vertical, content: content }) }).then(function() {
    closeModal();
    showToast('Template saved', 'success');
  }).catch(function() { showToast('Failed to save', 'error'); });
}

/* ── Load from Tenant ── */
function loadTenantDropdown() {
  api('/api/monitoring/tenants').then(function(tenants) {
    cachedTenants = tenants;
    var sel = document.getElementById('sbTenantSelect');
    if (!sel) return;
    var opts = '<option value="">— Select a tenant —</option>';
    tenants.forEach(function(t) {
      opts += '<option value="' + t.id + '">' + esc(t.agent_name || t.name || 'Unnamed') + ' (' + esc(t.vertical || '?') + ')</option>';
    });
    sel.innerHTML = opts;
  }).catch(function() {});
}

window.loadTenantData = function(id) {
  if (!id) return;
  var t = cachedTenants ? cachedTenants.find(function(x) { return x.id === id; }) : null;
  if (!t) {
    api('/api/monitoring/tenants').then(function(tenants) {
      cachedTenants = tenants;
      var found = tenants.find(function(x) { return x.id === id; });
      if (found) applyTenantData(found);
    });
    return;
  }
  applyTenantData(t);
};

function applyTenantData(t) {
  // Model ID
  if (t.matterport_model_id) {
    document.getElementById('sbModelId').value = t.matterport_model_id;
    loadTour();
  }
  // Property data
  if (t.property_data) {
    document.getElementById('sbData').value = typeof t.property_data === 'string' ? t.property_data : JSON.stringify(t.property_data, null, 2);
  }
  // Room mappings
  if (t.room_mappings) {
    var rmStr = typeof t.room_mappings === 'string' ? t.room_mappings : JSON.stringify(t.room_mappings, null, 2);
    document.getElementById('sbMappings').value = rmStr;
    if (roomEditorMode === 'visual') syncJSONToVisual();
  }
  // Vertical
  if (t.vertical) document.getElementById('sbVertical').value = t.vertical;
  // Reset prompt for new vertical
  resetPrompt();
  showToast('Loaded: ' + (t.agent_name || t.name || 'tenant'), 'success');
}

/* ── Sync from URL (Jina Reader) ── */
function syncFromURL() {
  var url = document.getElementById('sbSyncUrl').value.trim();
  if (!url) { showToast('Enter a URL', 'error'); return; }
  if (!url.startsWith('http')) url = 'https://' + url;
  var btn = document.getElementById('sbSyncBtn');
  btn.textContent = 'Syncing...';
  btn.disabled = true;
  fetch('/admin/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ url: url })
  }).then(function(r) { return r.json(); }).then(function(data) {
    btn.textContent = 'Sync';
    btn.disabled = false;
    if (data.error) { showToast(data.error, 'error'); return; }
    document.getElementById('sbData').value = data.text || '';
    showToast('Synced from website', 'success');
  }).catch(function(e) {
    btn.textContent = 'Sync';
    btn.disabled = false;
    showToast('Could not access this URL. Try pasting the content manually.', 'error');
  });
}

/* ── Room Mappings: JSON / Visual Editor ── */
function setRoomEditorMode(mode) {
  roomEditorMode = mode;
  document.getElementById('roomJsonEditor').style.display = mode === 'json' ? 'block' : 'none';
  document.getElementById('roomVisualEditor').style.display = mode === 'visual' ? 'block' : 'none';
  document.getElementById('rmJsonBtn').style.fontWeight = mode === 'json' ? '600' : '400';
  document.getElementById('rmVisualBtn').style.fontWeight = mode === 'visual' ? '600' : '400';
  if (mode === 'visual') syncJSONToVisual();
}

function syncJSONToVisual() {
  var raw = document.getElementById('sbMappings').value.trim();
  var mappings = {};
  try { if (raw) mappings = JSON.parse(raw); } catch(e) {}
  var list = document.getElementById('roomList');
  var html = '';
  Object.entries(mappings).forEach(function(entry, i) {
    var key = entry[0];
    var val = entry[1];
    var label = (typeof val === 'string') ? val : (val.label || '');
    var sweep = (typeof val === 'string') ? key : (val.sweepId || val.sweep_id || key);
    html += roomRow(i, label, sweep);
  });
  list.innerHTML = html || '<div style="color:var(--muted);font-size:12px">No rooms mapped. Click "+ Add room" below.</div>';
}

function syncVisualToJSON() {
  var rows = document.querySelectorAll('.room-row');
  var mappings = {};
  rows.forEach(function(row) {
    var label = row.querySelector('.room-label').value.trim();
    var sweep = row.querySelector('.room-sweep').value.trim();
    if (label && sweep) {
      mappings[sweep] = { label: label, sweepId: sweep };
    }
  });
  document.getElementById('sbMappings').value = JSON.stringify(mappings, null, 2);
}

function roomRow(i, label, sweep) {
  return '<div class="room-row" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">'
    + '<input class="form-input room-label" placeholder="Room name" value="' + esc(label) + '" style="flex:1;min-height:0;padding:7px 10px" oninput="syncVisualToJSON()">'
    + '<input class="form-input room-sweep" placeholder="Sweep ID" value="' + esc(sweep) + '" style="width:120px;min-height:0;padding:7px 10px;font-family:monospace;font-size:11px" oninput="syncVisualToJSON()">'
    + '<button class="btn btn-outline btn-sm" onclick="this.closest(\'.room-row\').remove();syncVisualToJSON()" style="color:var(--red);padding:4px 8px">&times;</button>'
    + '</div>';
}

function addRoom() {
  var list = document.getElementById('roomList');
  // Clear empty state message
  if (list.querySelector('div[style*="color:var(--muted)"]')) list.innerHTML = '';
  var i = list.querySelectorAll('.room-row').length;
  list.insertAdjacentHTML('beforeend', roomRow(i, '', ''));
}

/* ── Validate Room Mappings JSON ── */
function validateRoomMappings() {
  var raw = document.getElementById('sbMappings').value.trim();
  var errEl = document.getElementById('sbMappingsError');
  if (!raw || raw === '{}') { errEl.style.display = 'none'; return true; }
  try {
    JSON.parse(raw);
    errEl.style.display = 'none';
    return true;
  } catch(e) {
    errEl.textContent = 'Invalid JSON — check your room mappings';
    errEl.style.display = 'block';
    return false;
  }
}

/* ── Apply & Restart Session ── */
function applyAndRestart() {
  if (!validateRoomMappings()) return;
  startSandboxSession();
}

/* ── Save Configuration ── */
function saveSandboxConfig() {
  var html = '<h2>Save Configuration</h2>'
    + '<div class="form-group"><label class="form-label">Configuration Name</label><input class="form-input" id="cfgSaveName" placeholder="e.g. DIS Stockholm - warm v2"></div>'
    + '<button class="btn btn-dark" onclick="doSaveConfig()">Save</button>';
  showModal(html);
}
function doSaveConfig() {
  var name = document.getElementById('cfgSaveName').value;
  if (!name) { showToast('Enter a name', 'error'); return; }
  api('/api/configs', { method: 'POST', body: JSON.stringify({
    name: name,
    vertical: document.getElementById('sbVertical').value,
    temperature: parseFloat(document.getElementById('sbTemp').value),
    model: document.getElementById('sbModel').value,
    systemPrompt: document.getElementById('sbPrompt').value,
    propertyData: document.getElementById('sbData').value,
    roomMappings: document.getElementById('sbMappings').value,
    modelId: document.getElementById('sbModelId').value
  })}).then(function() {
    closeModal();
    showToast('Configuration saved', 'success');
  }).catch(function() { showToast('Failed to save', 'error'); });
}

/* ── Export System Prompt ── */
function exportSystemPrompt() {
  var prompt = document.getElementById('sbPrompt').value;
  var vertical = document.getElementById('sbVertical').value;
  if (!prompt) { showToast('System prompt is empty', 'error'); return; }
  var html = '<h2>Deploy to October AI</h2>'
    + '<p style="color:var(--muted);font-size:13px;margin-bottom:16px">Copy this prompt to <code>services/agentPersona.js</code> in the <code>-october-ai</code> repo under the <strong>' + esc(vertical) + '</strong> case statement.</p>'
    + '<textarea class="form-textarea" id="exportPromptText" rows="14" readonly style="font-family:monospace;font-size:12px">' + esc(prompt) + '</textarea>'
    + '<div style="display:flex;gap:8px;margin-top:12px">'
    + '<button class="btn btn-dark" onclick="navigator.clipboard.writeText(document.getElementById(\'exportPromptText\').value);showToast(\'Copied to clipboard!\',\'success\')">Copy to clipboard</button>'
    + '<button class="btn btn-outline" onclick="closeModal()">Done</button></div>';
  showModal(html);
}

/* ══════════════════════════════════════
   VOICE SESSION — WebSocket + Audio
   ══════════════════════════════════════ */
function startSandboxSession() {
  if (sandboxWs) { sandboxWs.close(); sandboxWs = null; }
  wsReconnectAttempts = 0;
  debugLog = [];
  incomingAudio = [];
  updateDebugPanel();

  var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = protocol + '//' + window.location.host + '/ws/test?token=' + encodeURIComponent(TOKEN);
  connectWebSocket(wsUrl);
}

function connectWebSocket(url) {
  sandboxWs = new WebSocket(url);
  sandboxWs.binaryType = 'arraybuffer';

  sandboxWs.onopen = function() {
    wsReconnectAttempts = 0;
    document.getElementById('voiceStatus').textContent = 'Connected — click mic or type';
    document.getElementById('micBtn').disabled = false;
    document.getElementById('sbTextInput').disabled = false;
    document.getElementById('sbSendBtn').disabled = false;

    // Send config
    var config = {
      systemPrompt: document.getElementById('sbPrompt').value,
      vertical: document.getElementById('sbVertical').value,
      temperature: parseFloat(document.getElementById('sbTemp').value),
      model: document.getElementById('sbModel').value,
      propertyData: document.getElementById('sbData').value,
      roomMappings: document.getElementById('sbMappings').value
    };
    sandboxWs.send(JSON.stringify({ type: 'config', config: config }));
    console.log('[SANDBOX] Starting session with temperature:', config.temperature);

    document.getElementById('transcriptPanel').innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center">Session started. Speak or type to begin.</div>';
  };

  sandboxWs.onmessage = function(event) {
    // Binary = PCM16 audio chunk
    if (event.data instanceof ArrayBuffer) {
      incomingAudio.push(event.data);
      return;
    }
    var msg;
    try { msg = JSON.parse(event.data); } catch(e) { return; }

    if (msg.type === 'transcript') {
      addTranscript(msg.role, msg.text);
    } else if (msg.type === 'audio_end') {
      playCollectedAudio();
    } else if (msg.type === 'status') {
      var s = msg.status;
      document.getElementById('voiceStatus').textContent = s === 'idle' ? 'Ready — click mic or type' : s.charAt(0).toUpperCase() + s.slice(1) + '...';
    } else if (msg.type === 'latency') {
      document.getElementById('latencyBar').innerHTML = '<span>STT: ' + msg.stt + 'ms</span><span>LLM: ' + msg.llm + 'ms</span><span>TTS: ' + msg.tts + 'ms</span><span>Total: ' + msg.total + 'ms</span>';
    } else if (msg.type === 'debug') {
      debugLog.unshift(msg);
      if (debugLog.length > 10) debugLog.pop();
      updateDebugPanel();
    } else if (msg.type === 'navigate') {
      handleNavigateEvent(msg);
    } else if (msg.type === 'conversion') {
      addTranscript('system', 'Booking triggered: ' + (msg.reason || ''));
    } else if (msg.type === 'profile_update') {
      addTranscript('system', 'Profile: ' + msg.field + ' = ' + msg.value);
    } else if (msg.type === 'error') {
      showToast(msg.message, 'error');
      addTranscript('error', msg.message);
    }
  };

  sandboxWs.onclose = function() {
    document.getElementById('voiceStatus').textContent = 'Disconnected';
    document.getElementById('micBtn').disabled = true;
    document.getElementById('sbTextInput').disabled = true;
    document.getElementById('sbSendBtn').disabled = true;

    // Auto-reconnect (max 3 attempts)
    if (wsReconnectAttempts < 3) {
      wsReconnectAttempts++;
      document.getElementById('voiceStatus').textContent = 'Reconnecting... (' + wsReconnectAttempts + '/3)';
      setTimeout(function() {
        if (!sandboxWs || sandboxWs.readyState === WebSocket.CLOSED) {
          connectWebSocket(url);
        }
      }, 2000);
    } else {
      document.getElementById('voiceStatus').innerHTML = 'Connection lost — <a href="#" onclick="applyAndRestart();return false" style="color:var(--black);text-decoration:underline">click to retry</a>';
    }
  };

  sandboxWs.onerror = function() {
    showToast('WebSocket connection failed — check that API keys are set in Railway Variables', 'error');
  };
}

/* ── Matterport Navigation ── */
function handleNavigateEvent(msg) {
  if (!msg.sweepId) {
    addTranscript('system', 'Room not found in tour: ' + (msg.roomName || ''));
    return;
  }
  addTranscript('system', 'Navigating to: ' + (msg.roomName || msg.sweepId));
  var iframe = document.querySelector('#sbTourContainer iframe');
  if (iframe) {
    iframe.contentWindow.postMessage({ type: 'NAVIGATE', sweepId: msg.sweepId }, '*');
    // Also try Matterport SDK navigation
    iframe.contentWindow.postMessage({ type: 'moveTo', sweepId: msg.sweepId }, '*');
  }
}

/* ── Transcript ── */
function addTranscript(role, text) {
  var panel = document.getElementById('transcriptPanel');
  if (!panel) return;
  // Clear initial placeholder
  if (!panel.querySelector('.transcript-msg')) panel.innerHTML = '';
  var div = document.createElement('div');
  div.className = 'transcript-msg';
  var roleClass = role === 'error' ? 'error' : role;
  div.innerHTML = '<span class="role ' + roleClass + '">[' + role + ']</span>' + esc(text);
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
}

/* ── Debug Panel ── */
function updateDebugPanel() {
  var el = document.getElementById('debugContent');
  if (!el) return;
  if (debugLog.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px">No turns yet.</div>';
    return;
  }
  var html = '';
  debugLog.forEach(function(d) {
    html += '<div class="debug-turn">'
      + '<div class="debug-turn-header">Turn #' + d.turn + ' <span style="color:var(--muted)">(' + d.model + ', temp ' + d.temperature + ')</span></div>'
      + '<div>STT: "' + esc((d.sttText || '').substring(0, 60)) + '" <span class="debug-ms">' + d.sttMs + 'ms</span></div>'
      + '<div>LLM: "' + esc((d.llmFirstTokens || '').substring(0, 60)) + '..." <span class="debug-ms">' + d.llmMs + 'ms</span></div>'
      + '<div>TTS: <span class="debug-ms">' + d.ttsMs + 'ms</span></div>'
      + '<div>Total: <strong>' + d.totalMs + 'ms</strong></div>';
    if (d.toolsCalled && d.toolsCalled.length > 0) {
      html += '<div>Tools: ' + d.toolsCalled.map(function(t) {
        return '<span class="debug-tool">' + t.name + '(' + Object.values(t.args).join(', ') + ')</span>';
      }).join(' ') + '</div>';
    }
    html += '</div>';
  });
  el.innerHTML = html;
}

function clearDebugLog() {
  debugLog = [];
  updateDebugPanel();
}

/* ── Text Input ── */
function sendTextInput() {
  var input = document.getElementById('sbTextInput');
  var text = input.value.trim();
  if (!text || !sandboxWs || sandboxWs.readyState !== 1) return;
  sandboxWs.send(JSON.stringify({ type: 'text_input', text: text }));
  input.value = '';
}

/* ── Audio Recording ── */
function toggleMic() {
  if (isRecording) stopRecording();
  else startRecording();
}

async function startRecording() {
  try {
    recordingStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    recordingCtx = new AudioContext({ sampleRate: 16000 });
    var source = recordingCtx.createMediaStreamSource(recordingStream);
    recordingProcessor = recordingCtx.createScriptProcessor(4096, 1, 1);
    audioChunks = [];

    recordingProcessor.onaudioprocess = function(e) {
      var float32 = e.inputBuffer.getChannelData(0);
      var int16 = new Int16Array(float32.length);
      for (var i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
      }
      audioChunks.push(int16.buffer);
    };

    source.connect(recordingProcessor);
    recordingProcessor.connect(recordingCtx.destination);

    isRecording = true;
    document.getElementById('micBtn').classList.add('recording');
    document.getElementById('voiceStatus').textContent = 'Listening... (click mic to stop)';

    // Auto-stop after 15 seconds
    setTimeout(function() { if (isRecording) stopRecording(); }, 15000);
  } catch(e) {
    showToast('Microphone access denied. Check browser permissions.', 'error');
  }
}

function stopRecording() {
  isRecording = false;
  document.getElementById('micBtn').classList.remove('recording');
  document.getElementById('voiceStatus').textContent = 'Processing...';

  // Stop media tracks
  if (recordingStream) {
    recordingStream.getTracks().forEach(function(t) { t.stop(); });
    recordingStream = null;
  }
  if (recordingProcessor) {
    recordingProcessor.disconnect();
    recordingProcessor = null;
  }
  if (recordingCtx) {
    recordingCtx.close().catch(function() {});
    recordingCtx = null;
  }

  // Combine audio chunks and send
  if (sandboxWs && sandboxWs.readyState === 1 && audioChunks.length > 0) {
    var totalLength = audioChunks.reduce(function(acc, buf) { return acc + buf.byteLength; }, 0);
    var combined = new Uint8Array(totalLength);
    var offset = 0;
    audioChunks.forEach(function(buf) {
      combined.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    });
    sandboxWs.send(combined.buffer);
  }
  audioChunks = [];
}

/* ── Audio Playback (PCM16 → AudioContext) ── */
function playCollectedAudio() {
  if (incomingAudio.length === 0) return;

  // Combine all chunks
  var totalLen = incomingAudio.reduce(function(s, b) { return s + b.byteLength; }, 0);
  var combined = new Uint8Array(totalLen);
  var offset = 0;
  incomingAudio.forEach(function(buf) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  });
  incomingAudio = [];

  // Convert Int16 → Float32
  var int16 = new Int16Array(combined.buffer);
  var float32 = new Float32Array(int16.length);
  for (var i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  // Play via AudioContext at 24kHz (Cartesia output rate)
  try {
    if (!playbackCtx || playbackCtx.state === 'closed') {
      playbackCtx = new AudioContext({ sampleRate: 24000 });
    }
    var buffer = playbackCtx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);
    var source = playbackCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackCtx.destination);
    source.start();
  } catch(e) {
    console.error('[SANDBOX] Audio playback error:', e);
  }
}

/* ═══════════════════════════════════════════════
   SYSTEM PROMPTS
   ═══════════════════════════════════════════════ */
function loadPrompts() {
  var c = document.getElementById('page-prompts');

  api('/api/prompts').then(function(prompts) {
    var html = '<div class="page-label">AGENT BUILDER</div>'
      + '<h1 class="page-heading">System Prompts</h1>'
      + '<p class="page-sub">Create, edit, and test system prompts.</p>'
      + '<button class="btn btn-dark" onclick="showNewPromptModal()" style="margin-bottom:24px">New Prompt</button>'
      + '<table class="data-table"><thead><tr>'
      + '<th>Name</th><th>Vertical</th><th>Created</th><th>Last Tested</th><th>Rating</th><th>Actions</th>'
      + '</tr></thead><tbody>';

    if (prompts.length === 0) {
      html += '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No prompts yet. Create your first one.</td></tr>';
    }

    prompts.forEach(function(p) {
      html += '<tr>'
        + '<td>' + esc(p.name) + '</td>'
        + '<td>' + esc(p.vertical) + '</td>'
        + '<td>' + fmtDate(p.created) + '</td>'
        + '<td>' + (p.lastTested ? fmtDate(p.lastTested) : '-') + '</td>'
        + '<td>' + (p.rating ? p.rating + '/5' : '-') + '</td>'
        + '<td>'
        + '<button class="btn btn-outline btn-sm" onclick="editPrompt(\'' + p.id + '\')">Edit</button> '
        + '<button class="btn btn-outline btn-sm" onclick="testPromptInSandbox(\'' + p.id + '\')">Test</button> '
        + '<button class="btn btn-outline btn-sm" onclick="deployPrompt(\'' + p.id + '\')">Deploy</button>'
        + '</td></tr>';
    });

    html += '</tbody></table>';
    c.innerHTML = html;
  });
}

function showNewPromptModal() {
  var html = '<h2>New System Prompt</h2>'
    + '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="newPromptName" placeholder="e.g. Hotel v2"></div>'
    + '<div class="form-group"><label class="form-label">Vertical</label><select class="form-select" id="newPromptVertical"><option value="hotel">Hotel</option><option value="education">Education</option><option value="retail">Retail</option><option value="real_estate_sale">Real Estate</option><option value="other">Other</option></select></div>'
    + '<div class="form-group"><label class="form-label">Content</label><textarea class="form-textarea" id="newPromptContent" rows="10" placeholder="Enter system prompt..."></textarea></div>'
    + '<button class="btn btn-dark" onclick="createPrompt()">Save Prompt</button>';
  showModal(html);
}

function createPrompt() {
  var name = document.getElementById('newPromptName').value;
  var vertical = document.getElementById('newPromptVertical').value;
  var content = document.getElementById('newPromptContent').value;
  if (!name || !content) { showToast('Name and content required', 'error'); return; }

  api('/api/prompts', { method: 'POST', body: JSON.stringify({ name: name, vertical: vertical, content: content }) }).then(function() {
    closeModal();
    loadPrompts();
    showToast('Prompt created', 'success');
  });
}

function editPrompt(id) {
  api('/api/prompts/' + id).then(function(p) {
    var html = '<h2>Edit Prompt</h2>'
      + '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="editPromptName" value="' + esc(p.name) + '"></div>'
      + '<div class="form-group"><label class="form-label">Vertical</label><select class="form-select" id="editPromptVertical">'
      + '<option value="hotel"' + (p.vertical==='hotel'?' selected':'') + '>Hotel</option>'
      + '<option value="education"' + (p.vertical==='education'?' selected':'') + '>Education</option>'
      + '<option value="retail"' + (p.vertical==='retail'?' selected':'') + '>Retail</option>'
      + '<option value="real_estate_sale"' + (p.vertical==='real_estate_sale'?' selected':'') + '>Real Estate</option>'
      + '<option value="other"' + (p.vertical==='other'?' selected':'') + '>Other</option></select></div>'
      + '<div class="form-group"><label class="form-label">Content</label><textarea class="form-textarea" id="editPromptContent" rows="12">' + esc(p.content) + '</textarea></div>'
      + '<div style="display:flex;gap:8px">'
      + '<button class="btn btn-dark" onclick="updatePrompt(\'' + id + '\')">Save</button>'
      + '<button class="btn btn-danger btn-sm" onclick="deletePrompt(\'' + id + '\')">Delete</button></div>';
    showModal(html);
  });
}

function updatePrompt(id) {
  var name = document.getElementById('editPromptName').value;
  var vertical = document.getElementById('editPromptVertical').value;
  var content = document.getElementById('editPromptContent').value;

  api('/api/prompts/' + id, { method: 'PUT', body: JSON.stringify({ name: name, vertical: vertical, content: content }) }).then(function() {
    closeModal();
    loadPrompts();
    showToast('Prompt updated', 'success');
  });
}

function deletePrompt(id) {
  if (!confirm('Delete this prompt?')) return;
  api('/api/prompts/' + id, { method: 'DELETE' }).then(function() {
    closeModal();
    loadPrompts();
    showToast('Prompt deleted');
  });
}

function testPromptInSandbox(id) {
  api('/api/prompts/' + id).then(function(p) {
    navigateTo('sandbox');
    setTimeout(function() {
      document.getElementById('sbPrompt').value = p.content;
      document.getElementById('sbVertical').value = p.vertical;
      showToast('Prompt loaded in sandbox', 'success');
    }, 200);
  });
}

function deployPrompt(id) {
  api('/api/prompts/' + id).then(function(p) {
    var html = '<h2>Deploy Prompt</h2>'
      + '<p style="margin-bottom:16px;color:var(--muted);font-size:13px">Copy this prompt and update it in the October AI codebase:</p>'
      + '<div style="background:var(--cream);padding:16px;border-radius:10px;margin-bottom:16px">'
      + '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">File: services/agentPersona.js</div>'
      + '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">Vertical: ' + esc(p.vertical) + '</div>'
      + '</div>'
      + '<textarea class="form-textarea" rows="12" id="deployContent" readonly style="font-family:monospace;font-size:12px">' + esc(p.content) + '</textarea>'
      + '<button class="btn btn-dark" onclick="navigator.clipboard.writeText(document.getElementById(\'deployContent\').value);showToast(\'Copied!\',\'success\')" style="margin-top:12px">Copy to clipboard</button>';
    showModal(html);
  });
}

/* ═══════════════════════════════════════════════
   CONFIGURATIONS
   ═══════════════════════════════════════════════ */
function loadConfigurations() {
  var c = document.getElementById('page-configurations');

  api('/api/configs').then(function(configs) {
    var html = '<div class="page-label">AGENT BUILDER</div>'
      + '<h1 class="page-heading">Configurations</h1>'
      + '<p class="page-sub">Save and compare test configurations.</p>'
      + '<button class="btn btn-dark" onclick="showNewConfigModal()" style="margin-bottom:24px">New Configuration</button>'
      + '<table class="data-table"><thead><tr>'
      + '<th>Name</th><th>Vertical</th><th>Temperature</th><th>Created</th><th>Sessions</th><th>Actions</th>'
      + '</tr></thead><tbody>';

    if (configs.length === 0) {
      html += '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No configurations yet.</td></tr>';
    }

    configs.forEach(function(cfg) {
      html += '<tr>'
        + '<td>' + esc(cfg.name) + '</td>'
        + '<td>' + esc(cfg.vertical) + '</td>'
        + '<td>' + (cfg.temperature || 0.7) + '</td>'
        + '<td>' + fmtDate(cfg.created) + '</td>'
        + '<td>' + (cfg.testSessions || 0) + '</td>'
        + '<td>'
        + '<button class="btn btn-outline btn-sm" onclick="loadConfigInSandbox(\'' + cfg.id + '\')">Load in Sandbox</button> '
        + '<button class="btn btn-outline btn-sm" onclick="exportConfig(\'' + cfg.id + '\')">Export</button>'
        + '</td></tr>';
    });

    html += '</tbody></table>';
    c.innerHTML = html;
  });
}

function showNewConfigModal() {
  var html = '<h2>New Configuration</h2>'
    + '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="newCfgName" placeholder="e.g. Hotel v2 - warm tone"></div>'
    + '<div class="form-group"><label class="form-label">Vertical</label><select class="form-select" id="newCfgVertical"><option value="hotel">Hotel</option><option value="education">Education</option><option value="retail">Retail</option><option value="real_estate_sale">Real Estate</option><option value="other">Other</option></select></div>'
    + '<div class="form-group"><label class="form-label">Notes</label><textarea class="form-textarea" id="newCfgNotes" rows="3"></textarea></div>'
    + '<button class="btn btn-dark" onclick="createConfig()">Save Configuration</button>';
  showModal(html);
}

function createConfig() {
  var name = document.getElementById('newCfgName').value;
  var vertical = document.getElementById('newCfgVertical').value;
  var notes = document.getElementById('newCfgNotes').value;
  if (!name) { showToast('Name required', 'error'); return; }

  // Grab current sandbox state if available
  var sbPrompt = document.getElementById('sbPrompt');
  var sbTemp = document.getElementById('sbTemp');
  var sbData = document.getElementById('sbData');
  var sbMappings = document.getElementById('sbMappings');

  api('/api/configs', { method: 'POST', body: JSON.stringify({
    name: name, vertical: vertical, notes: notes,
    systemPrompt: sbPrompt ? sbPrompt.value : '',
    temperature: sbTemp ? parseFloat(sbTemp.value) : 0.7,
    propertyData: sbData ? sbData.value : '',
    roomMappings: sbMappings ? sbMappings.value : '{}'
  })}).then(function() {
    closeModal();
    loadConfigurations();
    showToast('Configuration saved', 'success');
  });
}

function loadConfigInSandbox(id) {
  api('/api/configs/' + id).then(function(cfg) {
    navigateTo('sandbox');
    setTimeout(function() {
      if (cfg.systemPrompt) document.getElementById('sbPrompt').value = cfg.systemPrompt;
      if (cfg.vertical) document.getElementById('sbVertical').value = cfg.vertical;
      if (cfg.temperature) { document.getElementById('sbTemp').value = cfg.temperature; document.getElementById('sbTempVal').textContent = cfg.temperature; }
      if (cfg.propertyData) document.getElementById('sbData').value = cfg.propertyData;
      if (cfg.roomMappings) document.getElementById('sbMappings').value = cfg.roomMappings;
      showToast('Configuration loaded', 'success');
    }, 200);
  });
}

function exportConfig(id) {
  api('/api/configs/' + id).then(function(cfg) {
    var blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (cfg.name || 'config') + '.json';
    a.click();
  });
}

/* ═══════════════════════════════════════════════
   TEST HISTORY
   ═══════════════════════════════════════════════ */
function loadTestHistory() {
  var c = document.getElementById('page-test-history');

  api('/api/history').then(function(history) {
    var html = '<div class="page-label">AGENT BUILDER</div>'
      + '<h1 class="page-heading">Test History</h1>'
      + '<p class="page-sub">Review past test sessions and their results.</p>'
      + '<table class="data-table"><thead><tr>'
      + '<th>Date</th><th>Vertical</th><th>Duration</th><th>Messages</th><th>Rating</th><th>Notes</th>'
      + '</tr></thead><tbody>';

    if (history.length === 0) {
      html += '<tr><td colspan="6" style="text-align:center;color:var(--muted)">No test sessions yet. Use the sandbox to create one.</td></tr>';
    }

    history.forEach(function(h) {
      html += '<tr onclick="showTestDetail(\'' + h.id + '\')">'
        + '<td>' + fmtDate(h.created) + '</td>'
        + '<td>' + esc(h.vertical) + '</td>'
        + '<td>' + fmtDuration(h.duration) + '</td>'
        + '<td>' + (h.messages ? h.messages.length : 0) + '</td>'
        + '<td>' + (h.rating ? h.rating + '/5' : '-') + '</td>'
        + '<td>' + esc(h.notes ? h.notes.substring(0, 40) + (h.notes.length > 40 ? '...' : '') : '-') + '</td>'
        + '</tr>';
    });

    html += '</tbody></table>';
    html += '<div class="detail-overlay" id="testDetail"><button class="detail-close" onclick="closeDetail(\'testDetail\')">&times;</button><div id="testDetailContent"></div></div>';
    c.innerHTML = html;
  });
}

function showTestDetail(id) {
  api('/api/history/' + id).then(function(h) {
    var html = '<div class="detail-title">Test Session</div>'
      + '<div class="detail-subtitle">' + fmtDate(h.created) + ' &middot; ' + esc(h.vertical) + '</div>'
      + '<div class="detail-section"><h4>Details</h4>'
      + detailRow('Duration', fmtDuration(h.duration))
      + detailRow('Messages', h.messages ? h.messages.length : 0)
      + detailRow('Rating', h.rating ? h.rating + '/5' : 'Not rated')
      + '</div>';

    if (h.messages && h.messages.length > 0) {
      html += '<div class="detail-section"><h4>Transcript</h4><div class="transcript-panel">';
      h.messages.forEach(function(m) {
        html += '<div class="transcript-msg"><span class="role ' + (m.role || 'user') + '">[' + (m.role || 'user') + ']</span>' + esc(m.content || m.text || '') + '</div>';
      });
      html += '</div></div>';
    }

    if (h.promptUsed) {
      html += '<div class="detail-section"><h4>System Prompt Used</h4><pre style="font-size:11px;background:var(--cream);padding:12px;border-radius:8px;white-space:pre-wrap;max-height:200px;overflow-y:auto">' + esc(h.promptUsed) + '</pre></div>';
    }

    // Rating form
    html += '<div class="detail-section"><h4>Rate This Session</h4>'
      + '<div style="display:flex;gap:8px;margin-bottom:12px">';
    for (var i = 1; i <= 5; i++) {
      html += '<button class="btn btn-outline btn-sm" onclick="rateTest(\'' + h.id + '\',' + i + ')" style="' + (h.rating === i ? 'background:var(--black);color:var(--white)' : '') + '">' + i + '</button>';
    }
    html += '</div>'
      + '<textarea class="form-textarea" id="testNotes" rows="3" placeholder="Add notes...">' + esc(h.notes || '') + '</textarea>'
      + '<button class="btn btn-dark btn-sm" onclick="saveTestNotes(\'' + h.id + '\')" style="margin-top:8px">Save Notes</button></div>';

    document.getElementById('testDetailContent').innerHTML = html;
    document.getElementById('testDetail').classList.add('open');
  });
}

function rateTest(id, rating) {
  api('/api/history/' + id, { method: 'PUT', body: JSON.stringify({ rating: rating }) }).then(function() {
    showToast('Rating saved', 'success');
    loadTestHistory();
  });
}

function saveTestNotes(id) {
  var notes = document.getElementById('testNotes').value;
  api('/api/history/' + id, { method: 'PUT', body: JSON.stringify({ notes: notes }) }).then(function() {
    showToast('Notes saved', 'success');
  });
}

/* ═══════════════════════════════════════════════
   SHARED HELPERS
   ═══════════════════════════════════════════════ */
function filterBtn(label, value, context) {
  var stateMap = { customers: 'customersState', agents: 'agentsState', convos: 'convosState' };
  var state = stateMap[context];
  var field = context === 'convos' ? 'converted' : 'filter';
  var isActive = window[state] && window[state][field] === value;
  return '<button class="filter-btn' + (isActive ? ' active' : '') + '" onclick="' + state + '.' + field + '=\'' + value + '\';' + state + '.page=1;load' + context.charAt(0).toUpperCase() + context.slice(1) + '()">' + label + '</button>';
}

function loadConvos() { loadConversations(); }

function pagination(page, pages, context) {
  if (pages <= 1) return '';
  var loadFn = {
    customers: 'customersState.page=$PAGE$;loadCustomers()',
    agents: 'agentsState.page=$PAGE$;loadAgents()',
    convos: 'convosState.page=$PAGE$;loadConversations()'
  };
  var fn = loadFn[context] || '';
  return '<div class="pagination">'
    + '<span>Page ' + page + ' of ' + pages + '</span>'
    + '<div class="pagination-btns">'
    + '<button class="page-btn" onclick="' + fn.replace(/\$PAGE\$/g, page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>Previous</button>'
    + '<button class="page-btn" onclick="' + fn.replace(/\$PAGE\$/g, page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>Next</button>'
    + '</div></div>';
}

function detailRow(label, value) {
  return '<div class="detail-row"><span>' + label + '</span><span>' + value + '</span></div>';
}

function closeDetail(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

/* ── Modal ── */
function showModal(html) {
  var overlay = document.getElementById('modalOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modalOverlay';
    overlay.innerHTML = '<div class="modal-card" id="modalCard"></div>';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);
  }
  document.getElementById('modalCard').innerHTML = html;
  overlay.classList.add('open');
}

function closeModal() {
  var overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.classList.remove('open');
}

/* ── Keyboard shortcuts ── */
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeModal();
    document.querySelectorAll('.detail-overlay.open').forEach(function(d) { d.classList.remove('open'); });
  }
});

/* ── INIT ── */
navigateTo('overview');
