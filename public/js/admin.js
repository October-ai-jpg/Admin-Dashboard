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
      html += detailRow(esc(a.agent_name || a.property_name || 'Agent'), (a.conversation_count || 0) + ' conversations');
    });
    html += '</div>'
      + '<div class="detail-section"><h4>Recent Conversations</h4>';
    data.conversations.slice(0, 10).forEach(function(cv) {
      html += detailRow(fmtDate(cv.created_at), fmtDuration(cv.duration_seconds) + (cv.converted ? ' (converted)' : ''));
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
        + '<td>' + esc(a.agent_name || a.property_name || 'Agent') + '</td>'
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
    var html = '<div class="detail-title">' + esc(a.agent_name || a.property_name || 'Agent') + '</div>'
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
      html += detailRow(fmtDate(cv.created_at), fmtDuration(cv.duration_seconds) + (cv.converted ? ' (converted)' : ''));
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
      html += '<tr onclick="showConversationDetail(\'' + cv.id + '\')">'
        + '<td>' + fmtDate(cv.created_at) + '</td>'
        + '<td>' + esc(cv.agent_name || cv.property_name || '-') + '</td>'
        + '<td>' + esc(cv.customer_name || '-') + '</td>'
        + '<td>' + fmtDuration(cv.duration_seconds) + '</td>'
        + '<td>' + (cv.message_count || '-') + '</td>'
        + '<td>' + (cv.converted ? '<span class="badge badge-active">Yes</span>' : '<span class="badge badge-inactive">No</span>') + '</td>'
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
    var html = '<div class="detail-title">Conversation</div>'
      + '<div class="detail-subtitle">' + fmtDate(cv.created_at) + ' &middot; ' + esc(cv.agent_name || 'Unknown Agent') + '</div>'
      + '<div class="detail-section"><h4>Details</h4>'
      + detailRow('Duration', fmtDuration(cv.duration_seconds))
      + detailRow('Converted', cv.converted ? 'Yes' : 'No')
      + detailRow('Customer', cv.customer_name || '-')
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
    var html = '<table class="data-table"><thead><tr><th>Date</th><th>Agent</th><th>Error</th></tr></thead><tbody>';
    errors.forEach(function(e) {
      html += '<tr><td>' + fmtDate(e.created_at) + '</td><td>' + esc(e.agent_name || '-') + '</td><td style="max-width:400px;overflow:hidden;text-overflow:ellipsis">' + esc(e.error_message) + '</td></tr>';
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
   SANDBOX
   ═══════════════════════════════════════════════ */
var sandboxWs = null;
var isRecording = false;
var mediaRecorder = null;
var audioContext = null;
var audioChunks = [];

function loadSandbox() {
  var c = document.getElementById('page-sandbox');

  var html = '<div class="page-label">AGENT BUILDER</div>'
    + '<h1 class="page-heading">Sandbox</h1>'
    + '<p class="page-sub">Test voice agents with your own configuration.</p>'
    + '<div class="sandbox-layout">'
    // Left config panel
    + '<div class="sandbox-config">'
    + '<div class="form-group"><label class="form-label">Matterport Model ID</label>'
    + '<div style="display:flex;gap:8px"><input class="form-input" id="sbModelId" placeholder="e.g. SxQL3iGyoDo" style="flex:1">'
    + '<button class="btn btn-outline btn-sm" onclick="loadTour()">Load</button></div></div>'
    + '<div class="form-group"><label class="form-label">Vertical</label>'
    + '<select class="form-select" id="sbVertical"><option value="hotel">Hotel</option><option value="education">Education</option><option value="retail">Retail</option><option value="real_estate_sale">Real Estate (Sale)</option><option value="real_estate_development">Real Estate (Development)</option><option value="other">Other</option></select></div>'
    + '<div class="form-group"><label class="form-label">LLM Model</label>'
    + '<select class="form-select" id="sbModel"><option value="gpt-4o-mini">gpt-4o-mini</option><option value="gpt-4o">gpt-4o</option><option value="gpt-4-turbo">gpt-4-turbo</option></select></div>'
    + '<div class="form-group"><label class="form-label">Temperature: <span id="sbTempVal">0.7</span></label>'
    + '<input type="range" id="sbTemp" min="0" max="1" step="0.1" value="0.7" style="width:100%" oninput="document.getElementById(\'sbTempVal\').textContent=this.value"></div>'
    + '<div class="form-group"><label class="form-label">System Prompt</label>'
    + '<textarea class="form-textarea" id="sbPrompt" rows="8" placeholder="Enter system prompt..."></textarea>'
    + '<div style="display:flex;gap:8px;margin-top:8px">'
    + '<button class="btn btn-outline btn-sm" onclick="resetPrompt()">Reset to default</button>'
    + '<button class="btn btn-outline btn-sm" onclick="loadFromTenant()">Load from tenant</button></div></div>'
    + '<div class="form-group"><label class="form-label">Property Data</label>'
    + '<textarea class="form-textarea" id="sbData" rows="4" placeholder="Test property data..."></textarea></div>'
    + '<div class="form-group"><label class="form-label">Room Mappings (JSON)</label>'
    + '<textarea class="form-textarea" id="sbMappings" rows="3" placeholder=\'{"Room 1": "sweepId1"}\'></textarea></div>'
    + '<button class="btn btn-dark" onclick="startSandboxSession()" style="width:100%">Start Test Session</button>'
    + '</div>'
    // Right live panel
    + '<div class="sandbox-live">'
    + '<div class="sandbox-tour" id="sbTourContainer"><div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:14px">Enter a Matterport Model ID and click Load</div></div>'
    + '<div class="sandbox-voice">'
    + '<div style="text-align:center">'
    + '<button class="mic-btn" id="micBtn" onclick="toggleMic()" disabled>'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
    + '</button>'
    + '<div class="voice-status" id="voiceStatus">Start a session to begin</div>'
    + '</div>'
    + '<div class="latency-bar" id="latencyBar"><span>STT: -</span><span>LLM: -</span><span>TTS: -</span><span>Total: -</span></div>'
    + '<div class="transcript-panel" id="transcriptPanel"></div>'
    + '</div></div></div>';

  c.innerHTML = html;

  // Set default prompt
  resetPrompt();
}

function loadTour() {
  var modelId = document.getElementById('sbModelId').value.trim();
  if (!modelId) return;
  document.getElementById('sbTourContainer').innerHTML = '<iframe src="https://my.matterport.com/show/?m=' + encodeURIComponent(modelId) + '&play=1" allowfullscreen></iframe>';
}

function resetPrompt() {
  var vertical = document.getElementById('sbVertical');
  if (!vertical) return;
  var prompts = {
    hotel: 'You are a virtual employee for a hotel. You are embedded inside a 3D virtual tour of the property. Your job is to greet visitors, understand what they are looking for, recommend the right room type, and guide them towards making a booking. Be warm, professional, and knowledgeable. Keep responses concise (2-3 sentences max). Ask questions to understand the guest needs.',
    education: 'You are a virtual employee for an educational institution. You are embedded inside a 3D virtual tour of the campus. Your job is to greet prospective students, answer questions about programs, facilities, and campus life, and guide them towards scheduling a visit or applying.',
    retail: 'You are a virtual employee for a retail showroom. You are embedded inside a 3D virtual tour. Your job is to greet visitors, understand what they are looking for, and guide them towards a purchase.',
    real_estate_sale: 'You are a virtual employee for a real estate agency. You are embedded inside a 3D virtual tour of a property for sale. Highlight key features, answer questions, and guide buyers towards scheduling a viewing.',
    real_estate_development: 'You are a virtual employee for a real estate development. You are embedded inside a 3D virtual tour of a new project. Showcase the project and guide buyers towards booking a consultation.',
    other: 'You are a virtual employee embedded inside a 3D virtual tour. Greet visitors, answer questions, and guide them towards a conversion action.'
  };
  var el = document.getElementById('sbPrompt');
  if (el) el.value = prompts[vertical.value] || prompts.other;
}

function loadFromTenant() {
  api('/api/monitoring/tenants').then(function(tenants) {
    if (tenants.length === 0) { showToast('No tenants found', 'error'); return; }
    var html = '<h2>Select Tenant</h2><div style="max-height:400px;overflow-y:auto">';
    tenants.forEach(function(t) {
      html += '<div style="padding:12px;border-bottom:1px solid var(--border);cursor:pointer" onclick="loadTenantData(\'' + t.id + '\')">'
        + '<div style="font-weight:500">' + esc(t.agent_name || t.property_name || 'Agent') + '</div>'
        + '<div style="font-size:12px;color:var(--muted)">' + esc(t.vertical || '-') + '</div></div>';
    });
    html += '</div>';
    showModal(html);
  });
}

window.loadTenantData = function(id) {
  api('/api/monitoring/tenants').then(function(tenants) {
    var t = tenants.find(function(x) { return x.id === id; });
    if (!t) return;
    if (t.property_data) document.getElementById('sbData').value = typeof t.property_data === 'string' ? t.property_data : JSON.stringify(t.property_data, null, 2);
    if (t.room_mappings) document.getElementById('sbMappings').value = typeof t.room_mappings === 'string' ? t.room_mappings : JSON.stringify(t.room_mappings, null, 2);
    if (t.vertical) document.getElementById('sbVertical').value = t.vertical;
    closeModal();
    showToast('Loaded data from ' + (t.agent_name || 'tenant'), 'success');
  });
};

function startSandboxSession() {
  if (sandboxWs) sandboxWs.close();

  var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  sandboxWs = new WebSocket(protocol + '//' + window.location.host + '/ws/test?token=' + encodeURIComponent(TOKEN));

  sandboxWs.onopen = function() {
    document.getElementById('voiceStatus').textContent = 'Connected — click mic or type';
    document.getElementById('micBtn').disabled = false;

    // Send config
    sandboxWs.send(JSON.stringify({
      type: 'config',
      config: {
        systemPrompt: document.getElementById('sbPrompt').value,
        vertical: document.getElementById('sbVertical').value,
        temperature: parseFloat(document.getElementById('sbTemp').value),
        model: document.getElementById('sbModel').value,
        propertyData: document.getElementById('sbData').value,
        roomMappings: document.getElementById('sbMappings').value
      }
    }));

    // Clear transcript
    document.getElementById('transcriptPanel').innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center">Session started. Speak or type to begin.</div>';
  };

  sandboxWs.onmessage = function(event) {
    if (event.data instanceof Blob) {
      // Audio data — play it
      playAudio(event.data);
      return;
    }
    var msg = JSON.parse(event.data);
    if (msg.type === 'transcript') {
      addTranscript(msg.role, msg.text);
    } else if (msg.type === 'status') {
      document.getElementById('voiceStatus').textContent = msg.status === 'idle' ? 'Ready' : msg.status.charAt(0).toUpperCase() + msg.status.slice(1) + '...';
    } else if (msg.type === 'latency') {
      var bar = document.getElementById('latencyBar');
      bar.innerHTML = '<span>STT: ' + msg.stt + 'ms</span><span>LLM: ' + msg.llm + 'ms</span><span>TTS: ' + msg.tts + 'ms</span><span>Total: ' + msg.total + 'ms</span>';
    } else if (msg.type === 'error') {
      showToast(msg.message, 'error');
    }
  };

  sandboxWs.onclose = function() {
    document.getElementById('voiceStatus').textContent = 'Disconnected';
    document.getElementById('micBtn').disabled = true;
  };
}

function addTranscript(role, text) {
  var panel = document.getElementById('transcriptPanel');
  // Clear initial message
  if (panel.querySelector('div[style]') && !panel.querySelector('.transcript-msg')) panel.innerHTML = '';
  var div = document.createElement('div');
  div.className = 'transcript-msg';
  div.innerHTML = '<span class="role ' + role + '">[' + role + ']</span>' + esc(text);
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
}

function toggleMic() {
  if (isRecording) stopRecording();
  else startRecording();
}

async function startRecording() {
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
    audioContext = new AudioContext({ sampleRate: 16000 });
    var source = audioContext.createMediaStreamSource(stream);

    // Use ScriptProcessor for simplicity (AudioWorklet would be better in prod)
    var processor = audioContext.createScriptProcessor(4096, 1, 1);
    audioChunks = [];

    processor.onaudioprocess = function(e) {
      var float32 = e.inputBuffer.getChannelData(0);
      var int16 = new Int16Array(float32.length);
      for (var i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
      }
      audioChunks.push(int16.buffer);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    isRecording = true;
    document.getElementById('micBtn').classList.add('recording');
    document.getElementById('voiceStatus').textContent = 'Listening...';

    // Auto-stop after 10 seconds
    setTimeout(function() { if (isRecording) stopRecording(); }, 10000);
  } catch(e) {
    showToast('Microphone access denied', 'error');
  }
}

function stopRecording() {
  isRecording = false;
  document.getElementById('micBtn').classList.remove('recording');
  document.getElementById('voiceStatus').textContent = 'Processing...';

  if (audioContext) {
    audioContext.close();
    audioContext = null;
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

function playAudio(blob) {
  var audio = new Audio(URL.createObjectURL(blob));
  audio.play().catch(function() {});
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
