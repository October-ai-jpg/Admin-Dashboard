/* ═══════════════════════════════════════════════
   OCTOBER AI — ADMIN DASHBOARD JS
   ═══════════════════════════════════════════════ */

// Login removed — keep TOKEN for backwards-compat with existing fetch headers,
// but never redirect away. Server ignores the header now anyway.
var TOKEN = localStorage.getItem('october_admin_token') || 'open';

var CURRENT_PAGE = 'overview';
var REFRESH_INTERVAL = null;
var CHARTS = {};

/* ── Auth helper ── */
function api(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'x-admin-token': TOKEN, 'Content-Type': 'application/json' }, opts.headers || {});
  return fetch(url, opts).then(function(r) { return r.json(); });
}

// Logout is a no-op now (login removed), but kept so existing buttons don't crash.
function logout() { /* noop — login removed */ }

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
  // Show/hide sidebar dropdowns
  var thSub = document.getElementById('testHistorySub');
  if (thSub) thSub.style.display = page === 'test-history' ? 'block' : 'none';
  // Show page
  document.querySelectorAll('.page-container').forEach(function(p) { p.style.display = 'none'; });
  var container = document.getElementById('page-' + page);
  if (container) { container.style.display = 'block'; }
  // Load page content
  loadPage(page);
  // Clear auto-refresh, then install page-specific interval.
  // Signup-tracking pages (customers/agents/affiliates) auto-refresh every
  // 30 min so new accounts surface without a manual F5. Overview stays 60s
  // for the live counter; health stays 30s for the status indicator.
  if (REFRESH_INTERVAL) clearInterval(REFRESH_INTERVAL);
  if (page === 'overview')   REFRESH_INTERVAL = setInterval(function() { loadPage('overview');   }, 60000);
  if (page === 'health')     REFRESH_INTERVAL = setInterval(function() { loadPage('health');     }, 30000);
  if (page === 'customers')  REFRESH_INTERVAL = setInterval(function() { loadPage('customers');  }, 30 * 60 * 1000);
  if (page === 'agents')     REFRESH_INTERVAL = setInterval(function() { loadPage('agents');     }, 30 * 60 * 1000);
  if (page === 'affiliates') REFRESH_INTERVAL = setInterval(function() { loadPage('affiliates'); }, 30 * 60 * 1000);
  // Handle hash-based navigation
  if (page !== 'overview') window.location.hash = page;
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
    case 'default-system': loadDefaultSystem(); break;
    case 'sandbox': loadSandbox(); break;
    case 'sdk-sandbox': loadSdkSandbox(); break;
    case 'prompts': loadPrompts(); break;
    case 'configurations': loadConfigurations(); break;
    case 'test-history': loadTestHistory(); break;
    case 'test-protocol': loadTestProtocol(); break;
    case 'client-portal': window.open('/client/demo/agent', '_blank'); break;
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
      + '<th>Agent Name</th><th>Customer</th><th>Token</th><th>Vertical</th><th>Conversations</th><th>Conversions</th><th>Rate</th><th>Minutes</th>'
      + '</tr></thead><tbody>';

    data.agents.forEach(function(a) {
      var rate = parseInt(a.conversations) > 0 ? Math.round((parseInt(a.conversions) / parseInt(a.conversations)) * 100) : 0;
      var shortToken = a.client_token ? a.client_token.substring(0, 8) + '…' : '-';
      html += '<tr onclick="showAgentDetail(\'' + a.id + '\')">'
        + '<td>' + esc(a.agent_name || a.name || 'Agent') + '</td>'
        + '<td>' + esc(a.customer_name || '-') + '</td>'
        + '<td style="font-family:monospace;font-size:12px;color:#888" title="' + esc(a.client_token || '') + '">' + esc(shortToken) + '</td>'
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
    var agentLabel = a.agent_name || a.name || 'Agent';
    var html = '<div class="detail-title">' + esc(agentLabel) + '</div>'
      + '<div class="detail-subtitle">' + esc(a.customer_name) + ' &middot; ' + esc(a.customer_email) + '</div>'
      + '<div class="detail-section"><h4>Details</h4>'
      + detailRow('Tenant ID', '<span style="font-family:monospace;font-size:12px;user-select:all">' + esc(a.id) + '</span>')
      + detailRow('Client Token', '<span style="font-family:monospace;font-size:12px;user-select:all">' + esc(a.client_token || '-') + '</span>')
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

    // Danger zone: reset this tenant's usage / history
    html += '<div class="detail-section danger-zone">'
      + '<h4>Danger Zone</h4>'
      + '<p class="danger-note">Permanently delete all conversations, messages, voice usage sessions, '
      + 'and reset the minute counter for this tenant. Cannot be undone.</p>'
      + '<button class="danger-btn" onclick="openResetModal(\'' + esc(a.id) + '\', \'' + esc(agentLabel).replace(/'/g, "\\'") + '\')">Reset tenant usage…</button>'
      + '</div>';

    document.getElementById('agentDetailContent').innerHTML = html;
    document.getElementById('agentDetail').classList.add('open');
  });
}

/* ═══════════════════════════════════════════════
   TENANT RESET — destructive reset flow
   ═══════════════════════════════════════════════
   Two-step confirm:
   1. openResetModal(id, label) fetches dry-run counts and shows them
   2. confirmResetUsage(id) fires the destructive POST after admin types the
      tenant id into the confirmation field */
function openResetModal(tenantId, tenantLabel) {
  // Build modal shell if it doesn't exist yet (survives page re-renders)
  var modal = document.getElementById('resetModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'resetModal';
    modal.className = 'reset-modal';
    modal.innerHTML =
        '<div class="reset-modal-backdrop" onclick="closeResetModal()"></div>'
      + '<div class="reset-modal-card">'
      + '  <button class="reset-modal-close" onclick="closeResetModal()">&times;</button>'
      + '  <h2 class="reset-modal-title">Reset tenant usage</h2>'
      + '  <p class="reset-modal-sub" id="resetModalSub"></p>'
      + '  <div id="resetModalBody" class="reset-modal-body">Loading preview…</div>'
      + '  <div class="reset-modal-actions">'
      + '    <button class="btn-secondary" onclick="closeResetModal()">Cancel</button>'
      + '    <button class="danger-btn" id="resetConfirmBtn" disabled>Reset tenant</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(modal);
  }

  modal.classList.add('open');
  modal.dataset.tenantId = tenantId;
  modal.dataset.tenantLabel = tenantLabel || '';
  document.getElementById('resetModalSub').textContent = tenantLabel ? ('Agent: ' + tenantLabel) : ('Tenant id: ' + tenantId);
  var body = document.getElementById('resetModalBody');
  body.innerHTML = 'Loading preview…';
  document.getElementById('resetConfirmBtn').disabled = true;

  api('/api/monitoring/tenants/' + encodeURIComponent(tenantId) + '/reset-preview').then(function(res) {
    if (res && res.error) {
      body.innerHTML = '<div class="reset-error">Preview failed: ' + esc(res.error) + '</div>';
      return;
    }
    var c = res.counts || {};
    var t = res.tenant || {};
    var rows = ''
      + '<div class="reset-info-grid">'
      + '<div><div class="reset-label">Customer</div><div class="reset-val">' + esc(t.customer_name || '-') + '</div></div>'
      + '<div><div class="reset-label">Email</div><div class="reset-val">' + esc(t.customer_email || '-') + '</div></div>'
      + '<div><div class="reset-label">Tenant id</div><div class="reset-val mono">' + esc(t.id || tenantId) + '</div></div>'
      + '<div><div class="reset-label">Quota</div><div class="reset-val">' + (t.minutes_quota || 0) + ' min/mo</div></div>'
      + '</div>'
      + '<div class="reset-counts">'
      + '<div class="reset-count-row"><span>Conversations to delete</span><strong>' + (c.conversations || 0) + '</strong></div>'
      + '<div class="reset-count-row"><span>Messages to delete</span><strong>' + (c.messages || 0) + '</strong></div>'
      + '<div class="reset-count-row"><span>voice_usage sessions to delete</span><strong>' + (c.voiceUsageSessions || 0) + '</strong></div>'
      + '<div class="reset-count-row"><span>minutes_used_this_month (will become 0)</span><strong>' + (c.minutesUsedThisMonth || 0) + '</strong></div>'
      + '</div>'
      + '<div class="reset-scope">'
      + '<label><input type="checkbox" id="scopeDeleteConvos" checked> Delete conversations + messages</label>'
      + '<label><input type="checkbox" id="scopeDeleteVoiceUsage" checked> Delete voice_usage sessions</label>'
      + '<label><input type="checkbox" id="scopeResetMinutes" checked> Reset tenant minutes_used_this_month</label>'
      + '<label><input type="checkbox" id="scopeResetMonthly" checked> Reset user-level monthly_usage (this month)</label>'
      + '</div>'
      + '<div class="reset-confirm-row">'
      + '<label class="reset-confirm-label">To confirm, paste the tenant id <code>' + esc(tenantId) + '</code> below:</label>'
      + '<input id="resetConfirmInput" class="reset-confirm-input mono" placeholder="tenant id" oninput="onResetConfirmInput()">'
      + '</div>';
    body.innerHTML = rows;
  }).catch(function(err) {
    body.innerHTML = '<div class="reset-error">Preview failed: ' + esc(err?.message || String(err)) + '</div>';
  });
}

function onResetConfirmInput() {
  var modal = document.getElementById('resetModal');
  if (!modal) return;
  var tenantId = modal.dataset.tenantId;
  var input = document.getElementById('resetConfirmInput');
  var btn = document.getElementById('resetConfirmBtn');
  if (!input || !btn) return;
  btn.disabled = input.value.trim() !== tenantId;
  btn.onclick = function() { confirmResetUsage(tenantId); };
}

function closeResetModal() {
  var modal = document.getElementById('resetModal');
  if (modal) modal.classList.remove('open');
}

function confirmResetUsage(tenantId) {
  var btn = document.getElementById('resetConfirmBtn');
  var body = document.getElementById('resetModalBody');
  if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }

  var scope = {
    deleteConversations: document.getElementById('scopeDeleteConvos')?.checked !== false,
    deleteVoiceUsage:    document.getElementById('scopeDeleteVoiceUsage')?.checked !== false,
    resetTenantMinutes:  document.getElementById('scopeResetMinutes')?.checked !== false,
    resetMonthlyUsage:   document.getElementById('scopeResetMonthly')?.checked !== false,
  };

  api('/api/monitoring/tenants/' + encodeURIComponent(tenantId) + '/reset-usage', {
    method: 'POST',
    body: JSON.stringify({ confirmToken: tenantId, scope: scope })
  }).then(function(res) {
    if (res && res.error) {
      if (body) body.innerHTML = '<div class="reset-error">Reset failed: ' + esc(res.error) + '</div>';
      if (btn) { btn.disabled = false; btn.textContent = 'Reset tenant'; }
      return;
    }
    var d = res.deleted || {};
    var summary = ''
      + '<div class="reset-success">'
      + '<div class="reset-success-icon">✓</div>'
      + '<h3>Reset complete</h3>'
      + '<div class="reset-count-row"><span>Messages deleted</span><strong>' + (d.messages || 0) + '</strong></div>'
      + '<div class="reset-count-row"><span>Conversations deleted</span><strong>' + (d.conversations || 0) + '</strong></div>'
      + '<div class="reset-count-row"><span>voice_usage sessions deleted</span><strong>' + (d.voiceUsageSessions || 0) + '</strong></div>'
      + '<div class="reset-count-row"><span>Tenant minutes reset</span><strong>' + (d.tenantMinutesReset ? 'yes' : 'no') + '</strong></div>'
      + '<div class="reset-count-row"><span>Monthly usage reset</span><strong>' + (d.monthlyUsageReset ? 'yes' : 'no') + '</strong></div>'
      + '</div>';
    if (body) body.innerHTML = summary;
    if (btn) { btn.textContent = 'Close'; btn.disabled = false; btn.onclick = function() { closeResetModal(); showAgentDetail(tenantId); }; }
    if (typeof showToast === 'function') showToast('Tenant usage reset', 'success');
  }).catch(function(err) {
    if (body) body.innerHTML = '<div class="reset-error">Reset failed: ' + esc(err?.message || String(err)) + '</div>';
    if (btn) { btn.disabled = false; btn.textContent = 'Reset tenant'; }
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
   SANDBOX — Full Agent Builder (v2 — 3 Zone Layout)
   Zone 1: Collapsible admin config panel
   Zone 2: Matterport tour (full viewport)
   Zone 3: Voice interface overlaid on tour (agent icon + transcript)
   ═══════════════════════════════════════════════ */
var sandboxWs = null;
var debugLog = [];
var wsReconnectAttempts = 0;
var cachedTenants = null;

/* ── SDK Sandbox mode flag + SDK instance state ── */
var sdkSandboxActive = false;
var sdkInstance = null;           // Matterport SDK instance (from MP_SDK.connect)
var sdkConnected = false;         // true once phase === PLAYING
var sdkConnecting = false;        // guard against parallel connects
var sdkCameraSub = null;          // camera pose subscription handle
var sdkSweepCurrentSub = null;    // current sweep subscription handle
var sdkModeCurrentSub = null;     // current mode subscription handle
var sdkSweepDataSub = null;       // sweep collection subscription handle
var sdkSweepsList = [];           // array of sweep objects from Sweep.data
var sdkCurrentSweepSid = '';
var sdkCurrentModeName = '';
var sdkEventLogLines = [];        // most-recent events for the console
var SDK_INTERFACE_VERSION = '3.10';

/* ── Voice state (matches production embed.js) ── */
var sbAudioContext = null;
var sbMicStream = null;
var sbWorkletNode = null;
var sbWorkletRegistered = false;
var sbAgentStatus = 'idle'; // idle | thinking | speaking | user_speaking
var sbNextPlayTime = 0;
var sbCurrentSources = [];
var sbPlaybackGain = null;
var sbVadSuppressed = false;
var sbVadSuppressTimer = null;
var sbTranscriptMessages = [];
var sbTranscriptOpen = false;
var sbDemoOpen = false;
var sbConfigCollapsed = false;
var sbInputBarOpen = false;

/* ── Property data state (3-source pipeline) ── */
var sandboxManualData = '';
var sandboxScrapedData = '';
var sandboxCompiledContext = '';
var sandboxActiveDataTab = 'manual';

/* ── Floor plan image (data URL, for set_view_mode overlay) ── */
var sandboxFloorplanImage = '';
var FLOORPLAN_STORAGE_KEY = 'sandbox_floorplan_image';
try { sandboxFloorplanImage = localStorage.getItem(FLOORPLAN_STORAGE_KEY) || ''; } catch (e) {}

/* ── VAD Parameters (matches production) ── */
var VAD_SPEECH_THRESHOLD = 0.015;
var VAD_SILENCE_MS = 1000;
var VAD_SPEECH_FRAMES_TO_START = 3;
var VAD_PRE_ROLL_FRAMES = 8;
var VAD_MIN_SPEECH_FRAMES = 10;

/* ── VAD Worklet Code (matches production embed.js exactly) ── */
var VAD_WORKLET_CODE = [
  'class VADProcessor extends AudioWorkletProcessor {',
  '  constructor() {',
  '    super();',
  '    this.state = "IDLE";',
  '    this.speechFrameCount = 0;',
  '    this.silenceFrameCount = 0;',
  '    this.speechBuffer = [];',
  '    this.preRoll = [];',
  '    this.totalSpeechFrames = 0;',
  '    this.threshold = ' + VAD_SPEECH_THRESHOLD + ';',
  '    this.silenceToStop = Math.ceil(' + VAD_SILENCE_MS + ' / (128 / sampleRate * 1000));',
  '    this.speechToStart = ' + VAD_SPEECH_FRAMES_TO_START + ';',
  '    this.preRollMax = ' + VAD_PRE_ROLL_FRAMES + ';',
  '    this.minSpeechFrames = ' + VAD_MIN_SPEECH_FRAMES + ';',
  '    this.port.onmessage = (e) => {',
  '      if (e.data.type === "setThreshold") this.threshold = e.data.value;',
  '      if (e.data.type === "reset") { this.state = "IDLE"; this.speechBuffer = []; this.preRoll = []; this.speechFrameCount = 0; this.silenceFrameCount = 0; this.totalSpeechFrames = 0; }',
  '    };',
  '  }',
  '  process(inputs) {',
  '    var input = inputs[0];',
  '    if (!input || !input[0]) return true;',
  '    var samples = input[0];',
  '    var ratio = sampleRate / 24000;',
  '    var outLen = Math.floor(samples.length / ratio);',
  '    var resampled = new Float32Array(outLen);',
  '    for (var i = 0; i < outLen; i++) { resampled[i] = samples[Math.floor(i * ratio)]; }',
  '    var sum = 0;',
  '    for (var j = 0; j < resampled.length; j++) sum += resampled[j] * resampled[j];',
  '    var rms = Math.sqrt(sum / resampled.length);',
  '    var isSpeech = rms > this.threshold;',
  '    if (this.state === "IDLE") {',
  '      this.preRoll.push(resampled);',
  '      if (this.preRoll.length > this.preRollMax) this.preRoll.shift();',
  '      if (isSpeech) {',
  '        this.speechFrameCount++;',
  '        if (this.speechFrameCount >= this.speechToStart) {',
  '          this.state = "SPEAKING";',
  '          this.speechBuffer = this.preRoll.slice();',
  '          this.preRoll = [];',
  '          this.totalSpeechFrames = this.speechFrameCount;',
  '          this.silenceFrameCount = 0;',
  '          this.port.postMessage({ type: "speech_start" });',
  '        }',
  '      } else { this.speechFrameCount = 0; }',
  '    } else if (this.state === "SPEAKING") {',
  '      this.speechBuffer.push(resampled);',
  '      this.totalSpeechFrames++;',
  '      if (isSpeech) { this.silenceFrameCount = 0; }',
  '      else {',
  '        this.silenceFrameCount++;',
  '        if (this.silenceFrameCount >= this.silenceToStop) {',
  '          if (this.totalSpeechFrames >= this.minSpeechFrames) {',
  '            var totalLen = 0;',
  '            for (var k = 0; k < this.speechBuffer.length; k++) totalLen += this.speechBuffer[k].length;',
  '            var combined = new Float32Array(totalLen);',
  '            var offset = 0;',
  '            for (var m = 0; m < this.speechBuffer.length; m++) { combined.set(this.speechBuffer[m], offset); offset += this.speechBuffer[m].length; }',
  '            this.port.postMessage({ type: "speech_end", audio: combined }, [combined.buffer]);',
  '          }',
  '          this.state = "IDLE";',
  '          this.speechBuffer = [];',
  '          this.preRoll = [];',
  '          this.speechFrameCount = 0;',
  '          this.silenceFrameCount = 0;',
  '          this.totalSpeechFrames = 0;',
  '        }',
  '      }',
  '    }',
  '    return true;',
  '  }',
  '}',
  'registerProcessor("vad-processor", VADProcessor);'
].join('\n');

/* ═══════════════════════════════════════════════
   DEFAULT SYSTEM — production settings overview
   All values hardcoded from production codebase
   ═══════════════════════════════════════════════ */
var PROD_DEFAULTS = {
  llm: { model: 'gpt-5.4-mini', temperature: 0.7, maxTokens: 200, contextTurns: 16, maxGptCalls: 50 },
  stt: { provider: 'Deepgram', model: 'nova-3', sampleRate: '24 kHz', format: 'PCM16 LE', minDuration: '500ms', timeout: '8s', minConfidence: 0.65 },
  tts: { provider: 'Cartesia', model: 'sonic-2', version: '2025-04-16', sampleRate: '24 kHz', format: 'PCM S16LE', timeout: '15s' },
  vad: { speechThreshold: 0.015, silenceDuration: '1000ms', speechFramesToStart: 3, preRollFrames: 8, minSpeechFrames: 10, frameSize: 128 },
  session: { idleTimeout: '5 min', maxDuration: '20 min', echoSuppression: '1200ms', ttsCooldown: '1500ms', silenceFollowUp: '20s', freeTrialLimit: '10 min' },
  behavior: { greeting: 'Auto on connect', interruption: 'VAD-based', maxResponse: '2–3 sentences', navigation: 'Sweep ID', conversion: 'Tool call trigger', ttsStreamThreshold: '4+ words' },
  prompts: {
    hotel: 'You are a virtual employee for a hotel. You are embedded inside a 3D virtual tour of the property. Your job is to greet visitors, understand what they are looking for, recommend the right room type, and guide them towards making a booking. Be warm, professional, and knowledgeable.',
    education: 'You are a virtual employee for an educational institution. You are embedded inside a 3D virtual tour of the campus. Your job is to greet prospective students, answer questions about programs, facilities, and campus life, and guide them towards scheduling a visit or applying.',
    retail: 'You are a virtual employee for a retail showroom. You are embedded inside a 3D virtual tour. Your job is to greet visitors, understand what they are looking for, and guide them towards making a purchase or booking a consultation.',
    real_estate_sale: 'You are a virtual employee for a real estate agency. You are embedded inside a 3D virtual tour of a property for sale. Highlight key features, answer questions about the property and neighborhood, and guide buyers towards scheduling a viewing.',
    real_estate_development: 'You are a virtual employee for a real estate development. You are embedded inside a 3D virtual tour of a new project. Showcase the project, answer questions about units and amenities, and guide buyers towards booking a consultation.'
  }
};

function loadDefaultSystem() {
  var c = document.getElementById('page-default-system');
  var d = PROD_DEFAULTS;

  var verticals = [
    { key: 'hotel', label: 'Hotel' },
    { key: 'education', label: 'Education' },
    { key: 'retail', label: 'Retail / Showroom' },
    { key: 'real_estate_sale', label: 'Real Estate (Sale)' },
    { key: 'real_estate_development', label: 'Real Estate (Development)' }
  ];

  var html = '<div class="page-label">AGENT BUILDER</div>'
    + '<h1 class="page-heading">Default System</h1>'
    + '<p class="page-sub">Current production settings across all customer agents.</p>';

  // ── LLM ──
  html += '<div class="ds-section">'
    + '<h3 class="section-title" style="font-size:22px;margin-bottom:16px">LLM</h3>'
    + '<div class="kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">'
    + dsCard('Model', d.llm.model)
    + dsCard('Temperature', d.llm.temperature)
    + dsCard('Max Tokens', d.llm.maxTokens)
    + dsCard('Context Turns', d.llm.contextTurns)
    + dsCard('Max GPT Calls', d.llm.maxGptCalls)
    + '</div></div>';

  // ── STT ──
  html += '<div class="ds-section">'
    + '<h3 class="section-title" style="font-size:22px;margin-bottom:16px">Speech-to-Text</h3>'
    + '<div class="kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">'
    + dsCard('Provider', d.stt.provider)
    + dsCard('Model', d.stt.model)
    + dsCard('Sample Rate', d.stt.sampleRate)
    + dsCard('Format', d.stt.format)
    + dsCard('Min Duration', d.stt.minDuration)
    + dsCard('Timeout', d.stt.timeout)
    + dsCard('Min Confidence', d.stt.minConfidence)
    + '</div></div>';

  // ── TTS ──
  html += '<div class="ds-section">'
    + '<h3 class="section-title" style="font-size:22px;margin-bottom:16px">Text-to-Speech</h3>'
    + '<div class="kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">'
    + dsCard('Provider', d.tts.provider)
    + dsCard('Model', d.tts.model)
    + dsCard('Version', d.tts.version)
    + dsCard('Sample Rate', d.tts.sampleRate)
    + dsCard('Format', d.tts.format)
    + dsCard('Timeout', d.tts.timeout)
    + '</div></div>';

  // ── VAD ──
  html += '<div class="ds-section">'
    + '<h3 class="section-title" style="font-size:22px;margin-bottom:16px">Voice Activity Detection</h3>'
    + '<div class="kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">'
    + dsCard('Energy Threshold', d.vad.speechThreshold)
    + dsCard('Silence Duration', d.vad.silenceDuration)
    + dsCard('Speech Frames', d.vad.speechFramesToStart)
    + dsCard('Pre-roll Frames', d.vad.preRollFrames)
    + dsCard('Min Speech', d.vad.minSpeechFrames + ' frames')
    + dsCard('Frame Size', d.vad.frameSize + ' samples')
    + '</div></div>';

  // ── Session ──
  html += '<div class="ds-section">'
    + '<h3 class="section-title" style="font-size:22px;margin-bottom:16px">Session &amp; Timing</h3>'
    + '<div class="kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">'
    + dsCard('Idle Timeout', d.session.idleTimeout)
    + dsCard('Max Duration', d.session.maxDuration)
    + dsCard('Echo Suppress', d.session.echoSuppression)
    + dsCard('TTS Cooldown', d.session.ttsCooldown)
    + dsCard('Silence Follow-up', d.session.silenceFollowUp)
    + dsCard('Free Trial', d.session.freeTrialLimit)
    + '</div></div>';

  // ── Agent Behavior ──
  html += '<div class="ds-section">'
    + '<h3 class="section-title" style="font-size:22px;margin-bottom:16px">Agent Behavior</h3>'
    + '<div class="kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">'
    + dsCard('Greeting', d.behavior.greeting)
    + dsCard('Interruption', d.behavior.interruption)
    + dsCard('Max Response', d.behavior.maxResponse)
    + dsCard('Navigation', d.behavior.navigation)
    + dsCard('Conversion', d.behavior.conversion)
    + dsCard('TTS Stream', d.behavior.ttsStreamThreshold)
    + '</div></div>';

  // ── Prompts per vertical ──
  html += '<div class="ds-section">'
    + '<h3 class="section-title" style="font-size:22px;margin-bottom:16px">System Prompts by Vertical</h3>';

  verticals.forEach(function(v) {
    html += '<div class="ds-prompt-card">'
      + '<div class="ds-prompt-label">' + esc(v.label) + '</div>'
      + '<div class="ds-prompt-text">' + esc(d.prompts[v.key] || '') + '</div>'
      + '</div>';
  });
  html += '</div>';

  c.innerHTML = html;
}

function dsCard(label, value) {
  return '<div class="kpi-card">'
    + '<div class="kpi-label">' + esc(label) + '</div>'
    + '<div class="kpi-value" style="font-size:22px">' + esc(String(value)) + '</div>'
    + '</div>';
}

/* ── (applyDefaultSystem removed — production uses dynamic prompt generation via agentPersona.js) ── */

function loadSandbox(options) {
  options = options || {};
  var sdkMode = !!options.sdkMode;
  sdkSandboxActive = sdkMode;

  // Clear the OTHER sandbox container so we never have duplicate IDs in the DOM
  var otherId = sdkMode ? 'page-sandbox' : 'page-sdk-sandbox';
  var other = document.getElementById(otherId);
  if (other) other.innerHTML = '';

  // Tear down any existing SDK instance when leaving SDK mode
  if (!sdkMode && (sdkInstance || sdkConnected)) {
    try { sdkDisconnectInstance(); } catch (e) {}
  }

  var containerId = sdkMode ? 'page-sdk-sandbox' : 'page-sandbox';
  var c = document.getElementById(containerId);
  if (!c) return;

  var heading = sdkMode ? 'SDK Sandbox' : 'Sandbox';
  var subheading = sdkMode
    ? 'Like the Sandbox, but drives the tour via the Matterport Showcase SDK. Requires a private SDK application key.'
    : 'Test voice agents with the production pipeline. Matches October AI 1:1.';

  var html = '<div id="sbKeyBanner"></div>'
    + '<div class="page-label">AGENT BUILDER</div>'
    + '<h1 class="page-heading">' + heading + '</h1>'
    + '<p class="page-sub">' + subheading + '</p>'
    + '<div class="sandbox-layout">'

    // ═══ ZONE 1: CONFIG PANEL (collapsible) ═══
    + '<div class="sandbox-config" id="sbConfigPanel">'

    // Matterport
    + '<div class="form-group">'
    + '<label class="form-label">Matterport Model ID <span class="sb-tooltip" data-tip="Paste a Matterport model ID or full URL.">?</span></label>'
    + '<div style="display:flex;gap:8px"><input class="form-input" id="sbModelId" placeholder="e.g. NCPe9NFNKew" style="flex:1">'
    + '<button class="btn btn-outline btn-sm" onclick="loadTour()">Apply</button></div>'
    + '</div>'

    // SDK Application Key (only in SDK mode)
    + (sdkMode ? (
        '<div class="form-group">'
        + '<label class="form-label">SDK Application Key <span class="sb-tooltip" data-tip="Your Matterport SDK application key. Required for the SDK to connect to the showcase. Treated as a session-only value and stored in browser localStorage for convenience.">?</span></label>'
        + '<input class="form-input" id="sdkAppKey" placeholder="Paste your private Matterport SDK key" autocomplete="off">'
        + '<div style="display:flex;gap:8px;margin-top:6px">'
        + '<button class="btn btn-outline btn-sm" onclick="sdkSaveAppKey()" style="flex:1">Save key</button>'
        + '<button class="btn btn-outline btn-sm" onclick="sdkClearAppKey()">Clear</button>'
        + '</div>'
        + '<div id="sdkKeyStatus" style="font-size:11px;color:var(--muted);margin-top:6px">No key saved.</div>'
        + '</div>'
      ) : '')

    // Floor plan image (shown as overlay when agent calls set_view_mode:floorplan)
    + '<div class="form-group">'
    + '<label class="form-label">Floor Plan Image <span class="sb-tooltip" data-tip="PNG or JPG of the floor plan. Shown as overlay when the agent triggers set_view_mode:floorplan. Persists across page reloads.">?</span></label>'
    + '<input type="file" id="sbFloorplanInput" accept="image/png,image/jpeg,image/webp" style="display:none" onchange="uploadFloorplanImage(this)">'
    + '<div style="display:flex;gap:8px;align-items:center">'
    + '<button class="btn btn-outline btn-sm" onclick="document.getElementById(\'sbFloorplanInput\').click()" id="sbFloorplanBtn" style="flex:1">Upload floor plan</button>'
    + '<button class="btn btn-outline btn-sm" onclick="clearFloorplanImage()" id="sbFloorplanClearBtn" style="display:none">Clear</button>'
    + '</div>'
    + '<div id="sbFloorplanPreview" class="sb-floorplan-preview" style="display:none;margin-top:8px"></div>'
    + '</div>'

    // Load from Tenant
    + '<div class="form-group">'
    + '<label class="form-label">Load from Tenant <span class="sb-tooltip" data-tip="Load an existing customer\'s full configuration — Matterport tour, property data, room mappings, vertical, agent name, and language.">?</span></label>'
    + '<select class="form-select" id="sbTenantSelect" onchange="loadTenantData(this.value)"><option value="">— Select a tenant —</option></select>'
    + '</div>'

    // ─── AGENT SETTINGS ───
    + '<div class="sb-section-header">Agent Settings</div>'

    // Vertical (all 12 production verticals)
    + '<div class="form-group">'
    + '<label class="form-label">Vertical <span class="sb-tooltip" data-tip="Business type. Determines system prompt structure, conversion logic, room fields, and tool definitions. Matches production agentPersona.js.">?</span></label>'
    + '<select class="form-select" id="sbVertical" onchange="onVerticalChange(this.value)">'
    + '<option value="hotel">Hotel</option>'
    + '<option value="real_estate_sale">Real Estate (Sale)</option>'
    + '<option value="real_estate_rental">Real Estate (Rental)</option>'
    + '<option value="real_estate_development">Real Estate (Development)</option>'
    + '<option value="development">Development</option>'
    + '<option value="venue">Venue</option>'
    + '<option value="showroom">Showroom</option>'
    + '<option value="retail">Retail</option>'
    + '<option value="education">Education</option>'
    + '<option value="museum">Museum</option>'
    + '<option value="restaurant">Restaurant</option>'
    + '<option value="other">Other</option>'
    + '</select></div>'

    // Agent Name
    + '<div class="form-group">'
    + '<label class="form-label">Agent Name <span class="sb-tooltip" data-tip="The property/business name shown in the system prompt. In production this comes from the tenant\'s agent_name field.">?</span></label>'
    + '<input class="form-input" id="sbAgentName" placeholder="e.g. Hotel Nørrebro, DIS Copenhagen">'
    + '</div>'

    // Language
    + '<div class="form-group">'
    + '<label class="form-label">Language <span class="sb-tooltip" data-tip="The language the agent responds in. Production reads this from tenant settings.">?</span></label>'
    + '<select class="form-select" id="sbLanguage">'
    + '<option value="en">English</option>'
    + '<option value="da">Dansk</option>'
    + '<option value="de">Deutsch</option>'
    + '<option value="sv">Svenska</option>'
    + '<option value="no">Norsk</option>'
    + '<option value="fi">Suomi</option>'
    + '<option value="fr">Français</option>'
    + '<option value="es">Español</option>'
    + '<option value="it">Italiano</option>'
    + '<option value="nl">Nederlands</option>'
    + '<option value="pt">Português</option>'
    + '<option value="ja">日本語</option>'
    + '<option value="zh">中文</option>'
    + '<option value="ko">한국어</option>'
    + '</select></div>'

    // Conversion URL
    + '<div class="form-group">'
    + '<label class="form-label">Conversion URL <span class="sb-tooltip" data-tip="The booking/contact URL opened when the agent triggers conversion. In production this comes from tenant settings (booking_url).">?</span></label>'
    + '<input class="form-input" id="sbConversionUrl" placeholder="https://booking.example.com">'
    + '</div>'

    // Fixed production values info
    + '<div class="sb-fixed-info">'
    + '<span>Model: gpt-5.4-mini</span><span>Temp: 0.7</span><span>Turns: 16</span>'
    + '</div>'

    // ─── PROPERTY DATA (3-source pipeline) ───
    + '<div class="sb-section-header">Property Data</div>'

    + '<div class="sb-data-tabs">'
    + '<button class="sb-data-tab active" data-tab="manual" onclick="switchDataTab(\'manual\')">Manual</button>'
    + '<button class="sb-data-tab" data-tab="sync" onclick="switchDataTab(\'sync\')">Sync / Upload</button>'
    + '<button class="sb-data-tab" data-tab="compiled" onclick="switchDataTab(\'compiled\')">Compiled</button>'
    + '</div>'

    // Tab: Manual data
    + '<div class="sb-data-panel active" id="sbTabManual">'
    + '<textarea class="form-textarea" id="sbManualData" rows="4" placeholder="Manually enter property data — room types, prices, policies, amenities..." style="min-height:80px;max-height:300px;resize:vertical" oninput="updateWordCount()"></textarea>'
    + '</div>'

    // Tab: Sync / Upload
    + '<div class="sb-data-panel" id="sbTabSync">'
    + '<div style="margin-bottom:8px">'
    + '<label style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:6px">Sync from website</label>'
    + '<div style="display:flex;gap:8px;align-items:center">'
    + '<input class="form-input" id="sbSyncUrl" placeholder="https://example.com" style="flex:1;min-height:0;padding:7px 12px">'
    + '<button class="btn btn-outline btn-sm" onclick="syncFromURL()" id="sbSyncBtn">Sync</button>'
    + '</div>'
    + '</div>'
    + '<div style="margin-top:12px">'
    + '<label style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:block;margin-bottom:6px">Upload file</label>'
    + '<input type="file" id="sbFileInput" accept=".pdf,.txt,.csv,.json,.md,.xml,.docx" style="display:none" onchange="uploadPropertyFile(this)">'
    + '<button class="btn btn-outline btn-sm" onclick="document.getElementById(\'sbFileInput\').click()" id="sbUploadBtn" style="width:100%">Upload PDF / file</button>'
    + '</div>'
    + '<textarea class="form-textarea" id="sbScrapedData" rows="3" placeholder="Scraped/uploaded data appears here..." style="min-height:60px;max-height:200px;resize:vertical;margin-top:8px" oninput="updateWordCount()"></textarea>'
    + '</div>'

    // Tab: Compiled context
    + '<div class="sb-data-panel" id="sbTabCompiled">'
    + '<div class="sb-compile-status" id="sbCompileStatus">'
    + '<span style="color:var(--muted);font-size:12px">Not compiled yet. Click "Compile Context" to process data with GPT-4o-mini.</span>'
    + '</div>'
    + '<textarea class="form-textarea" id="sbCompiledContext" rows="5" placeholder="Compiled context will appear here after processing..." style="min-height:80px;max-height:300px;resize:vertical" readonly></textarea>'
    + '<button class="btn btn-outline btn-sm" onclick="compileContext()" id="sbCompileBtn" style="width:100%;margin-top:8px">Compile Context (GPT-4o-mini)</button>'
    + '</div>'

    // Word count bar
    + '<div class="sb-word-count" id="sbWordCount">'
    + '<span id="sbWordCountText">0 words</span>'
    + '<div class="sb-word-bar"><div class="sb-word-bar-fill" id="sbWordBarFill" style="width:0%"></div></div>'
    + '</div>'

    // Room Mappings (matches production rooms.html)
    + '<div class="sb-section-header" style="margin-top:20px">Marked Rooms</div>'
    + '<div class="form-group" style="margin-top:0">'
    + '<p style="font-size:11px;color:var(--muted);margin-bottom:8px">These are the areas your AI guide knows about</p>'
    + '<div class="room-mapper-howto" id="roomMapperHowto">'
    + '<p style="font-size:12px;color:var(--muted);line-height:1.6;margin:0"><strong style="color:var(--black)">How it works:</strong> Open your tour in a new tab, walk to a room, press <kbd>U</kbd> to copy the link, then click <strong>"+ Add Room"</strong> and paste it.</p>'
    + '<button class="btn btn-outline btn-sm" onclick="openTourInNewTab()" style="margin-top:8px;width:100%">Open tour in new tab</button>'
    + '</div>'
    + '<div class="room-card-list" id="roomCardList"></div>'
    + '<button class="space-add-btn" onclick="openAddRoomModal()">+ Add Room</button>'
    + '<textarea class="form-textarea" id="sbMappings" rows="0" style="display:none"></textarea>'
    + '</div>'

    // ─── DEMO QUESTIONS ───
    + '<div class="sb-section-header" style="margin-top:20px">Demo Questions</div>'
    + '<div class="form-group" style="margin-top:0">'
    + '<p style="font-size:11px;color:var(--muted);margin-bottom:8px">Quick-try questions shown as chips in the voice overlay</p>'
    + '<input class="form-input sb-demo-input" id="sbDemoQ1" placeholder="e.g. Can you show me around?">'
    + '<input class="form-input sb-demo-input" id="sbDemoQ2" placeholder="e.g. What rooms do you have?">'
    + '<input class="form-input sb-demo-input" id="sbDemoQ3" placeholder="e.g. How much does it cost?">'
    + '<input class="form-input sb-demo-input" id="sbDemoQ4" placeholder="(optional)">'
    + '<input class="form-input sb-demo-input" id="sbDemoQ5" placeholder="(optional)">'
    + '</div>'

    // ─── SDK CONTROLS (only in SDK mode) ───
    + (sdkMode ? (
        '<div class="sb-section-header" style="margin-top:20px">SDK Controls</div>'
        + '<div class="form-group" style="margin-top:0">'
        + '<p style="font-size:11px;color:var(--muted);margin-bottom:8px">Connect the Matterport Showcase SDK to the tour iframe, then test individual SDK methods.</p>'

        // Connection status + connect/disconnect
        + '<div class="sdk-status-row">'
        + '<div class="sdk-status-pill" id="sdkStatusPill"><span class="sdk-status-dot"></span><span id="sdkStatusText">Disconnected</span></div>'
        + '<button class="btn btn-dark btn-sm" id="sdkConnectBtn" onclick="sdkConnectSdk()">Connect SDK</button>'
        + '<button class="btn btn-outline btn-sm" id="sdkDisconnectBtn" onclick="sdkDisconnectInstance()" style="display:none">Disconnect</button>'
        + '</div>'

        // Mode switcher
        + '<div class="sdk-controls-group">'
        + '<label class="sdk-controls-label">View Mode</label>'
        + '<div class="sdk-button-row">'
        + '<button class="btn btn-outline btn-sm sdk-btn" onclick="sdkTestSetMode(\'inside\')">Inside</button>'
        + '<button class="btn btn-outline btn-sm sdk-btn" onclick="sdkTestSetMode(\'floorplan\')">Floor plan</button>'
        + '<button class="btn btn-outline btn-sm sdk-btn" onclick="sdkTestSetMode(\'dollhouse\')">Dollhouse</button>'
        + '</div>'
        + '<div style="font-size:11px;color:var(--muted);margin-top:4px">Current: <span id="sdkCurrentMode">—</span></div>'
        + '</div>'

        // Sweep navigation
        + '<div class="sdk-controls-group">'
        + '<label class="sdk-controls-label">Move To Sweep</label>'
        + '<div style="display:flex;gap:8px">'
        + '<select class="form-select sdk-btn" id="sdkSweepSelect" style="flex:1"><option value="">— Select sweep —</option></select>'
        + '<button class="btn btn-outline btn-sm sdk-btn" onclick="sdkTestMoveToSelectedSweep()">Go</button>'
        + '</div>'
        + '<div style="font-size:11px;color:var(--muted);margin-top:4px">Current: <span id="sdkCurrentSweep">—</span></div>'
        + '</div>'

        // Floor switcher
        + '<div class="sdk-controls-group">'
        + '<label class="sdk-controls-label">Move To Floor</label>'
        + '<div style="display:flex;gap:8px">'
        + '<select class="form-select sdk-btn" id="sdkFloorSelect" style="flex:1"><option value="">— Select floor —</option></select>'
        + '<button class="btn btn-outline btn-sm sdk-btn" onclick="sdkTestMoveToSelectedFloor()">Go</button>'
        + '</div>'
        + '</div>'

        // Info / debugging buttons
        + '<div class="sdk-controls-group">'
        + '<label class="sdk-controls-label">Inspect</label>'
        + '<div class="sdk-button-row" style="flex-wrap:wrap">'
        + '<button class="btn btn-outline btn-sm sdk-btn" onclick="sdkTestGetCameraPose()">Camera pose</button>'
        + '<button class="btn btn-outline btn-sm sdk-btn" onclick="sdkTestGetModelData()">Model info</button>'
        + '<button class="btn btn-outline btn-sm sdk-btn" onclick="sdkTestRefreshSweeps()">Refresh sweeps</button>'
        + '</div>'
        + '</div>'

        // Event console
        + '<div class="sdk-controls-group">'
        + '<label class="sdk-controls-label">SDK Event Console</label>'
        + '<div class="sdk-event-log" id="sdkEventLog"><div style="color:var(--muted);font-size:11px">No events yet. Connect the SDK to begin.</div></div>'
        + '<button class="btn btn-outline btn-sm" onclick="sdkClearEventLog()" style="width:100%;margin-top:6px">Clear log</button>'
        + '</div>'

        + '</div>' // end form-group
      ) : '')

    // Action buttons
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
    + '<button class="btn btn-dark" onclick="saveAndStartSession()" style="flex:1">Save &amp; Start Session</button>'
    + '</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">'
    + '<button class="btn btn-outline btn-sm" onclick="previewSystemPrompt()" style="flex:1">Preview System Prompt</button>'
    + '<button class="btn btn-outline btn-sm" onclick="saveSandboxConfig()">Save config</button>'
    + '</div>'

    // Persistent Debug Log
    + '<div class="plog-panel" id="plogPanel">'
    + '<div class="plog-header" onclick="togglePlogPanel()">'
    + '<div class="plog-header-left">Debug Log <span class="plog-header-count" id="plogCount">0</span></div>'
    + '<span class="plog-chevron">▼</span>'
    + '</div>'
    + '<div class="plog-body">'
    + '<div class="plog-actions">'
    + '<button onclick="exportPlog()">Export log</button>'
    + '<button onclick="clearPlogToday()">Clear today</button>'
    + '<select id="plogDaySelect" onchange="viewPlogDay(this.value)" style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;font-size:11px;font-family:var(--sans);background:var(--white);color:var(--muted);cursor:pointer"><option value="today">Today</option></select>'
    + '</div>'
    + '<div class="plog-entries" id="plogEntries"><div class="plog-empty">No changes logged yet.</div></div>'
    + '</div>'
    + '</div>'

    // Pipeline debug (turn-level telemetry)
    + '<details class="debug-panel" id="debugPanel" style="margin-top:12px">'
    + '<summary>Pipeline Telemetry</summary>'
    + '<div id="debugContent"><div style="color:var(--muted);font-size:12px">No turns yet.</div></div>'
    + '<button class="btn btn-outline btn-sm" onclick="clearDebugLog()" style="margin-top:8px">Clear</button>'
    + '</details>'

    + '</div>' // end sandbox-config

    // ═══ ZONE 2+3: TOUR + VOICE OVERLAY ═══
    + '<div class="sandbox-tour" id="sbTourContainer">'
    + '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-size:14px">Enter a Matterport Model ID and click Apply</div>'

    // Loading overlay
    + '<div class="sb-loading-overlay hidden" id="sbLoadingOverlay">'
    + '<div class="sb-loading-name" id="sbLoadingName">AI Concierge</div>'
    + '<div class="sb-loading-dots"><span></span><span></span><span></span></div>'
    + '<div class="sb-loading-sub">Connecting to voice agent...</div>'
    + '</div>'

    // Fade overlay for navigation
    + '<div class="sb-fade" id="sbFade"></div>'

    // Floor plan overlay (shown when agent triggers set_view_mode:floorplan)
    + '<div class="sb-floorplan-overlay" id="sbFloorplanOverlay">'
    + '<img id="sbFloorplanImg" alt="Floor plan">'
    + '<button class="sb-floorplan-close" onclick="hideFloorplanOverlay()">\u2715 Close</button>'
    + '</div>'

    // Admin toggle button
    + '<button class="sb-admin-toggle" id="sbAdminToggle" onclick="toggleAdminPanel()">\u2699 Admin</button>'

    // Agent icon (matches production)
    + '<div class="sb-agent-icon" id="sbAgentIcon" onclick="toggleTranscript()">'
    + '<svg viewBox="0 0 24 24" fill="none"><path d="M5 18.5C5 16.567 6.567 15 8.5 15h7C17.433 15 19 16.567 19 18.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="9" r="3.5" stroke="currentColor" stroke-width="1.7"/></svg>'
    + '<div class="sb-waves"><div class="sb-wave"></div><div class="sb-wave"></div><div class="sb-wave"></div></div>'
    + '</div>'

    // Transcript panel (overlay)
    + '<div class="sb-transcript" id="sbTranscript"></div>'

    // Text input bar (overlay)
    + '<div class="sb-input-bar" id="sbInputBar">'
    + '<input id="sbTextInput" placeholder="Type a message..." onkeydown="if(event.key===\'Enter\'){sendTextInput();event.preventDefault()}">'
    + '<button onclick="sendTextInput()">Send</button>'
    + '</div>'

    // Demo question button (chips populated dynamically)
    + '<button class="sb-demo-btn" id="sbDemoBtn" onclick="toggleDemoPanel()">?</button>'
    + '<div class="sb-demo-panel" id="sbDemoPanel">'
    + '<div class="sb-demo-title">Try asking</div>'
    + '<div id="sbDemoChips"></div>'
    + '</div>'

    // Latency display
    + '<div class="sb-latency" id="sbLatency"><span>STT: \u2014</span><span>LLM: \u2014</span><span>TTS: \u2014</span></div>'

    + '</div>' // end sandbox-tour
    + '</div>' // end sandbox-layout

    // ═══ ADD ROOM MODAL (matches production rooms.html) ═══
    + '<div class="room-modal-overlay" id="roomModalOverlay" onclick="if(event.target===this)closeRoomModal()">'
    + '<div class="room-modal">'
    + '<h3 style="font-family:var(--serif);font-size:22px;font-weight:400;margin-bottom:16px">Add a room</h3>'
    + '<div class="field-group" style="margin-bottom:14px">'
    + '<label style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;display:block;font-weight:500">1. Paste the link from Matterport</label>'
    + '<input class="form-input" type="text" id="rmUrlInput" placeholder="Paste the link you copied after pressing U" oninput="rmValidateUrl(this)">'
    + '<div id="rmExtracted" style="font-size:11px;color:var(--green);margin-top:4px;display:none"></div>'
    + '<div id="rmError" style="font-size:11px;color:var(--red);margin-top:4px;display:none"></div>'
    + '</div>'
    + '<div class="field-group" style="margin-bottom:14px">'
    + '<label style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;display:block;font-weight:500">2. Name this room</label>'
    + '<input class="form-input" type="text" id="rmNameInput" placeholder="e.g. Lobby, Restaurant, Junior Suite" onkeydown="if(event.key===\'Enter\')confirmAddRoom()">'
    + '</div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end">'
    + '<button class="btn btn-outline btn-sm" onclick="closeRoomModal()">Cancel</button>'
    + '<button class="btn btn-dark btn-sm" onclick="confirmAddRoom()">Add Room</button>'
    + '</div>'
    + '</div>'
    + '</div>'

    // ═══ PREVIEW PROMPT MODAL ═══
    + '<div class="room-modal-overlay" id="promptPreviewOverlay" onclick="if(event.target===this)closePromptPreview()">'
    + '<div class="room-modal" style="max-width:700px;max-height:80vh;overflow:auto">'
    + '<h3 style="font-family:var(--serif);font-size:22px;font-weight:400;margin-bottom:16px">System Prompt Preview</h3>'
    + '<div id="promptPreviewMeta" style="font-size:11px;color:var(--muted);margin-bottom:12px"></div>'
    + '<textarea class="form-textarea" id="promptPreviewText" rows="20" readonly style="font-family:monospace;font-size:11px;min-height:300px"></textarea>'
    + '<div style="display:flex;gap:8px;margin-top:12px">'
    + '<button class="btn btn-dark btn-sm" onclick="navigator.clipboard.writeText(document.getElementById(\'promptPreviewText\').value);showToast(\'Copied!\',\'success\')">Copy</button>'
    + '<button class="btn btn-outline btn-sm" onclick="closePromptPreview()">Close</button>'
    + '</div>'
    + '</div>'
    + '</div>';

  c.innerHTML = html;

  // Init
  loadTenantDropdown();
  checkAPIKeys();
  initTooltips();
  initPlogDaySelect();
  renderPlog();
  renderRoomCards();
  updateWordCount();
  populateDemoChips();
  updateFloorplanPreview();

  // SDK-only init
  if (sdkMode) {
    sdkInitKeyField();
    sdkRenderEventLog();
    sdkRefreshStatusUI();
  }
}

/* Thin entry point for the new sidebar page */
function loadSdkSandbox() {
  loadSandbox({ sdkMode: true });
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

  // In SDK mode we must tear down any prior SDK instance before swapping the iframe
  if (sdkSandboxActive) {
    try { sdkDisconnectInstance(); } catch (e) {}
  }

  // Clear existing content except overlays
  var container = document.getElementById('sbTourContainer');
  var existingIframe = container.querySelector('iframe');
  var placeholder = container.querySelector('div:not([class])');
  if (placeholder && !placeholder.className) placeholder.remove();
  if (existingIframe) existingIframe.remove();

  var iframe = document.createElement('iframe');

  // In SDK mode we append the application key AND set xr-spatial-tracking perm
  if (sdkSandboxActive) {
    var appKey = sdkGetAppKey();
    if (!appKey) {
      showToast('Paste your SDK Application Key first', 'error');
      sdkLogEvent('error', 'No SDK application key — cannot load tour in SDK mode');
      return;
    }
    iframe.src = 'https://my.matterport.com/show/?m=' + encodeURIComponent(modelId)
      + '&applicationKey=' + encodeURIComponent(appKey)
      + '&play=1&qs=1';
    iframe.allow = 'microphone; autoplay; xr-spatial-tracking; fullscreen';
  } else {
    iframe.src = 'https://my.matterport.com/show/?m=' + encodeURIComponent(modelId) + '&play=1&qs=1';
    iframe.allow = 'microphone; autoplay';
  }

  iframe.allowFullscreen = true;
  iframe.id = 'sbTourIframe';
  iframe.style.cssText = 'width:100%;height:100%;border:none;display:block';
  // Insert iframe as first child (behind overlays)
  container.insertBefore(iframe, container.firstChild);
  showToast('Tour loaded', 'success');

  // In SDK mode, kick off SDK connect as soon as the iframe has loaded
  if (sdkSandboxActive) {
    iframe.addEventListener('load', function onLoad() {
      iframe.removeEventListener('load', onLoad);
      sdkLogEvent('info', 'Tour iframe loaded — connecting SDK...');
      sdkConnectSdk();
    }, { once: true });
  }
}

/* ── (resetPrompt removed — production generates prompts dynamically via agentPersona.js) ── */

/* ═══════════════════════════════════════════════════
   NEW SANDBOX FUNCTIONS — Production-matching pipeline
   ═══════════════════════════════════════════════════ */

/* ── Data tab switching ── */
function switchDataTab(tab) {
  sandboxActiveDataTab = tab;
  document.querySelectorAll('.sb-data-tab').forEach(function(el) {
    el.classList.toggle('active', el.getAttribute('data-tab') === tab);
  });
  document.getElementById('sbTabManual').classList.toggle('active', tab === 'manual');
  document.getElementById('sbTabSync').classList.toggle('active', tab === 'sync');
  document.getElementById('sbTabCompiled').classList.toggle('active', tab === 'compiled');
}

/* ── Word count bar ── */
function updateWordCount() {
  var manual = (document.getElementById('sbManualData') || {}).value || '';
  var scraped = (document.getElementById('sbScrapedData') || {}).value || '';
  var combined = (manual + ' ' + scraped).trim();
  var words = combined ? combined.split(/\s+/).length : 0;
  var chars = combined.length;

  var textEl = document.getElementById('sbWordCountText');
  var barEl = document.getElementById('sbWordBarFill');
  if (textEl) textEl.textContent = words + ' words / ' + chars + ' chars';

  // Production compiled context target is ~2000 tokens (~8000 chars). Show fill relative to that.
  var pct = Math.min(100, Math.round((chars / 8000) * 100));
  if (barEl) {
    barEl.style.width = pct + '%';
    barEl.style.background = pct > 90 ? 'var(--red)' : pct > 60 ? 'var(--green)' : 'var(--muted)';
  }
}

/* ── Compile Context (GPT-4o-mini, matches production contextCompiler) ── */
function compileContext() {
  var manual = (document.getElementById('sbManualData') || {}).value || '';
  var scraped = (document.getElementById('sbScrapedData') || {}).value || '';
  var combined = manual;
  if (manual && scraped) combined = manual + '\n\n--- Scraped Data ---\n\n' + scraped;
  else if (scraped) combined = scraped;

  if (!combined.trim()) {
    showToast('No property data to compile. Add data in Manual or Sync tab first.', 'error');
    return;
  }

  var btn = document.getElementById('sbCompileBtn');
  var statusEl = document.getElementById('sbCompileStatus');
  btn.textContent = 'Compiling...';
  btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--muted);font-size:12px">Compiling with GPT-4o-mini...</span>';

  fetch('/admin/compile-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({
      propertyData: combined,
      propertyName: (document.getElementById('sbAgentName') || {}).value || '',
      vertical: (document.getElementById('sbVertical') || {}).value || 'hotel',
      bookingUrl: (document.getElementById('sbConversionUrl') || {}).value || '',
      roomMappings: localRooms
    })
  }).then(function(r) { return r.json(); }).then(function(data) {
    btn.textContent = 'Compile Context (GPT-4o-mini)';
    btn.disabled = false;
    if (data.error) {
      showToast(data.error, 'error');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--red);font-size:12px">Compilation failed: ' + esc(data.error) + '</span>';
      return;
    }
    sandboxCompiledContext = data.compiledContext || '';
    var ctxEl = document.getElementById('sbCompiledContext');
    if (ctxEl) ctxEl.value = sandboxCompiledContext;
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--green);font-size:12px">Compiled: ' + (data.chars || 0) + ' chars in ' + (data.durationMs || 0) + 'ms</span>';
    plog('COMPILE', '', sandboxCompiledContext.length + ' chars', 'GPT-4o-mini, ' + (data.durationMs || 0) + 'ms');
    showToast('Context compiled', 'success');
    // Switch to compiled tab to show result
    switchDataTab('compiled');
  }).catch(function(err) {
    btn.textContent = 'Compile Context (GPT-4o-mini)';
    btn.disabled = false;
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--red);font-size:12px">Compilation error</span>';
    showToast('Failed to compile context', 'error');
    console.error('[COMPILE]', err);
  });
}

/* ── Preview System Prompt (shows what agentPersona would generate) ── */
function previewSystemPrompt() {
  var overlay = document.getElementById('promptPreviewOverlay');
  if (!overlay) return;

  var metaEl = document.getElementById('promptPreviewMeta');
  var textEl = document.getElementById('promptPreviewText');
  if (textEl) textEl.value = 'Generating preview...';
  if (metaEl) metaEl.textContent = '';
  overlay.classList.add('open');

  // Build the config for preview
  var manual = (document.getElementById('sbManualData') || {}).value || '';
  var scraped = (document.getElementById('sbScrapedData') || {}).value || '';
  var propertyData = manual;
  if (manual && scraped) propertyData = manual + '\n\n--- Scraped Data ---\n\n' + scraped;
  else if (scraped) propertyData = scraped;

  fetch('/admin/preview-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({
      vertical: (document.getElementById('sbVertical') || {}).value || 'hotel',
      agentName: (document.getElementById('sbAgentName') || {}).value || '',
      language: (document.getElementById('sbLanguage') || {}).value || 'en',
      conversionUrl: (document.getElementById('sbConversionUrl') || {}).value || '',
      compiledContext: sandboxCompiledContext || propertyData,
      roomMappings: localRooms
    })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.error) {
      if (textEl) textEl.value = 'Error: ' + data.error;
      return;
    }
    if (textEl) textEl.value = data.systemPrompt || '';
    if (metaEl) metaEl.textContent = (data.characterCount || 0) + ' chars | ' + (data.toolCount || 0) + ' tools';
  }).catch(function(err) {
    if (textEl) textEl.value = 'Failed to generate preview: ' + err.message;
  });
}

function closePromptPreview() {
  var overlay = document.getElementById('promptPreviewOverlay');
  if (overlay) overlay.classList.remove('open');
}

/* ── Get Demo Questions from inputs ── */
function getDemoQuestions() {
  var qs = [];
  for (var i = 1; i <= 5; i++) {
    var el = document.getElementById('sbDemoQ' + i);
    if (el && el.value.trim()) qs.push(el.value.trim());
  }
  return qs;
}

/* ── Populate demo chips in voice overlay from inputs ── */
function populateDemoChips() {
  var container = document.getElementById('sbDemoChips');
  if (!container) return;
  var qs = getDemoQuestions();
  if (qs.length === 0) {
    // Default demo questions
    qs = ['Can you show me around?', 'What rooms do you have?', 'How much does it cost?'];
  }
  container.innerHTML = qs.map(function(q) {
    return '<button class="sb-demo-chip" onclick="sendDemoQuestion(this)">' + esc(q) + '</button>';
  }).join('');
}

/* ── Save & Start Session (replaces old applyAndRestart) ── */
function saveAndStartSession() {
  if (!validateRoomMappings()) return;
  // Store data state
  sandboxManualData = (document.getElementById('sbManualData') || {}).value || '';
  sandboxScrapedData = (document.getElementById('sbScrapedData') || {}).value || '';
  // Update demo chips
  populateDemoChips();
  // Update loading overlay name
  var nameEl = document.getElementById('sbLoadingName');
  var agentName = (document.getElementById('sbAgentName') || {}).value || 'AI Concierge';
  if (nameEl) nameEl.textContent = agentName;
  plog('SESSION', '', 'start', 'Save & Start Session');
  startSandboxSession();
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
  var tenantName = t.agent_name || t.name || 'tenant';
  plog('TENANT', '', tenantName, 'loaded from dropdown');
  // Model ID
  if (t.matterport_model_id) {
    document.getElementById('sbModelId').value = t.matterport_model_id;
    loadTour();
  }
  // Agent name
  var nameEl = document.getElementById('sbAgentName');
  if (nameEl) nameEl.value = t.agent_name || t.name || '';
  // Language
  var langEl = document.getElementById('sbLanguage');
  if (langEl && t.language) langEl.value = t.language;
  // Conversion URL (production COALESCEs conversion_url with legacy booking_url)
  var urlEl = document.getElementById('sbConversionUrl');
  if (urlEl && (t.conversion_url || t.booking_url)) urlEl.value = t.conversion_url || t.booking_url;
  // Property data → manual data tab
  if (t.property_data) {
    var dataStr = typeof t.property_data === 'string' ? t.property_data : JSON.stringify(t.property_data, null, 2);
    var manualEl = document.getElementById('sbManualData');
    if (manualEl) manualEl.value = dataStr;
    sandboxManualData = dataStr;
    plog('PROPERTY_DATA', '', 'loaded from ' + tenantName);
  }
  // Compiled context (if tenant has it)
  if (t.compiled_context) {
    sandboxCompiledContext = typeof t.compiled_context === 'string' ? t.compiled_context : JSON.stringify(t.compiled_context, null, 2);
    var compiledEl = document.getElementById('sbCompiledContext');
    if (compiledEl) compiledEl.value = sandboxCompiledContext;
    var statusEl = document.getElementById('sbCompileStatus');
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--green);font-size:12px">Loaded from tenant</span>';
  }
  // Room mappings — load into space mapper
  if (t.room_mappings) {
    var mappings = typeof t.room_mappings === 'string' ? JSON.parse(t.room_mappings || '{}') : (t.room_mappings || {});
    renderSpaces(mappings);
    plog('ROOM_MAPPING', '', 'loaded from ' + tenantName);
  }
  // Vertical
  if (t.vertical) {
    var oldV = document.getElementById('sbVertical').value;
    document.getElementById('sbVertical').value = t.vertical;
    if (oldV !== t.vertical) {
      plog('VERTICAL', oldV, t.vertical, 'from tenant');
      _prevVertical = t.vertical;
    }
  }
  // Demo questions (if tenant has them)
  if (t.demo_questions && Array.isArray(t.demo_questions)) {
    for (var i = 0; i < 5; i++) {
      var qEl = document.getElementById('sbDemoQ' + (i + 1));
      if (qEl) qEl.value = t.demo_questions[i] || '';
    }
    populateDemoChips();
  }
  updateWordCount();
  showToast('Loaded: ' + tenantName, 'success');
}

/* ── Sync from URL (Jina Reader) → scraped data tab ── */
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
    var scrapedEl = document.getElementById('sbScrapedData');
    if (scrapedEl) scrapedEl.value = data.text || '';
    sandboxScrapedData = data.text || '';
    plog('SYNC', url, 'scraped data synced', data.source || 'raw');
    updateWordCount();
    showToast('Synced from website', 'success');
  }).catch(function(e) {
    btn.textContent = 'Sync';
    btn.disabled = false;
    showToast('Could not access this URL. Try pasting the content manually.', 'error');
  });
}

/* ── Upload Property File (PDF, TXT, CSV, etc.) → scraped data tab ── */
function uploadPropertyFile(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var btn = document.getElementById('sbUploadBtn');
  var dataEl = document.getElementById('sbScrapedData');
  btn.textContent = 'Extracting...';
  btn.disabled = true;

  function resetBtn() {
    btn.textContent = 'Upload PDF / file';
    btn.disabled = false;
    input.value = '';
  }

  function setScrapedData(text) {
    if (dataEl) {
      dataEl.value = text;
      dataEl.style.height = 'auto';
      dataEl.style.height = Math.min(dataEl.scrollHeight, 200) + 'px';
    }
    sandboxScrapedData = text;
    updateWordCount();
  }

  // For plain text files: read client-side
  var ext = file.name.split('.').pop().toLowerCase();
  if (['txt', 'csv', 'json', 'md', 'xml'].indexOf(ext) !== -1) {
    var reader = new FileReader();
    reader.onload = function(e) {
      setScrapedData(e.target.result || '');
      plog('FILE_UPLOAD', '', file.name, 'text file loaded (' + ext + ')');
      showToast('Loaded: ' + file.name, 'success');
      resetBtn();
    };
    reader.onerror = function() {
      showToast('Could not read file', 'error');
      resetBtn();
    };
    reader.readAsText(file);
    return;
  }

  // For PDF / DOCX: send to server for extraction
  var formData = new FormData();
  formData.append('file', file);
  fetch('/admin/extract-file', {
    method: 'POST',
    headers: { 'x-admin-token': TOKEN },
    body: formData
  }).then(function(r) { return r.json(); }).then(function(data) {
    resetBtn();
    if (data.error) { showToast(data.error, 'error'); return; }
    if (!data.text || !data.text.trim()) {
      showToast('No text found in file — is it a scanned image PDF?', 'error');
      return;
    }
    setScrapedData(data.text);
    var info = file.name;
    if (data.pages) info += ' (' + data.pages + ' pages)';
    if (data.source === 'structured') info += ' — AI-structured';
    plog('FILE_UPLOAD', '', file.name, (data.source || 'raw') + (data.pages ? ', ' + data.pages + ' pages' : ''));
    showToast('Loaded: ' + info, 'success');
  }).catch(function(err) {
    resetBtn();
    showToast('Failed to extract text from file', 'error');
    console.error('[UPLOAD]', err);
  });
}

/* ══════════════════════════════════════════════════
   ROOM MAPPER (1:1 copy of production rooms.html)
   ══════════════════════════════════════════════════ */
var localRooms = {};

/* ── Sweep ID extraction from Matterport URLs ── */
function extractSweepId(input) {
  if (!input) return null;
  var match = input.match(/[?&]ss=([^&]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]+$/.test(input) && input.length > 5 && input.length < 40) return input;
  return null;
}

/* ── Open tour in new tab (like production rooms.html) ── */
window.openTourInNewTab = function() {
  var modelId = (document.getElementById('sbModelId').value || '').trim();
  if (!modelId) { showToast('Load a Matterport tour first', 'error'); return; }
  window.open('https://my.matterport.com/show/?m=' + modelId + '&play=1', '_blank');
};

/* ── Navigate tour iframe to a sweep ID (like production rooms.html) ── */
function goToSweep(sweepId) {
  if (!sweepId) return;
  var modelId = (document.getElementById('sbModelId').value || '').trim();
  if (!modelId) { showToast('Load a Matterport tour first', 'error'); return; }
  var iframe = document.querySelector('#sbTourContainer iframe');
  if (!iframe) { showToast('No tour loaded', 'error'); return; }
  var fadeEl = document.getElementById('sbFade');
  var newUrl = 'https://my.matterport.com/show/?m=' + encodeURIComponent(modelId) + '&ss=' + encodeURIComponent(sweepId) + '&sr=-.05,.5&play=1&qs=1';
  if (fadeEl) {
    fadeEl.classList.add('active');
    setTimeout(function() {
      iframe.src = newUrl;
      iframe.addEventListener('load', function onLoad() {
        iframe.removeEventListener('load', onLoad);
        setTimeout(function() { fadeEl.classList.remove('active'); }, 400);
      }, { once: true });
      setTimeout(function() { fadeEl.classList.remove('active'); }, 4000);
    }, 350);
  } else {
    iframe.src = newUrl;
  }
  showToast('Navigating to sweep...', 'success');
}

/* ── Load rooms from mappings object ── */
function renderSpaces(mappings) {
  localRooms = {};
  if (!mappings || typeof mappings !== 'object') return;
  Object.keys(mappings).forEach(function(key) {
    var entry = mappings[key];
    if (typeof entry === 'object') {
      localRooms[key] = { label: entry.label || key, sweepId: entry.sweepId || '' };
    } else {
      localRooms[key] = { label: entry || key, sweepId: '' };
    }
  });
  renderRoomCards();
}

/* ── Render room cards (matches production rooms.html layout) ── */
function renderRoomCards() {
  var container = document.getElementById('roomCardList');
  if (!container) return;
  var keys = Object.keys(localRooms);

  if (keys.length === 0) {
    container.innerHTML = '<div class="room-empty-state">'
      + '<div style="font-size:20px;margin-bottom:6px">📍</div>'
      + '<div style="font-size:12px;color:var(--muted)">No rooms mapped yet</div>'
      + '</div>';
    syncRoomsToHiddenField();
    return;
  }

  container.innerHTML = keys.map(function(key) {
    var r = localRooms[key];
    return '<div class="room-card" onclick="goToSweep(\'' + esc(r.sweepId) + '\')">'
      + '<div class="room-card-delete" onclick="event.stopPropagation();deleteRoom(\'' + esc(key) + '\')" title="Remove">✕</div>'
      + '<div class="room-card-label">' + esc(r.label) + '</div>'
      + '<div class="room-card-sweep">sweep: ' + (r.sweepId ? esc(r.sweepId) : '<span style="color:var(--red)">missing</span>') + '</div>'
      + '</div>';
  }).join('');

  syncRoomsToHiddenField();
}

/* ── Delete room ── */
window.deleteRoom = function(key) {
  var label = localRooms[key] ? localRooms[key].label : key;
  delete localRooms[key];
  renderRoomCards();
  plog('ROOM_MAPPING', label, 'deleted');
  showToast('Room deleted', 'success');
};

/* ── Sync localRooms to hidden textarea for pipeline config ── */
function syncRoomsToHiddenField() {
  var ta = document.getElementById('sbMappings');
  if (ta) ta.value = JSON.stringify(localRooms, null, 2);
}

/* ── Add Room Modal (matches production rooms.html modal) ── */
window.openAddRoomModal = function() {
  var overlay = document.getElementById('roomModalOverlay');
  if (!overlay) return;
  document.getElementById('rmUrlInput').value = '';
  document.getElementById('rmNameInput').value = '';
  document.getElementById('rmExtracted').style.display = 'none';
  document.getElementById('rmError').style.display = 'none';
  overlay.classList.add('open');
  setTimeout(function() { document.getElementById('rmUrlInput').focus(); }, 100);
};

window.closeRoomModal = function() {
  var overlay = document.getElementById('roomModalOverlay');
  if (overlay) overlay.classList.remove('open');
};

/* ── Live URL validation in modal (matches production) ── */
window.rmValidateUrl = function(el) {
  var val = el.value.trim();
  var extracted = document.getElementById('rmExtracted');
  var error = document.getElementById('rmError');
  if (!val) { extracted.style.display = 'none'; error.style.display = 'none'; return; }
  var sweepId = extractSweepId(val);
  if (sweepId) {
    extracted.textContent = '✓ Position detected: ' + sweepId;
    extracted.style.display = 'block';
    error.style.display = 'none';
  } else if (val.indexOf('matterport.com') !== -1) {
    error.textContent = 'Link found but no room position in it. Make sure you pressed U while standing in the room, then copied the link.';
    error.style.display = 'block';
    extracted.style.display = 'none';
  } else {
    error.textContent = 'This doesn\'t look like a Matterport link. Press U in the tour to get the right link.';
    error.style.display = 'block';
    extracted.style.display = 'none';
  }
};

/* ── Confirm add room (matches production confirmAdd) ── */
window.confirmAddRoom = function() {
  var url = document.getElementById('rmUrlInput').value.trim();
  var label = document.getElementById('rmNameInput').value.trim();
  if (!url) { showToast('Paste the Matterport URL first', 'error'); return; }
  var sweepId = extractSweepId(url);
  if (!sweepId) { showToast('Could not find a position in that URL. Make sure you navigated to the room first.', 'error'); return; }
  if (!label) { showToast('Give the room a name', 'error'); return; }
  var key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!key) key = 'room_' + Date.now();
  var baseKey = key; var n = 2;
  while (localRooms[key]) { key = baseKey + '_' + n; n++; }
  localRooms[key] = { label: label, sweepId: sweepId };
  closeRoomModal();
  renderRoomCards();
  plog('ROOM_MAPPING', '', label, 'added (sweep: ' + sweepId + ')');
  showToast('Added: ' + label, 'success');
};

/* ── Validate Room Mappings (for Apply & Restart) ── */
function validateRoomMappings() {
  syncRoomsToHiddenField();
  return true;
}

/* ══════════════════════════════════════════════════
   PRODUCTION REFERENCE — always visible info box
   Uses PROD_DEFAULTS as fallback when API unavailable
   ══════════════════════════════════════════════════ */
function renderProdRefContent(contentEl, vertical) {
  var d = PROD_DEFAULTS;
  var vLabel = (vertical || 'hotel').replace(/_/g, ' ');
  vLabel = vLabel.charAt(0).toUpperCase() + vLabel.slice(1);
  contentEl.innerHTML = '<div class="prod-ref-title">PRODUCTION DEFAULTS — ' + esc(vLabel) + '</div>'
    + '<div class="prod-ref-grid">'
    + '<span class="prod-ref-item">' + d.llm.model + '</span>'
    + '<span class="prod-ref-item">temp ' + d.llm.temperature + '</span>'
    + '<span class="prod-ref-item">STT: ' + d.stt.model + '</span>'
    + '<span class="prod-ref-item">TTS: ' + d.tts.model + '</span>'
    + '<span class="prod-ref-item">VAD: ' + d.vad.speechThreshold + ' threshold</span>'
    + '<span class="prod-ref-item">Echo: ' + d.session.echoSuppression + '</span>'
    + '</div>';
}

function loadProductionRef() {
  var vertical = document.getElementById('sbVertical');
  if (!vertical) return;
  var contentEl = document.getElementById('prodRefContent');
  if (!contentEl) return;
  renderProdRefContent(contentEl, vertical.value);
}

/* ══════════════════════════════════════════════════
   PERSISTENT DEBUG LOG (localStorage)
   ══════════════════════════════════════════════════ */
var PLOG_PREFIX = 'october_debug_log_';
var plogCurrentDay = 'today';

function plogKey(dateStr) {
  if (!dateStr || dateStr === 'today') {
    return PLOG_PREFIX + new Date().toISOString().split('T')[0];
  }
  return PLOG_PREFIX + dateStr;
}

function plogRead(dateStr) {
  try {
    var raw = localStorage.getItem(plogKey(dateStr));
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function plogWrite(entries, dateStr) {
  try {
    localStorage.setItem(plogKey(dateStr), JSON.stringify(entries));
  } catch(e) {}
}

function plog(type, from, to, detail) {
  var entries = plogRead('today');
  entries.unshift({
    timestamp: new Date().toISOString(),
    type: type,
    from: from || '',
    to: to || '',
    detail: detail || ''
  });
  // Cap at 500 entries per day
  if (entries.length > 500) entries = entries.slice(0, 500);
  plogWrite(entries, 'today');
  renderPlog();
  plogCleanOld();
}

function plogCleanOld() {
  var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (key && key.startsWith(PLOG_PREFIX)) {
      var dateStr = key.replace(PLOG_PREFIX, '');
      var d = new Date(dateStr);
      if (!isNaN(d.getTime()) && d.getTime() < cutoff) {
        localStorage.removeItem(key);
      }
    }
  }
}

function renderPlog() {
  var el = document.getElementById('plogEntries');
  var countEl = document.getElementById('plogCount');
  if (!el) return;

  var entries = plogRead(plogCurrentDay === 'today' ? 'today' : plogCurrentDay);
  if (countEl) countEl.textContent = entries.length;

  if (entries.length === 0) {
    el.innerHTML = '<div class="plog-empty">No changes logged' + (plogCurrentDay !== 'today' ? ' on this day' : ' yet') + '.</div>';
    return;
  }

  var html = '';
  entries.forEach(function(e) {
    var time = new Date(e.timestamp);
    var timeStr = time.toTimeString().split(' ')[0]; // HH:MM:SS
    html += '<div class="plog-entry">'
      + '<span class="plog-time">[' + timeStr + ']</span>'
      + '<span class="plog-type ' + esc(e.type) + '">' + esc(e.type) + '</span>';
    if (e.from && e.to) {
      html += '<span>' + esc(String(e.from).substring(0, 40)) + '</span>'
        + '<span class="plog-arrow">→</span>'
        + '<span>' + esc(String(e.to).substring(0, 40)) + '</span>';
    } else if (e.to) {
      html += '<span>' + esc(String(e.to).substring(0, 80)) + '</span>';
    } else if (e.from) {
      html += '<span>' + esc(String(e.from).substring(0, 80)) + '</span>';
    }
    if (e.detail) html += ' <span style="color:var(--muted)">(' + esc(String(e.detail).substring(0, 40)) + ')</span>';
    html += '</div>';
  });
  el.innerHTML = html;
}

function togglePlogPanel() {
  var panel = document.getElementById('plogPanel');
  if (panel) panel.classList.toggle('open');
}

function clearPlogToday() {
  if (!confirm('Clear all debug log entries for today?')) return;
  localStorage.removeItem(plogKey('today'));
  renderPlog();
  showToast('Debug log cleared', 'success');
}

function initPlogDaySelect() {
  var sel = document.getElementById('plogDaySelect');
  if (!sel) return;
  var html = '<option value="today">Today</option>';
  // Find previous days
  var days = [];
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (key && key.startsWith(PLOG_PREFIX)) {
      var dateStr = key.replace(PLOG_PREFIX, '');
      var today = new Date().toISOString().split('T')[0];
      if (dateStr !== today && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        days.push(dateStr);
      }
    }
  }
  days.sort().reverse();
  days.forEach(function(d) {
    html += '<option value="' + d + '">' + d + '</option>';
  });
  sel.innerHTML = html;
}

function viewPlogDay(val) {
  plogCurrentDay = val;
  renderPlog();
}

function exportPlog() {
  var entries = plogRead(plogCurrentDay === 'today' ? 'today' : plogCurrentDay);
  if (entries.length === 0) { showToast('No log entries to export', 'error'); return; }

  var dateLabel = plogCurrentDay === 'today' ? new Date().toISOString().split('T')[0] : plogCurrentDay;

  // Build export text
  var lines = [];
  lines.push('═══════════════════════════════════════');
  lines.push('OCTOBER AI — ADMIN DEBUG LOG');
  lines.push('Date: ' + dateLabel);
  lines.push('Entries: ' + entries.length);
  lines.push('═══════════════════════════════════════');
  lines.push('');
  lines.push('CHANGES MADE:');
  lines.push('─────────────');

  // Group by type
  var byType = {};
  entries.forEach(function(e) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e);
  });

  Object.keys(byType).forEach(function(type) {
    lines.push('');
    lines.push('[' + type + '] (' + byType[type].length + ' changes)');
    byType[type].forEach(function(e) {
      var time = new Date(e.timestamp).toTimeString().split(' ')[0];
      var desc = e.from && e.to ? e.from + ' → ' + e.to : (e.to || e.from || '');
      lines.push('  ' + time + '  ' + desc + (e.detail ? ' (' + e.detail + ')' : ''));
    });
  });

  lines.push('');
  lines.push('SUMMARY:');
  lines.push('────────');
  Object.keys(byType).forEach(function(type) {
    lines.push('  ' + type + ': ' + byType[type].length + ' change(s)');
  });

  lines.push('');
  lines.push('DEPLOY NOTES:');
  lines.push('─────────────');
  lines.push('  [Add deployment notes here]');
  lines.push('');

  var text = lines.join('\n');
  var html = '<h2>Export Debug Log</h2>'
    + '<p style="color:var(--muted);font-size:13px;margin-bottom:12px">' + entries.length + ' entries from ' + dateLabel + '</p>'
    + '<textarea class="form-textarea" rows="16" readonly style="font-family:monospace;font-size:11px" id="plogExportText">' + esc(text) + '</textarea>'
    + '<div style="display:flex;gap:8px;margin-top:12px">'
    + '<button class="btn btn-dark" onclick="navigator.clipboard.writeText(document.getElementById(\'plogExportText\').value);showToast(\'Copied!\',\'success\')">Copy to clipboard</button>'
    + '<button class="btn btn-outline" onclick="closeModal()">Done</button></div>';
  showModal(html);
}

/* ══════════════════════════════════════════════════
   CHANGE HANDLERS — Log to persistent debug log
   ══════════════════════════════════════════════════ */
var _prevVertical = 'hotel';

function onVerticalChange(val) {
  plog('VERTICAL', _prevVertical, val);
  _prevVertical = val;
}

/* (onTempChange, onModelChange removed — model and temperature are fixed in production) */

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
    vertical: (document.getElementById('sbVertical') || {}).value || 'hotel',
    agentName: (document.getElementById('sbAgentName') || {}).value || '',
    language: (document.getElementById('sbLanguage') || {}).value || 'en',
    conversionUrl: (document.getElementById('sbConversionUrl') || {}).value || '',
    manualData: (document.getElementById('sbManualData') || {}).value || '',
    scrapedData: (document.getElementById('sbScrapedData') || {}).value || '',
    compiledContext: sandboxCompiledContext || '',
    roomMappings: document.getElementById('sbMappings').value,
    modelId: (document.getElementById('sbModelId') || {}).value || '',
    demoQuestions: getDemoQuestions()
  })}).then(function() {
    closeModal();
    showToast('Configuration saved', 'success');
  }).catch(function() { showToast('Failed to save', 'error'); });
}

/* ── Export System Prompt (now uses preview modal) ── */
function exportSystemPrompt() {
  previewSystemPrompt();
}

/* ══════════════════════════════════════════════════
   SANDBOX UI — Toggle, Demo, Transcript, Input
   ══════════════════════════════════════════════════ */
function toggleAdminPanel() {
  var panel = document.getElementById('sbConfigPanel');
  if (!panel) return;
  sbConfigCollapsed = !sbConfigCollapsed;
  panel.classList.toggle('collapsed', sbConfigCollapsed);
}

function toggleTranscript() {
  sbTranscriptOpen = !sbTranscriptOpen;
  var el = document.getElementById('sbTranscript');
  if (el) el.classList.toggle('open', sbTranscriptOpen);
  // Also toggle input bar
  sbInputBarOpen = sbTranscriptOpen;
  var bar = document.getElementById('sbInputBar');
  if (bar) bar.classList.toggle('open', sbInputBarOpen);
}

function toggleDemoPanel() {
  sbDemoOpen = !sbDemoOpen;
  var el = document.getElementById('sbDemoPanel');
  if (el) el.classList.toggle('open', sbDemoOpen);
}

function sendDemoQuestion(btn) {
  var text = btn.textContent;
  if (!text || !sandboxWs || sandboxWs.readyState !== 1) return;
  sandboxWs.send(JSON.stringify({ type: 'text_input', text: text }));
  sbDemoOpen = false;
  var el = document.getElementById('sbDemoPanel');
  if (el) el.classList.remove('open');
  addTranscriptMsg('user', text);
}

/* ── Transcript (overlay style, matches production) ── */
function addTranscriptMsg(role, text) {
  sbTranscriptMessages.push({ role: role, text: text });
  if (sbTranscriptMessages.length > 20) sbTranscriptMessages.shift();
  renderTranscript();
}

function renderTranscript() {
  var panel = document.getElementById('sbTranscript');
  if (!panel) return;
  panel.innerHTML = '';
  sbTranscriptMessages.forEach(function(m) {
    var div = document.createElement('div');
    div.className = 'sb-transcript-msg ' + m.role;
    div.textContent = m.text.length > 150 ? m.text.slice(0, 150) + '...' : m.text;
    panel.appendChild(div);
  });
  panel.scrollTop = panel.scrollHeight;
}

/* Legacy addTranscript (kept for debug/system messages) */
function addTranscript(role, text) {
  addTranscriptMsg(role, text);
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
  addTranscriptMsg('user', text);
  input.value = '';
}

/* ══════════════════════════════════════════════════
   AUDIO — AudioContext, Gapless Playback, VAD
   (matches production embed.js)
   ══════════════════════════════════════════════════ */
function sbEnsureAudioContext() {
  if (!sbAudioContext || sbAudioContext.state === 'closed') {
    sbAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    sbAudioContext.onstatechange = function() {
      if (!sbAudioContext) return;
      if (sbAudioContext.state === 'suspended') {
        sbAudioContext.resume().catch(function() {});
      }
    };
  }
  return sbAudioContext;
}

function sbGetPlaybackGain() {
  var ctx = sbEnsureAudioContext();
  if (!sbPlaybackGain || sbPlaybackGain.context !== ctx) {
    sbPlaybackGain = ctx.createGain();
    sbPlaybackGain.connect(ctx.destination);
  }
  return sbPlaybackGain;
}

/* ── Gapless PCM16 Playback (matches production exactly) ── */
function sbPlayPCM16Chunk(pcm16Buffer) {
  try {
    var ctx = sbEnsureAudioContext();
    if (ctx.state !== 'running') {
      try { ctx.resume(); } catch(e) {}
      if (ctx.state !== 'running') {
        console.warn('[AUDIO] ✗ AudioContext is ' + ctx.state + ' — chunk dropped. Click anywhere on the page to unlock audio.');
      }
    }

    var int16 = new Int16Array(pcm16Buffer);
    var float32 = new Float32Array(int16.length);
    for (var i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    var audioBuffer = ctx.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    var source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(sbGetPlaybackGain());

    var now = ctx.currentTime;
    var startTime = (sbNextPlayTime > now) ? sbNextPlayTime : now;
    source.start(startTime);
    sbNextPlayTime = startTime + audioBuffer.duration;

    sbCurrentSources.push(source);
    source.onended = function() {
      var idx = sbCurrentSources.indexOf(source);
      if (idx !== -1) sbCurrentSources.splice(idx, 1);
    };
  } catch(e) {
    console.warn('[SANDBOX] Playback error:', e.message);
  }
}

function sbClearPlaybackBuffer() {
  if (sbPlaybackGain) {
    try { sbPlaybackGain.disconnect(); } catch(e) {}
    sbPlaybackGain = null;
  }
  sbCurrentSources.forEach(function(s) { try { s.stop(); } catch(e) {} });
  sbCurrentSources = [];
  sbNextPlayTime = sbAudioContext ? sbAudioContext.currentTime : 0;
}

function sbStopAllAudio() {
  sbClearPlaybackBuffer();
  sbAgentStatus = 'idle';
  sbRefreshUI();
}

/* ── Agent Icon UI refresh ── */
function sbRefreshUI() {
  var icon = document.getElementById('sbAgentIcon');
  if (!icon) return;
  icon.classList.remove('speaking', 'thinking', 'user_speaking');
  if (sbAgentStatus === 'speaking') icon.classList.add('speaking');
  else if (sbAgentStatus === 'thinking') icon.classList.add('thinking');
  else if (sbAgentStatus === 'user_speaking') icon.classList.add('user_speaking');
}

/* ── VAD Worklet Setup (matches production) ── */
async function sbInitMicrophone() {
  try {
    if (sbMicStream) { sbMicStream.getTracks().forEach(function(t) { t.stop(); }); sbMicStream = null; }
    if (sbWorkletNode) { try { sbWorkletNode.disconnect(); } catch(e) {} sbWorkletNode = null; }

    sbMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });

    var ctx = sbEnsureAudioContext();
    if (ctx.state !== 'running') await ctx.resume();

    await sbSetupVADWorklet(sbMicStream);
    console.log('[SANDBOX] Microphone + VAD initialized');
  } catch(e) {
    console.warn('[SANDBOX] Microphone not available:', e.name);
    showToast('Microphone access denied. Click the agent icon and type instead.', 'error');
  }
}

async function sbSetupVADWorklet(stream) {
  var ctx = sbEnsureAudioContext();

  if (!sbWorkletRegistered) {
    var blob = new Blob([VAD_WORKLET_CODE], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
      sbWorkletRegistered = true;
    } catch(e) {
      if (e.message && e.message.includes('already')) {
        sbWorkletRegistered = true;
      } else {
        console.warn('[SANDBOX] AudioWorklet not supported:', e.message);
        URL.revokeObjectURL(url);
        return;
      }
    }
    URL.revokeObjectURL(url);
  }

  var source = ctx.createMediaStreamSource(stream);
  sbWorkletNode = new AudioWorkletNode(ctx, 'vad-processor');

  sbWorkletNode.port.onmessage = function(e) {
    // Suppress VAD while agent is speaking or during cooldown (echo suppression)
    if (sbVadSuppressed) return;

    if (e.data.type === 'speech_start') {
      // Interrupt agent if speaking
      if (sbAgentStatus === 'speaking') {
        sbStopAllAudio();
        if (sandboxWs && sandboxWs.readyState === WebSocket.OPEN) {
          sandboxWs.send(JSON.stringify({ type: 'interrupt' }));
        }
      }
      sbAgentStatus = 'user_speaking';
      sbRefreshUI();
    }

    if (e.data.type === 'speech_end') {
      sbAgentStatus = 'idle';
      sbRefreshUI();

      // Convert Float32 → PCM16 and send
      var float32 = e.data.audio;
      var pcm16 = new Int16Array(float32.length);
      for (var i = 0; i < float32.length; i++) {
        var s = Math.max(-1, Math.min(1, float32[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      if (sandboxWs && sandboxWs.readyState === WebSocket.OPEN) {
        sandboxWs.send(pcm16.buffer);
      }
    }
  };

  source.connect(sbWorkletNode);
  // Silent destination to keep worklet alive
  var gain = ctx.createGain();
  gain.gain.value = 0;
  sbWorkletNode.connect(gain);
  gain.connect(ctx.destination);
}

/* Unlock AudioContext on user gesture */
document.addEventListener('click', function() {
  if (sbAudioContext && sbAudioContext.state !== 'running') {
    sbAudioContext.resume().catch(function() {});
  }
});

/* ══════════════════════════════════════════════════
   VOICE SESSION — WebSocket + Streaming Pipeline
   ══════════════════════════════════════════════════ */
function startSandboxSession() {
  if (sandboxWs) { sandboxWs.close(); sandboxWs = null; }
  wsReconnectAttempts = 0;
  debugLog = [];
  sbTranscriptMessages = [];
  sbAgentStatus = 'idle';
  sbNextPlayTime = 0;
  sbVadSuppressed = false;
  updateDebugPanel();

  // Show loading overlay
  var loadEl = document.getElementById('sbLoadingOverlay');
  if (loadEl) loadEl.classList.remove('hidden');

  var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = protocol + '//' + window.location.host + '/ws/test?token=' + encodeURIComponent(TOKEN);
  connectWebSocket(wsUrl);
}

function connectWebSocket(url) {
  sandboxWs = new WebSocket(url);
  sandboxWs.binaryType = 'arraybuffer';

  sandboxWs.onopen = function() {
    wsReconnectAttempts = 0;
    console.log('[SANDBOX] WebSocket connected');

    // Send config (production-matching fields — no model/temp/systemPrompt)
    var manual = (document.getElementById('sbManualData') || {}).value || '';
    var scraped = (document.getElementById('sbScrapedData') || {}).value || '';
    var propertyData = manual;
    if (manual && scraped) propertyData = manual + '\n\n--- Scraped Data ---\n\n' + scraped;
    else if (scraped) propertyData = scraped;

    var config = {
      vertical: (document.getElementById('sbVertical') || {}).value || 'hotel',
      agentName: (document.getElementById('sbAgentName') || {}).value || '',
      language: (document.getElementById('sbLanguage') || {}).value || 'en',
      conversionUrl: (document.getElementById('sbConversionUrl') || {}).value || '',
      compiledContext: sandboxCompiledContext || '',
      propertyData: propertyData,
      roomMappings: (document.getElementById('sbMappings') || {}).value || '{}',
      demoQuestions: getDemoQuestions()
    };
    sandboxWs.send(JSON.stringify({ type: 'config', config: config }));

    // Init microphone + VAD
    sbInitMicrophone().then(function() {
      // Hide loading overlay after mic is ready
      var loadEl = document.getElementById('sbLoadingOverlay');
      if (loadEl) loadEl.classList.add('hidden');
      // Show text input bar
      var bar = document.getElementById('sbInputBar');
      if (bar) bar.classList.add('open');
      sbInputBarOpen = true;
    });

    // Suppress VAD until greeting finishes
    sbVadSuppressed = true;
    if (sbMicStream) { sbMicStream.getAudioTracks().forEach(function(t) { t.enabled = false; }); }
    if (sbWorkletNode) { sbWorkletNode.port.postMessage({ type: 'reset' }); }
  };

  sandboxWs.onmessage = function(event) {
    // Binary = PCM16 audio chunk → play immediately (gapless)
    if (event.data instanceof ArrayBuffer) {
      window.__sbAudioChunkCount = (window.__sbAudioChunkCount || 0) + 1;
      if (window.__sbAudioChunkCount === 1) {
        console.log('[AUDIO] ✓ first binary chunk received, bytes=' + event.data.byteLength + ' ctx.state=' + (sbAudioContext && sbAudioContext.state));
      }
      // Suppress VAD on first audio byte (echo suppression)
      if (!sbVadSuppressed) {
        sbVadSuppressed = true;
        if (sbVadSuppressTimer) { clearTimeout(sbVadSuppressTimer); sbVadSuppressTimer = null; }
        if (sbMicStream) { sbMicStream.getAudioTracks().forEach(function(t) { t.enabled = false; }); }
        if (sbWorkletNode) { sbWorkletNode.port.postMessage({ type: 'reset' }); }
      }
      sbAgentStatus = 'speaking';
      sbRefreshUI();
      sbPlayPCM16Chunk(event.data);
      return;
    }

    // Non-ArrayBuffer binary (e.g. Blob) — handle gracefully
    if (event.data instanceof Blob) {
      console.warn('[AUDIO] ✗ received Blob instead of ArrayBuffer — binaryType misconfigured');
      event.data.arrayBuffer().then(function(buf) {
        sbAgentStatus = 'speaking';
        sbRefreshUI();
        sbPlayPCM16Chunk(buf);
      });
      return;
    }

    var msg;
    try { msg = JSON.parse(event.data); } catch(e) { return; }

    if (msg.type === 'status') {
      var val = msg.value || msg.status; // support both old and new format
      if (val === 'thinking') {
        sbClearPlaybackBuffer();
        sbAgentStatus = 'thinking';
        sbVadSuppressed = true;
        if (sbVadSuppressTimer) { clearTimeout(sbVadSuppressTimer); sbVadSuppressTimer = null; }
        if (sbMicStream) { sbMicStream.getAudioTracks().forEach(function(t) { t.enabled = false; }); }
        if (sbWorkletNode) { sbWorkletNode.port.postMessage({ type: 'reset' }); }
        sbRefreshUI();
      }
      if (val === 'speaking') {
        sbClearPlaybackBuffer();
        sbAgentStatus = 'speaking';
        sbVadSuppressed = true;
        if (sbVadSuppressTimer) { clearTimeout(sbVadSuppressTimer); sbVadSuppressTimer = null; }
        if (sbMicStream) { sbMicStream.getAudioTracks().forEach(function(t) { t.enabled = false; }); }
        if (sbWorkletNode) { sbWorkletNode.port.postMessage({ type: 'reset' }); }
        sbRefreshUI();
      }
      if (val === 'idle') {
        sbAgentStatus = 'idle';
        sbNextPlayTime = sbAudioContext ? sbAudioContext.currentTime : 0;
        // 1200ms cooldown after speaking (room reverb + echo tail)
        if (sbVadSuppressTimer) clearTimeout(sbVadSuppressTimer);
        sbVadSuppressTimer = setTimeout(function() {
          sbVadSuppressed = false;
          sbVadSuppressTimer = null;
          if (sbWorkletNode) { sbWorkletNode.port.postMessage({ type: 'reset' }); }
          if (sbMicStream) { sbMicStream.getAudioTracks().forEach(function(t) { t.enabled = true; }); }
        }, 1200);
        sbRefreshUI();
      }
      if (val === 'connected') {
        sbAgentStatus = 'idle';
        sbNextPlayTime = sbAudioContext ? sbAudioContext.currentTime : 0;
        sbVadSuppressed = true;
        if (sbMicStream) { sbMicStream.getAudioTracks().forEach(function(t) { t.enabled = false; }); }
        if (sbWorkletNode) { sbWorkletNode.port.postMessage({ type: 'reset' }); }
        sbRefreshUI();
      }
    }

    if (msg.type === 'transcript') {
      addTranscriptMsg(msg.role, msg.text);
    }

    if (msg.type === 'latency') {
      var lat = document.getElementById('sbLatency');
      if (lat) lat.innerHTML = '<span>STT: ' + (msg.stt || '\u2014') + 'ms</span><span>LLM: ' + (msg.llm || '\u2014') + 'ms</span><span>TTS: ' + (msg.tts || '\u2014') + 'ms</span>';
    }

    if (msg.type === 'debug') {
      debugLog.unshift(msg);
      if (debugLog.length > 10) debugLog.pop();
      updateDebugPanel();
    }

    if (msg.type === 'navigate') {
      handleNavigateEvent(msg);
    }

    if (msg.type === 'set_view_mode') {
      handleViewModeEvent(msg);
    }

    if (msg.type === 'conversion') {
      addTranscriptMsg('system', 'Booking triggered: ' + (msg.reason || ''));
    }

    if (msg.type === 'profile_update') {
      addTranscriptMsg('system', 'Profile: ' + msg.field + ' = ' + msg.value);
    }

    if (msg.type === 'state_update') {
      addTranscriptMsg('system', 'State: ' + msg.new_state + ' (' + (msg.reason || '') + ')');
    }

    if (msg.type === 'move_to_floor') {
      handleMoveToFloor(msg);
    }

    if (msg.type === 'highlight_reel') {
      handleHighlightReel(msg);
    }

    if (msg.type === 'zoom_camera') {
      handleZoomCamera(msg);
    }

    if (msg.type === 'rotate_camera') {
      handleRotateCamera(msg);
    }

    if (msg.type === 'error') {
      showToast(msg.message, 'error');
      addTranscriptMsg('error', msg.message);
    }
  };

  sandboxWs.onclose = function() {
    // Auto-reconnect (max 3 attempts)
    if (wsReconnectAttempts < 3) {
      wsReconnectAttempts++;
      setTimeout(function() {
        if (!sandboxWs || sandboxWs.readyState === WebSocket.CLOSED) {
          connectWebSocket(url);
        }
      }, 2000);
    } else {
      addTranscriptMsg('error', 'Connection lost. Click Save & Start Session to reconnect.');
    }
  };

  sandboxWs.onerror = function() {
    showToast('WebSocket connection failed \u2014 check API keys in Railway', 'error');
  };
}

/* ── Matterport Navigation (with fade transition) ── */
function handleNavigateEvent(msg) {
  if (!msg.sweepId) {
    addTranscriptMsg('system', 'Room not found: ' + (msg.roomName || ''));
    return;
  }
  addTranscriptMsg('system', 'Navigating to: ' + (msg.roomName || msg.sweepId));

  // ─── SDK mode: use sdk.Sweep.moveTo() ───
  if (sdkSandboxActive && sdkInstance && sdkConnected) {
    sdkLogEvent('navigate', 'Sweep.moveTo(' + msg.sweepId + ') from voice agent');
    try {
      sdkInstance.Sweep.moveTo(msg.sweepId, {
        transition: sdkInstance.Sweep.Transition.FLY,
        transitionTime: 2000
      }).then(function(sid) {
        sdkLogEvent('navigate', 'Sweep.moveTo completed → ' + sid);
      }).catch(function(err) {
        sdkLogEvent('error', 'Sweep.moveTo failed: ' + (err && err.message || err));
        addTranscriptMsg('error', 'SDK navigation failed: ' + (err && err.message || err));
      });
    } catch (e) {
      sdkLogEvent('error', 'Sweep.moveTo threw: ' + e.message);
    }
    return;
  }

  // ─── Non-SDK (legacy) mode: reload iframe src with &ss=... ───
  var iframe = document.querySelector('#sbTourContainer iframe');
  if (!iframe) return;

  var modelId = (document.getElementById('sbModelId').value || '').trim();
  var fadeEl = document.getElementById('sbFade');
  var newUrl = 'https://my.matterport.com/show/?m=' + encodeURIComponent(modelId) + '&ss=' + encodeURIComponent(msg.sweepId) + '&sr=-.05,.5&play=1&qs=1';

  if (fadeEl) {
    fadeEl.classList.add('active');
    setTimeout(function() {
      iframe.src = newUrl;
      iframe.addEventListener('load', function onLoad() {
        iframe.removeEventListener('load', onLoad);
        setTimeout(function() { fadeEl.classList.remove('active'); }, 400);
      }, { once: true });
      setTimeout(function() { fadeEl.classList.remove('active'); }, 4000);
    }, 350);
  } else {
    iframe.src = newUrl;
  }
}

/* ── View Mode (floorplan/dollhouse/inside) ──
 * Matterport URL params (fp=1, dh=1) only toggle BUTTON visibility — they do NOT
 * switch the actual view mode. Real programmatic control requires the Matterport SDK
 * (commercial license). So instead:
 *   - floorplan → show an image overlay (admin-uploaded floor plan PNG/JPG)
 *   - inside     → hide the overlay
 *   - dollhouse  → no-op (would require SDK)
 */
function handleViewModeEvent(msg) {
  var mode = msg.mode;
  console.log('[ViewMode] → ' + mode);

  // ─── SDK mode: use real sdk.Mode.moveTo() for all three modes ───
  if (sdkSandboxActive && sdkInstance && sdkConnected) {
    var target = null;
    try {
      if (mode === 'inside')    target = sdkInstance.Mode.Mode.INSIDE;
      if (mode === 'floorplan') target = sdkInstance.Mode.Mode.FLOORPLAN;
      if (mode === 'dollhouse') target = sdkInstance.Mode.Mode.DOLLHOUSE;
    } catch (e) {}
    if (!target) {
      sdkLogEvent('error', 'Unknown view mode: ' + mode);
      return;
    }
    sdkLogEvent('viewmode', 'Mode.moveTo(' + mode + ') from voice agent');
    addTranscriptMsg('system', 'Switching view: ' + mode);
    try {
      sdkInstance.Mode.moveTo(target).then(function(result) {
        sdkLogEvent('viewmode', 'Mode.moveTo completed → ' + mode);
      }).catch(function(err) {
        sdkLogEvent('error', 'Mode.moveTo failed: ' + (err && err.message || err));
      });
    } catch (e) {
      sdkLogEvent('error', 'Mode.moveTo threw: ' + e.message);
    }
    return;
  }

  // ─── Non-SDK (legacy) mode: floorplan = image overlay, inside = hide, dollhouse = no-op ───
  if (mode === 'floorplan') {
    if (!sandboxFloorplanImage) {
      console.warn('[ViewMode] ✗ no floor plan image uploaded');
      addTranscriptMsg('system', '⚠ No floor plan image uploaded — upload one in the config panel');
      return;
    }
    showFloorplanOverlay();
    addTranscriptMsg('system', 'Showing floor plan…');
    return;
  }

  if (mode === 'inside') {
    hideFloorplanOverlay();
    return;
  }

  if (mode === 'dollhouse') {
    // Not supported without Matterport SDK — log and ignore
    console.warn('[ViewMode] dollhouse requires Matterport SDK — ignoring');
    return;
  }
}

function showFloorplanOverlay() {
  var overlay = document.getElementById('sbFloorplanOverlay');
  var img = document.getElementById('sbFloorplanImg');
  if (!overlay || !img || !sandboxFloorplanImage) return;
  img.src = sandboxFloorplanImage;
  overlay.classList.add('active');
  console.log('[ViewMode] ✓ floor plan overlay shown');
}

function hideFloorplanOverlay() {
  var overlay = document.getElementById('sbFloorplanOverlay');
  if (!overlay) return;
  overlay.classList.remove('active');
  console.log('[ViewMode] ✓ floor plan overlay hidden');
}

/* ── Floor switching (SDK tool) ── */
function handleMoveToFloor(msg) {
  if (!sdkSandboxActive || !sdkInstance || !sdkConnected) {
    addTranscriptMsg('system', '⚠ Floor switching requires SDK connection');
    return;
  }
  var floor = msg.floor;
  addTranscriptMsg('system', 'Switching to floor ' + floor);
  sdkLogEvent('floor', 'Floor.moveTo(' + floor + ') from voice agent');
  try {
    sdkInstance.Floor.moveTo(floor).then(function(idx) {
      sdkLogEvent('floor', 'Floor.moveTo completed → floor ' + idx);
    }).catch(function(err) {
      sdkLogEvent('error', 'Floor.moveTo failed: ' + (err && err.message || err));
      addTranscriptMsg('error', 'Floor switch failed: ' + (err && err.message || err));
    });
  } catch (e) {
    sdkLogEvent('error', 'Floor.moveTo threw: ' + e.message);
  }
}

/* ── Highlight reel / guided tour (SDK tool) ── */
function handleHighlightReel(msg) {
  if (!sdkSandboxActive || !sdkInstance || !sdkConnected) {
    addTranscriptMsg('system', '⚠ Highlight reel requires SDK connection');
    return;
  }
  var action = msg.action;
  sdkLogEvent('tour', 'Tour.' + action + '() from voice agent');
  var labels = { start: 'Starting guided tour…', stop: 'Stopping tour', next: 'Next highlight', previous: 'Previous highlight' };
  addTranscriptMsg('system', labels[action] || ('Tour: ' + action));
  try {
    if (action === 'start') {
      sdkInstance.Tour.start().then(function() {
        sdkLogEvent('tour', 'Tour.start completed');
      }).catch(function(err) {
        sdkLogEvent('error', 'Tour.start failed: ' + (err && err.message || err));
      });
    } else if (action === 'stop') {
      sdkInstance.Tour.stop().then(function() {
        sdkLogEvent('tour', 'Tour.stop completed');
      }).catch(function(err) {
        sdkLogEvent('error', 'Tour.stop failed: ' + (err && err.message || err));
      });
    } else if (action === 'next') {
      sdkInstance.Tour.next().then(function() {
        sdkLogEvent('tour', 'Tour.next completed');
      }).catch(function(err) {
        sdkLogEvent('error', 'Tour.next failed: ' + (err && err.message || err));
      });
    } else if (action === 'previous') {
      sdkInstance.Tour.prev().then(function() {
        sdkLogEvent('tour', 'Tour.prev completed');
      }).catch(function(err) {
        sdkLogEvent('error', 'Tour.prev failed: ' + (err && err.message || err));
      });
    }
  } catch (e) {
    sdkLogEvent('error', 'Tour.' + action + ' threw: ' + e.message);
  }
}

/* ── Camera zoom (SDK tool) ── */
function handleZoomCamera(msg) {
  if (!sdkSandboxActive || !sdkInstance || !sdkConnected) {
    addTranscriptMsg('system', '⚠ Zoom requires SDK connection');
    return;
  }
  var action = msg.action;
  sdkLogEvent('camera', 'Camera.zoom ' + action + ' from voice agent');
  addTranscriptMsg('system', 'Zoom: ' + action);
  try {
    if (action === 'in') {
      sdkInstance.Camera.zoomBy(0.5).then(function(level) {
        sdkLogEvent('camera', 'zoomBy(0.5) → level=' + level);
      }).catch(function(err) {
        sdkLogEvent('error', 'Camera.zoomBy failed: ' + (err && err.message || err));
      });
    } else if (action === 'out') {
      sdkInstance.Camera.zoomBy(-0.5).then(function(level) {
        sdkLogEvent('camera', 'zoomBy(-0.5) → level=' + level);
      }).catch(function(err) {
        sdkLogEvent('error', 'Camera.zoomBy failed: ' + (err && err.message || err));
      });
    } else if (action === 'reset') {
      sdkInstance.Camera.zoomReset().then(function() {
        sdkLogEvent('camera', 'zoomReset completed');
      }).catch(function(err) {
        sdkLogEvent('error', 'Camera.zoomReset failed: ' + (err && err.message || err));
      });
    }
  } catch (e) {
    sdkLogEvent('error', 'Camera.zoom threw: ' + e.message);
  }
}

/* ── Camera rotation (SDK tool) ── */
function handleRotateCamera(msg) {
  if (!sdkSandboxActive || !sdkInstance || !sdkConnected) {
    addTranscriptMsg('system', '⚠ Camera rotation requires SDK connection');
    return;
  }
  var direction = msg.direction;
  var h = 0, v = 0;
  if (direction === 'left')  h = -45;
  if (direction === 'right') h = 45;
  if (direction === 'up')    v = 30;
  if (direction === 'down')  v = -30;

  sdkLogEvent('camera', 'Camera.rotate(' + h + ', ' + v + ') from voice agent — ' + direction);
  addTranscriptMsg('system', 'Looking ' + direction + '…');
  try {
    sdkInstance.Camera.rotate(h, v).then(function() {
      sdkLogEvent('camera', 'Camera.rotate completed');
    }).catch(function(err) {
      sdkLogEvent('error', 'Camera.rotate failed: ' + (err && err.message || err));
    });
  } catch (e) {
    sdkLogEvent('error', 'Camera.rotate threw: ' + e.message);
  }
}

/* ── Floor plan image upload ── */
function uploadFloorplanImage(input) {
  var file = input.files && input.files[0];
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    showToast('Only PNG, JPG, or WEBP images are allowed', 'error');
    input.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('Image must be under 5 MB', 'error');
    input.value = '';
    return;
  }
  var reader = new FileReader();
  reader.onload = function(e) {
    sandboxFloorplanImage = e.target.result || '';
    try { localStorage.setItem(FLOORPLAN_STORAGE_KEY, sandboxFloorplanImage); } catch (err) {
      console.warn('[Floorplan] localStorage write failed (too large?):', err);
      showToast('Image too large to persist — will be cleared on reload', 'error');
    }
    updateFloorplanPreview();
    showToast('Floor plan uploaded', 'success');
    plog('FLOORPLAN_UPLOAD', '', file.name, Math.round(file.size / 1024) + ' KB');
    input.value = '';
  };
  reader.onerror = function() {
    showToast('Could not read image', 'error');
    input.value = '';
  };
  reader.readAsDataURL(file);
}

function clearFloorplanImage() {
  sandboxFloorplanImage = '';
  try { localStorage.removeItem(FLOORPLAN_STORAGE_KEY); } catch (e) {}
  updateFloorplanPreview();
  hideFloorplanOverlay();
  showToast('Floor plan cleared', 'success');
}

function updateFloorplanPreview() {
  var preview = document.getElementById('sbFloorplanPreview');
  var clearBtn = document.getElementById('sbFloorplanClearBtn');
  var uploadBtn = document.getElementById('sbFloorplanBtn');
  if (!preview) return;
  if (sandboxFloorplanImage) {
    preview.innerHTML = '<img src="' + sandboxFloorplanImage + '" alt="Floor plan preview">';
    preview.style.display = 'block';
    if (clearBtn) clearBtn.style.display = 'inline-block';
    if (uploadBtn) uploadBtn.textContent = 'Replace floor plan';
  } else {
    preview.innerHTML = '';
    preview.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    if (uploadBtn) uploadBtn.textContent = 'Upload floor plan';
  }
}

/* ═══════════════════════════════════════════════════
   MATTERPORT SDK — wrapper + test functions
   (only active when sdkSandboxActive === true)
   ═══════════════════════════════════════════════════ */

var SDK_APP_KEY_STORAGE = 'sdk_sandbox_app_key';

/* ── App key persistence (localStorage) ── */
function sdkGetAppKey() {
  var el = document.getElementById('sdkAppKey');
  if (el && el.value.trim()) return el.value.trim();
  try { return localStorage.getItem(SDK_APP_KEY_STORAGE) || ''; } catch (e) { return ''; }
}

function sdkSaveAppKey() {
  var el = document.getElementById('sdkAppKey');
  var key = el ? el.value.trim() : '';
  if (!key) { showToast('Enter an SDK application key first', 'error'); return; }
  try { localStorage.setItem(SDK_APP_KEY_STORAGE, key); } catch (e) {}
  sdkUpdateKeyStatus();
  showToast('SDK key saved locally', 'success');
  sdkLogEvent('info', 'SDK application key saved to localStorage');
}

function sdkClearAppKey() {
  var el = document.getElementById('sdkAppKey');
  if (el) el.value = '';
  try { localStorage.removeItem(SDK_APP_KEY_STORAGE); } catch (e) {}
  sdkUpdateKeyStatus();
  showToast('SDK key cleared', 'success');
}

function sdkInitKeyField() {
  var el = document.getElementById('sdkAppKey');
  if (!el) return;
  try {
    var saved = localStorage.getItem(SDK_APP_KEY_STORAGE) || '';
    if (saved) el.value = saved;
  } catch (e) {}
  sdkUpdateKeyStatus();
}

function sdkUpdateKeyStatus() {
  var status = document.getElementById('sdkKeyStatus');
  if (!status) return;
  var key = sdkGetAppKey();
  if (key) {
    status.textContent = '✓ Key loaded (' + key.slice(0, 4) + '…' + key.slice(-4) + ', ' + key.length + ' chars)';
    status.style.color = 'var(--green, #2a7f3a)';
  } else {
    status.textContent = 'No key saved.';
    status.style.color = 'var(--muted)';
  }
}

/* ── SDK connection lifecycle ── */
function sdkConnectSdk() {
  if (!sdkSandboxActive) { showToast('Not in SDK Sandbox', 'error'); return; }
  if (sdkConnecting) { sdkLogEvent('warn', 'Already connecting — ignoring'); return; }
  if (sdkConnected) { sdkLogEvent('warn', 'Already connected'); return; }

  var appKey = sdkGetAppKey();
  if (!appKey) {
    showToast('Paste your SDK Application Key first', 'error');
    sdkLogEvent('error', 'sdkConnectSdk: no app key');
    return;
  }

  if (typeof window.MP_SDK === 'undefined' || !window.MP_SDK.connect) {
    showToast('Matterport SDK script not loaded', 'error');
    sdkLogEvent('error', 'window.MP_SDK is undefined — check dashboard.html script tag');
    return;
  }

  var iframe = document.getElementById('sbTourIframe') || document.querySelector('#sbTourContainer iframe');
  if (!iframe) {
    showToast('Load a Matterport tour first', 'error');
    sdkLogEvent('error', 'sdkConnectSdk: no iframe in #sbTourContainer');
    return;
  }

  sdkConnecting = true;
  sdkRefreshStatusUI('Connecting…');
  sdkLogEvent('info', 'MP_SDK.connect(iframe, key, ' + SDK_INTERFACE_VERSION + ')');

  try {
    var connectResult = window.MP_SDK.connect(iframe, appKey, SDK_INTERFACE_VERSION);
    // MP_SDK.connect returns a Promise<MpSdk>
    Promise.resolve(connectResult).then(function(sdk) {
      sdkInstance = sdk;
      sdkLogEvent('info', 'SDK handshake OK — waiting for App.Phase.PLAYING…');
      // Wait until the showcase reaches PLAYING before using any APIs
      return sdk.App.state.waitUntil(function(state) {
        return state && state.phase === sdk.App.Phase.PLAYING;
      }).then(function() {
        return sdk;
      });
    }).then(function(sdk) {
      sdkConnected = true;
      sdkConnecting = false;
      sdkLogEvent('info', '✓ SDK connected, phase = PLAYING');
      sdkRefreshStatusUI('Connected');
      showToast('SDK connected', 'success');
      // Wire up subscriptions + populate dropdowns
      sdkAttachSubscriptions(sdk);
      sdkPopulateSweepDropdown();
      sdkPopulateFloorDropdown();
    }).catch(function(err) {
      sdkConnecting = false;
      sdkConnected = false;
      sdkInstance = null;
      var msg = (err && err.message) || String(err || 'unknown error');
      sdkLogEvent('error', 'SDK connect failed: ' + msg);
      sdkRefreshStatusUI('Disconnected');
      showToast('SDK connect failed: ' + msg, 'error');
    });
  } catch (e) {
    sdkConnecting = false;
    sdkConnected = false;
    sdkInstance = null;
    sdkLogEvent('error', 'SDK connect threw: ' + e.message);
    sdkRefreshStatusUI('Disconnected');
    showToast('SDK connect error: ' + e.message, 'error');
  }
}

function sdkDisconnectInstance() {
  // Cancel all subscriptions
  try { if (sdkCameraSub && sdkCameraSub.cancel) sdkCameraSub.cancel(); } catch (e) {}
  try { if (sdkSweepCurrentSub && sdkSweepCurrentSub.cancel) sdkSweepCurrentSub.cancel(); } catch (e) {}
  try { if (sdkModeCurrentSub && sdkModeCurrentSub.cancel) sdkModeCurrentSub.cancel(); } catch (e) {}
  try { if (sdkSweepDataSub && sdkSweepDataSub.cancel) sdkSweepDataSub.cancel(); } catch (e) {}
  sdkCameraSub = null;
  sdkSweepCurrentSub = null;
  sdkModeCurrentSub = null;
  sdkSweepDataSub = null;

  sdkInstance = null;
  sdkConnected = false;
  sdkConnecting = false;
  sdkSweepsList = [];
  sdkCurrentSweepSid = '';
  sdkCurrentModeName = '';

  sdkRefreshStatusUI('Disconnected');

  // Reset dropdowns
  var sweepSel = document.getElementById('sdkSweepSelect');
  if (sweepSel) sweepSel.innerHTML = '<option value="">— Select sweep —</option>';
  var floorSel = document.getElementById('sdkFloorSelect');
  if (floorSel) floorSel.innerHTML = '<option value="">— Select floor —</option>';
  var modeEl = document.getElementById('sdkCurrentMode');
  if (modeEl) modeEl.textContent = '—';
  var sweepEl = document.getElementById('sdkCurrentSweep');
  if (sweepEl) sweepEl.textContent = '—';

  sdkLogEvent('info', 'SDK disconnected');
}

function sdkRefreshStatusUI(stateText) {
  var text = stateText;
  if (!text) {
    text = sdkConnected ? 'Connected' : (sdkConnecting ? 'Connecting…' : 'Disconnected');
  }
  var pill = document.getElementById('sdkStatusPill');
  var txt = document.getElementById('sdkStatusText');
  var connectBtn = document.getElementById('sdkConnectBtn');
  var disconnectBtn = document.getElementById('sdkDisconnectBtn');
  if (txt) txt.textContent = text;
  if (pill) {
    pill.classList.remove('connected', 'connecting', 'disconnected');
    if (sdkConnected) pill.classList.add('connected');
    else if (sdkConnecting) pill.classList.add('connecting');
    else pill.classList.add('disconnected');
  }
  if (connectBtn) connectBtn.style.display = sdkConnected ? 'none' : '';
  if (disconnectBtn) disconnectBtn.style.display = sdkConnected ? '' : 'none';
  // Enable/disable test buttons based on connection
  document.querySelectorAll('.sdk-btn').forEach(function(b) { b.disabled = !sdkConnected; });
}

/* ── SDK subscriptions (camera, sweep, mode, sweep collection) ── */
function sdkAttachSubscriptions(sdk) {
  try {
    sdkCameraSub = sdk.Camera.pose.subscribe(function(pose) {
      // Too spammy for the log — we just cache; exposed via the "Camera pose" button
      window.__sdkLastPose = pose;
    });
  } catch (e) { sdkLogEvent('error', 'Camera.pose.subscribe failed: ' + e.message); }

  try {
    sdkSweepCurrentSub = sdk.Sweep.current.subscribe(function(sweep) {
      sdkCurrentSweepSid = (sweep && sweep.sid) || '';
      var el = document.getElementById('sdkCurrentSweep');
      if (el) el.textContent = sdkCurrentSweepSid || '—';
      if (sdkCurrentSweepSid) sdkLogEvent('sweep', 'current → ' + sdkCurrentSweepSid);
    });
  } catch (e) { sdkLogEvent('error', 'Sweep.current.subscribe failed: ' + e.message); }

  try {
    sdkModeCurrentSub = sdk.Mode.current.subscribe(function(mode) {
      sdkCurrentModeName = mode || '';
      var el = document.getElementById('sdkCurrentMode');
      if (el) el.textContent = sdkCurrentModeName || '—';
      if (sdkCurrentModeName) sdkLogEvent('mode', 'current → ' + sdkCurrentModeName);
    });
  } catch (e) { sdkLogEvent('error', 'Mode.current.subscribe failed: ' + e.message); }

  try {
    sdkSweepDataSub = sdk.Sweep.data.subscribe({
      onCollectionUpdated: function(collection) {
        // collection is an object keyed by sid
        var list = [];
        Object.keys(collection).forEach(function(sid) {
          var sw = collection[sid];
          list.push({
            sid: sid,
            label: (sw && sw.label) || sid.slice(0, 8),
            floor: sw && sw.floorInfo ? sw.floorInfo.sequence : null
          });
        });
        sdkSweepsList = list;
        sdkPopulateSweepDropdown();
      }
    });
  } catch (e) { sdkLogEvent('error', 'Sweep.data.subscribe failed: ' + e.message); }
}

/* ── Dropdown population ── */
function sdkPopulateSweepDropdown() {
  var sel = document.getElementById('sdkSweepSelect');
  if (!sel) return;
  if (!sdkSweepsList || sdkSweepsList.length === 0) {
    sel.innerHTML = '<option value="">— No sweeps loaded —</option>';
    return;
  }
  // Sort by floor then label
  var sorted = sdkSweepsList.slice().sort(function(a, b) {
    if (a.floor !== b.floor) return (a.floor || 0) - (b.floor || 0);
    return String(a.label).localeCompare(String(b.label));
  });
  var opts = '<option value="">— Select sweep —</option>';
  sorted.forEach(function(s) {
    var floorTxt = (s.floor !== null && s.floor !== undefined) ? ('F' + s.floor + ' · ') : '';
    opts += '<option value="' + esc(s.sid) + '">' + floorTxt + esc(s.label) + ' (' + s.sid.slice(0, 8) + ')</option>';
  });
  sel.innerHTML = opts;
  sdkLogEvent('info', 'Sweep dropdown populated: ' + sdkSweepsList.length + ' sweeps');
}

function sdkPopulateFloorDropdown() {
  var sel = document.getElementById('sdkFloorSelect');
  if (!sel || !sdkInstance || !sdkConnected) return;
  try {
    sdkInstance.Floor.getData().then(function(floors) {
      if (!floors || !floors.length) {
        sel.innerHTML = '<option value="">— No floors —</option>';
        return;
      }
      var opts = '<option value="">— Select floor —</option>';
      floors.forEach(function(f) {
        var label = f.name || ('Floor ' + f.sequence);
        opts += '<option value="' + f.sequence + '">' + esc(label) + '</option>';
      });
      sel.innerHTML = opts;
      sdkLogEvent('info', 'Floor dropdown populated: ' + floors.length + ' floors');
    }).catch(function(err) {
      sdkLogEvent('error', 'Floor.getData failed: ' + (err && err.message || err));
    });
  } catch (e) {
    sdkLogEvent('error', 'Floor.getData threw: ' + e.message);
  }
}

/* ── SDK test functions (wired to buttons in the SDK Controls panel) ── */
function sdkRequireConnected() {
  if (!sdkInstance || !sdkConnected) {
    showToast('Connect the SDK first', 'error');
    return false;
  }
  return true;
}

function sdkTestSetMode(mode) {
  if (!sdkRequireConnected()) return;
  var target = null;
  try {
    if (mode === 'inside')    target = sdkInstance.Mode.Mode.INSIDE;
    if (mode === 'floorplan') target = sdkInstance.Mode.Mode.FLOORPLAN;
    if (mode === 'dollhouse') target = sdkInstance.Mode.Mode.DOLLHOUSE;
  } catch (e) {}
  if (!target) { sdkLogEvent('error', 'Unknown mode: ' + mode); return; }
  sdkLogEvent('call', 'Mode.moveTo(' + mode + ')');
  sdkInstance.Mode.moveTo(target).then(function() {
    sdkLogEvent('ok', 'Mode.moveTo → ' + mode + ' completed');
  }).catch(function(err) {
    sdkLogEvent('error', 'Mode.moveTo failed: ' + (err && err.message || err));
  });
}

function sdkTestMoveToSelectedSweep() {
  if (!sdkRequireConnected()) return;
  var sel = document.getElementById('sdkSweepSelect');
  var sid = sel ? sel.value : '';
  if (!sid) { showToast('Pick a sweep first', 'error'); return; }
  sdkLogEvent('call', 'Sweep.moveTo(' + sid.slice(0, 8) + '…)');
  try {
    sdkInstance.Sweep.moveTo(sid, {
      transition: sdkInstance.Sweep.Transition.FLY,
      transitionTime: 2000
    }).then(function(newSid) {
      sdkLogEvent('ok', 'Sweep.moveTo → ' + newSid);
    }).catch(function(err) {
      sdkLogEvent('error', 'Sweep.moveTo failed: ' + (err && err.message || err));
    });
  } catch (e) {
    sdkLogEvent('error', 'Sweep.moveTo threw: ' + e.message);
  }
}

function sdkTestMoveToSelectedFloor() {
  if (!sdkRequireConnected()) return;
  var sel = document.getElementById('sdkFloorSelect');
  var val = sel ? sel.value : '';
  if (val === '') { showToast('Pick a floor first', 'error'); return; }
  var idx = parseInt(val, 10);
  sdkLogEvent('call', 'Floor.moveTo(' + idx + ')');
  try {
    sdkInstance.Floor.moveTo(idx).then(function(i) {
      sdkLogEvent('ok', 'Floor.moveTo → ' + i);
    }).catch(function(err) {
      sdkLogEvent('error', 'Floor.moveTo failed: ' + (err && err.message || err));
    });
  } catch (e) {
    sdkLogEvent('error', 'Floor.moveTo threw: ' + e.message);
  }
}

function sdkTestGetCameraPose() {
  if (!sdkRequireConnected()) return;
  sdkLogEvent('call', 'Camera.getPose()');
  try {
    sdkInstance.Camera.getPose().then(function(pose) {
      var p = pose && pose.position;
      var r = pose && pose.rotation;
      var summary = '{ pos: [' + (p ? p.x.toFixed(2) + ',' + p.y.toFixed(2) + ',' + p.z.toFixed(2) : '?')
        + '], rot: [' + (r ? r.x.toFixed(1) + ',' + r.y.toFixed(1) : '?') + '], mode: ' + (pose && pose.mode || '?') + ' }';
      sdkLogEvent('ok', 'Camera.getPose → ' + summary);
    }).catch(function(err) {
      sdkLogEvent('error', 'Camera.getPose failed: ' + (err && err.message || err));
    });
  } catch (e) {
    sdkLogEvent('error', 'Camera.getPose threw: ' + e.message);
  }
}

function sdkTestGetModelData() {
  if (!sdkRequireConnected()) return;
  sdkLogEvent('call', 'Model.getData()');
  try {
    sdkInstance.Model.getData().then(function(data) {
      var sid = data && data.sid;
      var name = data && data.name;
      var sweepCount = data && data.sweeps ? data.sweeps.length : 0;
      sdkLogEvent('ok', 'Model.getData → sid=' + (sid || '?') + ', name=' + (name || '?') + ', sweeps=' + sweepCount);
    }).catch(function(err) {
      sdkLogEvent('error', 'Model.getData failed: ' + (err && err.message || err));
    });
  } catch (e) {
    sdkLogEvent('error', 'Model.getData threw: ' + e.message);
  }
}

function sdkTestRefreshSweeps() {
  if (!sdkRequireConnected()) return;
  sdkLogEvent('call', 'Refresh sweep dropdown');
  sdkPopulateSweepDropdown();
  sdkPopulateFloorDropdown();
}

/* ── SDK Event Log ── */
function sdkLogEvent(type, msg) {
  var line = {
    t: new Date().toLocaleTimeString(),
    type: type || 'info',
    msg: String(msg || '')
  };
  sdkEventLogLines.push(line);
  if (sdkEventLogLines.length > 200) sdkEventLogLines.shift();
  sdkRenderEventLog();
  // Mirror to browser console for convenience
  var prefix = '[SDK:' + line.type + ']';
  if (type === 'error') console.error(prefix, msg);
  else if (type === 'warn') console.warn(prefix, msg);
  else console.log(prefix, msg);
}

function sdkRenderEventLog() {
  var el = document.getElementById('sdkEventLog');
  if (!el) return;
  if (!sdkEventLogLines.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px">No events yet. Connect the SDK to begin.</div>';
    return;
  }
  var html = '';
  for (var i = sdkEventLogLines.length - 1; i >= 0; i--) {
    var line = sdkEventLogLines[i];
    html += '<div class="sdk-event-line sdk-ev-' + esc(line.type) + '">'
      + '<span class="sdk-event-time">' + esc(line.t) + '</span>'
      + '<span class="sdk-event-type">' + esc(line.type) + '</span>'
      + '<span class="sdk-event-msg">' + esc(line.msg) + '</span>'
      + '</div>';
  }
  el.innerHTML = html;
}

function sdkClearEventLog() {
  sdkEventLogLines = [];
  sdkRenderEventLog();
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
      var vertEl = document.getElementById('sbVertical');
      if (vertEl && p.vertical) vertEl.value = p.vertical;
      // Store prompt content as manual data for the agent to reference
      var manualEl = document.getElementById('sbManualData');
      if (manualEl && p.content) manualEl.value = p.content;
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

  // Grab current sandbox state if available (production-matching fields)
  var sbAgentName = document.getElementById('sbAgentName');
  var sbLanguage = document.getElementById('sbLanguage');
  var sbConversionUrl = document.getElementById('sbConversionUrl');
  var sbManualData = document.getElementById('sbManualData');
  var sbScrapedData = document.getElementById('sbScrapedData');
  var sbMappings = document.getElementById('sbMappings');

  api('/api/configs', { method: 'POST', body: JSON.stringify({
    name: name, vertical: vertical, notes: notes,
    agentName: sbAgentName ? sbAgentName.value : '',
    language: sbLanguage ? sbLanguage.value : 'en',
    conversionUrl: sbConversionUrl ? sbConversionUrl.value : '',
    manualData: sbManualData ? sbManualData.value : '',
    scrapedData: sbScrapedData ? sbScrapedData.value : '',
    compiledContext: sandboxCompiledContext || '',
    roomMappings: sbMappings ? sbMappings.value : '{}',
    demoQuestions: getDemoQuestions()
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
      if (cfg.vertical) { var el = document.getElementById('sbVertical'); if (el) el.value = cfg.vertical; }
      if (cfg.agentName) { var el = document.getElementById('sbAgentName'); if (el) el.value = cfg.agentName; }
      if (cfg.language) { var el = document.getElementById('sbLanguage'); if (el) el.value = cfg.language; }
      if (cfg.conversionUrl) { var el = document.getElementById('sbConversionUrl'); if (el) el.value = cfg.conversionUrl; }
      if (cfg.manualData || cfg.propertyData) { var el = document.getElementById('sbManualData'); if (el) el.value = cfg.manualData || cfg.propertyData || ''; }
      if (cfg.scrapedData) { var el = document.getElementById('sbScrapedData'); if (el) el.value = cfg.scrapedData; }
      if (cfg.compiledContext) { sandboxCompiledContext = cfg.compiledContext; var el = document.getElementById('sbCompiledContext'); if (el) el.value = cfg.compiledContext; }
      if (cfg.roomMappings) { var el = document.getElementById('sbMappings'); if (el) el.value = cfg.roomMappings; try { renderSpaces(JSON.parse(cfg.roomMappings)); } catch(e) {} }
      if (cfg.demoQuestions && Array.isArray(cfg.demoQuestions)) { for (var i = 0; i < 5; i++) { var qEl = document.getElementById('sbDemoQ' + (i + 1)); if (qEl) qEl.value = cfg.demoQuestions[i] || ''; } populateDemoChips(); }
      if (cfg.modelId) { var el = document.getElementById('sbModelId'); if (el) el.value = cfg.modelId; }
      updateWordCount();
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
var testHistoryFilter = 'all';
var testHistoryData = [];
var currentTestSession = null;
var lastFixReport = '';

var SCORE_LABELS = {
  one_question: 'One question at a time',
  reacts_to_guest: 'Reacts to guest input',
  navigation: 'Navigation quality',
  natural_tone: 'Natural tone',
  qualifying: 'Qualifying quality',
  conversion_focus: 'Conversion focus',
  response_quality: 'Response quality',
  response_time: 'Response time',
  opening_quality: 'Opening quality',
  overall_impression: 'Overall impression'
};

var TAG_OPTIONS = ['Navigation','Tone','Dobbeltsvar','Latency','Conversion','Qualifying','Natural','Unnatural','Good session','Ready','Needs work'];

function calcOverall(scores) {
  var keys = Object.keys(scores || {});
  if (keys.length === 0) return 0;
  var sum = 0;
  keys.forEach(function(k) { sum += ((scores[k] && scores[k].score) || 0); });
  return sum / keys.length;
}

function scoreColor(score) { return score <= 5 ? '#dc2626' : score <= 7 ? '#d97706' : '#16a34a'; }

function loadTestHistoryFilter(filter) {
  testHistoryFilter = filter;
  renderTestHistory();
}

function loadTestHistory() {
  var c = document.getElementById('page-test-history');
  c.innerHTML = '<div class="page-label">AGENT BUILDER</div><h1 class="page-heading">Test History</h1><p class="page-sub">Loading...</p>';

  api('/api/test-sessions').then(function(data) {
    testHistoryData = data || [];
    renderTestHistory();
  }).catch(function(e) {
    c.innerHTML = '<div class="page-label">AGENT BUILDER</div><h1 class="page-heading">Test History</h1><p class="page-sub" style="color:#dc2626">Failed to load: ' + esc(e.message) + '</p>';
  });
}

function getFilteredSessions() {
  if (testHistoryFilter === 'all') return testHistoryData;
  if (testHistoryFilter === 'flagged') return testHistoryData.filter(function(s) { return s.status === 'flagged'; });
  if (testHistoryFilter === 'approved') return testHistoryData.filter(function(s) { return s.status === 'approved'; });
  return testHistoryData.filter(function(s) { return s.vertical === testHistoryFilter; });
}

function renderTestHistory() {
  var c = document.getElementById('page-test-history');
  var filtered = getFilteredSessions();

  // Filter pills
  var filters = ['all','hotel','education','retail','real_estate_sale','real_estate_development','flagged','approved'];
  var filterLabels = { all:'All', hotel:'Hotel', education:'Education', retail:'Retail', real_estate_sale:'Real Estate Sale', real_estate_development:'Real Estate Dev', flagged:'Flagged', approved:'Approved' };
  var pillsHtml = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">';
  filters.forEach(function(f) {
    var active = f === testHistoryFilter ? 'background:var(--black);color:var(--white);' : '';
    pillsHtml += '<button class="btn btn-outline btn-sm" style="' + active + '" onclick="loadTestHistoryFilter(\'' + f + '\')">' + filterLabels[f] + '</button>';
  });
  pillsHtml += '</div>';

  // Stats
  var scored = filtered.filter(function(s) { return s.gpt_scores && Object.keys(s.gpt_scores).length > 0; });
  var avgScore = 0;
  if (scored.length > 0) {
    var total = 0;
    scored.forEach(function(s) { total += calcOverall(s.gpt_scores); });
    avgScore = (total / scored.length).toFixed(1);
  }
  var readyCount = filtered.filter(function(s) { return s.gpt_ready_for_customers === true; }).length;
  var evalCount = filtered.filter(function(s) { return s.gpt_ready_for_customers !== null && s.gpt_ready_for_customers !== undefined; }).length;

  var statsHtml = '<div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:20px;padding:12px 16px;background:var(--cream);border-radius:10px;font-size:13px;color:var(--muted)">'
    + '<span>Sessions: <strong style="color:var(--black)">' + filtered.length + '</strong></span>'
    + '<span>Avg score: <strong style="color:var(--black)">' + (scored.length > 0 ? avgScore + '/10' : '\u2014') + '</strong></span>'
    + '<span>Ready: <strong style="color:var(--black)">' + readyCount + '/' + evalCount + '</strong></span>'
    + '</div>';

  // Table
  var tableHtml = '<table class="data-table"><thead><tr>'
    + '<th>Date</th><th>Vertical</th><th>Score</th><th>Ready</th><th>Biggest Problem</th><th>Rating</th><th>Tags</th>'
    + '</tr></thead><tbody>';

  if (filtered.length === 0) {
    tableHtml += '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No test sessions found. Run a test with ?test=true on an agent tour.</td></tr>';
  }

  filtered.forEach(function(s) {
    var scores = s.gpt_scores || {};
    var overall = calcOverall(scores);
    var color = scoreColor(overall);
    var readyBadge = s.gpt_ready_for_customers === true
      ? '<span style="background:rgba(22,163,74,0.12);color:#16a34a;padding:2px 8px;border-radius:980px;font-size:11px;font-weight:600">Ready \u2713</span>'
      : s.gpt_ready_for_customers === false
        ? '<span style="background:rgba(220,38,38,0.12);color:#dc2626;padding:2px 8px;border-radius:980px;font-size:11px;font-weight:600">Not ready \u2717</span>'
        : '<span style="color:var(--muted);font-size:11px">\u2014</span>';
    var tags = (s.manual_tags || []).map(function(t) { return '<span style="font-size:10px;padding:1px 6px;border-radius:980px;background:var(--cream);border:1px solid var(--border);color:var(--muted);margin:0 2px">' + esc(t) + '</span>'; }).join('');
    var stars = s.manual_rating ? '\u2605'.repeat(s.manual_rating) + '\u2606'.repeat(5 - s.manual_rating) : '\u2014';
    var date = s.created_at ? new Date(s.created_at).toLocaleDateString('da-DK', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '\u2014';

    tableHtml += '<tr onclick="showTestSessionDetail(\'' + s.id + '\')" style="cursor:pointer">'
      + '<td>' + date + '</td>'
      + '<td>' + esc(s.vertical || '\u2014') + '</td>'
      + '<td><span style="background:' + color + '22;color:' + color + ';padding:2px 10px;border-radius:980px;font-weight:600;font-size:12px">' + overall.toFixed(1) + '</span></td>'
      + '<td>' + readyBadge + '</td>'
      + '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.gpt_biggest_problem || '\u2014') + '</td>'
      + '<td style="color:#8B6F4E;letter-spacing:2px">' + stars + '</td>'
      + '<td>' + tags + '</td>'
      + '</tr>';
  });
  tableHtml += '</tbody></table>';

  c.innerHTML = '<div class="page-label">AGENT BUILDER</div>'
    + '<h1 class="page-heading">Test History</h1>'
    + '<p class="page-sub">Evaluate and compare test sessions with GPT scoring.</p>'
    + pillsHtml + statsHtml + tableHtml
    + '<div class="detail-overlay" id="testDetail"><button class="detail-close" onclick="closeDetail(\'testDetail\')">&times;</button><div id="testDetailContent" style="max-height:85vh;overflow-y:auto"></div></div>';
}

function showTestSessionDetail(id) {
  api('/api/test-sessions/' + id).then(function(s) {
    currentTestSession = s;
    var scores = s.gpt_scores || {};
    var overall = calcOverall(scores);
    var date = s.created_at ? new Date(s.created_at).toLocaleDateString('da-DK', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '\u2014';

    var html = '<div class="detail-title">Test Session</div>'
      + '<div class="detail-subtitle">' + date + ' &middot; ' + esc(s.vertical || '?') + '</div>';

    // Header meta
    html += '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;font-size:13px;color:var(--muted)">'
      + '<span>Model: <strong style="color:var(--black)">' + esc(s.model || '?') + '</strong></span>'
      + '<span>Temp: <strong style="color:var(--black)">' + (s.temperature || '?') + '</strong></span>'
      + '<span>Duration: <strong style="color:var(--black)">' + (s.duration_seconds || 0) + 's</strong></span>'
      + '<span>Messages: <strong style="color:var(--black)">' + (s.message_count || 0) + '</strong></span>'
      + '</div>';

    // Scores
    if (Object.keys(scores).length > 0) {
      html += '<div class="detail-section"><h4>GPT Scores \u2014 Overall: ' + overall.toFixed(1) + '/10</h4>';
      var scoreOrder = ['one_question','reacts_to_guest','navigation','natural_tone','qualifying','conversion_focus','response_quality','response_time','opening_quality','overall_impression'];
      scoreOrder.forEach(function(key) {
        var sc = scores[key];
        if (!sc) return;
        var pct = (sc.score / 10) * 100;
        var color = scoreColor(sc.score);
        html += '<div style="margin-bottom:10px">'
          + '<div style="display:flex;justify-content:space-between;font-size:12px;font-weight:500;margin-bottom:3px"><span>' + (SCORE_LABELS[key] || key) + '</span><span style="font-weight:600">' + sc.score + '/10</span></div>'
          + '<div style="height:8px;background:var(--cream);border-radius:8px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:8px"></div></div>';
        if (sc.explanation) html += '<div style="font-size:11px;color:var(--muted);font-style:italic;margin-top:2px">' + esc(sc.explanation) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Ready box
    if (s.gpt_ready_for_customers !== null && s.gpt_ready_for_customers !== undefined) {
      var readyColor = s.gpt_ready_for_customers ? '#16a34a' : '#dc2626';
      var readyBg = s.gpt_ready_for_customers ? 'rgba(22,163,74,0.08)' : 'rgba(220,38,38,0.08)';
      var readyIcon = s.gpt_ready_for_customers ? '\u2713 READY FOR CUSTOMERS' : '\u2717 NOT READY';
      html += '<div style="padding:14px 18px;border-radius:10px;background:' + readyBg + ';border:1.5px solid ' + readyColor + '33;color:' + readyColor + ';font-weight:600;font-size:14px;margin-bottom:16px">' + readyIcon;
      if (s.gpt_ready_explanation) html += '<div style="font-weight:400;font-size:12px;margin-top:4px;opacity:0.8">' + esc(s.gpt_ready_explanation) + '</div>';
      html += '</div>';
    }

    // GPT Flags
    var flags = s.gpt_flags || [];
    if (flags.length > 0) {
      html += '<div class="detail-section"><h4>GPT Flags</h4>';
      flags.forEach(function(f) {
        var icon = f.severity === 'critical' ? '\uD83D\uDD34' : f.severity === 'major' ? '\uD83D\uDFE1' : '\u26AA';
        html += '<div style="font-size:12px;padding:4px 0;border-bottom:1px solid var(--border)">' + icon + ' ' + (f.severity || 'minor').toUpperCase() + ': ' + esc(f.issue || '') + '</div>';
      });
      html += '</div>';
    }

    // Automatic warnings from latency_log
    var latencyLog = s.latency_log || [];
    var allWarnings = [];
    latencyLog.forEach(function(turn) {
      if (turn.warnings && turn.warnings.length > 0) {
        turn.warnings.forEach(function(w) { allWarnings.push(w); });
      }
    });
    if (allWarnings.length > 0) {
      html += '<div class="detail-section"><h4>Automatic Warnings</h4>';
      allWarnings.forEach(function(w) {
        html += '<div style="font-size:12px;padding:3px 0;color:#d97706">\u26A0 ' + esc(w.type || '') + ' \u2014 ' + esc(w.detail || w.message || '') + '</div>';
      });
      html += '</div>';
    }

    // GPT Summary
    if (s.gpt_summary) {
      html += '<div class="detail-section"><h4>GPT Summary</h4><div style="font-size:13px;line-height:1.6;background:var(--cream);padding:12px 16px;border-radius:10px">' + esc(s.gpt_summary) + '</div></div>';
    }

    // Biggest problem
    if (s.gpt_biggest_problem) {
      html += '<div style="background:rgba(217,119,6,0.08);border:1.5px solid rgba(217,119,6,0.25);border-radius:10px;padding:14px 18px;margin-bottom:16px">'
        + '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#d97706;font-weight:600;margin-bottom:4px">Biggest Problem</div>'
        + '<div style="font-size:14px;color:var(--black);line-height:1.5">' + esc(s.gpt_biggest_problem) + '</div></div>';
    }

    // Transcript
    var transcript = s.transcript || [];
    if (transcript.length > 0) {
      html += '<div class="detail-section"><h4>Transcript</h4><div class="transcript-panel">';
      transcript.forEach(function(msg, idx) {
        var role = msg.role || 'user';
        html += '<div class="transcript-msg"><span class="role ' + role + '">[' + role + ']</span>' + esc(msg.text || msg.content || '');
        var turnData = latencyLog[idx] || {};
        var totalMs = turnData.total_ms || (turnData.latency && turnData.latency.total_ms) || 0;
        var sttMs = turnData.stt_ms || (turnData.latency && turnData.latency.stt_ms) || 0;
        if (totalMs) html += '<div style="font-size:10px;color:var(--muted);margin-top:2px">STT: ' + sttMs + 'ms | Total: ' + totalMs + 'ms</div>';
        if (turnData.warnings && turnData.warnings.length > 0) {
          turnData.warnings.forEach(function(w) {
            html += '<div style="font-size:10px;color:#d97706;margin-top:1px">\u26A0 ' + esc(w.type) + ': ' + esc(w.detail || w.message || '') + '</div>';
          });
        }
        html += '</div>';
      });
      html += '</div></div>';
    }

    // Latency chart
    if (latencyLog.length > 0) {
      html += '<div class="detail-section"><h4>Latency per Turn</h4>';
      var maxMs = 0;
      latencyLog.forEach(function(t) {
        var ms = t.total_ms || (t.latency && t.latency.total_ms) || 0;
        if (ms > maxMs) maxMs = ms;
      });
      var chartMax = Math.max(maxMs, 4000);
      var redPct = (3000 / chartMax) * 100;
      html += '<div style="display:flex;align-items:flex-end;gap:3px;height:100px;position:relative;margin-bottom:8px">';
      latencyLog.forEach(function(t, i) {
        var ms = t.total_ms || (t.latency && t.latency.total_ms) || 0;
        var h = (ms / chartMax) * 100;
        var color = ms > 3000 ? '#dc2626' : ms > 2000 ? '#d97706' : '#16a34a';
        html += '<div style="flex:1;min-width:8px;height:' + h + '%;background:' + color + ';border-radius:3px 3px 0 0" title="Turn ' + (i+1) + ': ' + ms + 'ms"></div>';
      });
      html += '<div style="position:absolute;bottom:' + redPct + '%;left:0;right:0;border-top:2px dashed #dc2626"><span style="position:absolute;right:0;top:-14px;font-size:9px;color:#dc2626">3000ms</span></div>';
      html += '</div></div>';
    }

    // Manual note
    html += '<div class="detail-section"><h4>YOUR NOTES</h4>'
      + '<textarea class="form-textarea" id="testSessionNote" rows="3" placeholder="What did you notice that GPT couldn\'t?\nTone, pauses, unnatural moments..." onblur="saveTestSessionNote()">' + esc(s.manual_note || '') + '</textarea></div>';

    // Star rating
    html += '<div class="detail-section"><h4>YOUR RATING</h4><div style="display:flex;gap:4px">';
    var rating = s.manual_rating || 0;
    for (var i = 1; i <= 5; i++) {
      var filled = i <= rating ? 'color:#8B6F4E' : 'color:var(--border)';
      html += '<span style="font-size:24px;cursor:pointer;' + filled + '" onclick="rateTestSession(\'' + s.id + '\',' + i + ')">\u2605</span>';
    }
    html += '</div></div>';

    // Tags
    html += '<div class="detail-section"><h4>TAGS</h4><div style="display:flex;flex-wrap:wrap;gap:6px">';
    var activeTags = s.manual_tags || [];
    TAG_OPTIONS.forEach(function(tag) {
      var isActive = activeTags.indexOf(tag) >= 0;
      var style = isActive ? 'background:var(--black);color:var(--white);border-color:var(--black)' : '';
      html += '<button class="btn btn-outline btn-sm" style="font-size:11px;padding:3px 10px;' + style + '" onclick="toggleTestTag(\'' + s.id + '\',\'' + tag + '\')">' + tag + '</button>';
    });
    html += '</div></div>';

    // Actions
    html += '<div style="display:flex;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid var(--border);flex-wrap:wrap">';
    html += '<button class="btn btn-dark btn-sm" style="background:#16a34a" onclick="setTestStatus(\'' + s.id + '\',\'approved\')">Mark as ready</button>';
    html += '<button class="btn btn-dark btn-sm" style="background:#dc2626" onclick="setTestStatus(\'' + s.id + '\',\'flagged\')">Flag for fix</button>';
    if (!scores || Object.keys(scores).length === 0) {
      html += '<button class="btn btn-outline btn-sm" onclick="evaluateTestSession(\'' + s.id + '\')">Evaluate with GPT</button>';
    }
    html += '<button class="btn btn-outline btn-sm" onclick="downloadTestSessionPDF()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download PDF</button>';
    html += '<button class="btn btn-outline btn-sm" style="color:var(--muted)" onclick="deleteTestSession(\'' + s.id + '\')">Delete</button>';
    html += '</div>';

    document.getElementById('testDetailContent').innerHTML = html;
    document.getElementById('testDetail').classList.add('open');
  });
}

function evaluateTestSession(id) {
  showToast('Evaluating with GPT...', 'info');
  api('/api/test-sessions/evaluate', { method: 'POST', body: JSON.stringify({ sessionId: id }) }).then(function() {
    showToast('Evaluation complete', 'success');
    showTestSessionDetail(id);
    loadTestHistory();
  }).catch(function(e) { showToast('Evaluation failed: ' + e.message, 'error'); });
}

function saveTestSessionNote() {
  if (!currentTestSession) return;
  var note = document.getElementById('testSessionNote').value;
  api('/api/test-sessions/' + currentTestSession.id + '/note', { method: 'PUT', body: JSON.stringify({ note: note }) }).then(function() {
    showToast('Note saved', 'success');
  });
}

function rateTestSession(id, rating) {
  api('/api/test-sessions/' + id + '/note', { method: 'PUT', body: JSON.stringify({ rating: rating }) }).then(function() {
    showToast('Rating saved', 'success');
    showTestSessionDetail(id);
    loadTestHistory();
  });
}

function toggleTestTag(id, tag) {
  if (!currentTestSession) return;
  var tags = currentTestSession.manual_tags || [];
  var idx = tags.indexOf(tag);
  if (idx >= 0) tags.splice(idx, 1); else tags.push(tag);
  currentTestSession.manual_tags = tags;
  api('/api/test-sessions/' + id + '/note', { method: 'PUT', body: JSON.stringify({ tags: tags }) }).then(function() {
    showTestSessionDetail(id);
  });
}

function setTestStatus(id, status) {
  api('/api/test-sessions/' + id + '/note', { method: 'PUT', body: JSON.stringify({ status: status }) }).then(function() {
    showToast('Status updated', 'success');
    closeDetail('testDetail');
    loadTestHistory();
  });
}

function deleteTestSession(id) {
  if (!confirm('Delete this test session permanently?')) return;
  api('/api/test-sessions/' + id, { method: 'DELETE' }).then(function() {
    showToast('Session deleted', 'success');
    closeDetail('testDetail');
    loadTestHistory();
  });
}

/* ── Download Test Session as PDF ── */
function downloadTestSessionPDF() {
  if (!currentTestSession) { showToast('No session loaded', 'error'); return; }
  var s = currentTestSession;
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  var pageW = doc.internal.pageSize.getWidth();
  var pageH = doc.internal.pageSize.getHeight();
  var margin = 16;
  var contentW = pageW - margin * 2;
  var y = margin;

  function checkPage(needed) {
    if (y + needed > pageH - 20) {
      doc.addPage();
      y = margin;
    }
  }

  function sectionTitle(text) {
    checkPage(14);
    y += 4;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(60, 60, 60);
    doc.text(text.toUpperCase(), margin, y);
    y += 2;
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, y, pageW - margin, y);
    y += 6;
  }

  function bodyText(text, opts) {
    opts = opts || {};
    doc.setFontSize(opts.size || 10);
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    doc.setTextColor(opts.color || '#333333');
    var lines = doc.splitTextToSize(text || '', contentW - (opts.indent || 0));
    lines.forEach(function(line) {
      checkPage(5);
      doc.text(line, margin + (opts.indent || 0), y);
      y += 4.5;
    });
  }

  // ── Header ──
  doc.setFontSize(18);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(17, 17, 17);
  doc.text('October AI', margin, y);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(120, 120, 120);
  doc.text('Test Session Report', margin + 42, y);
  y += 10;

  // Date + vertical
  var date = s.created_at ? new Date(s.created_at).toLocaleDateString('da-DK', { day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '-';
  bodyText(date + '  |  ' + (s.vertical || 'Unknown vertical'), { size: 11, bold: true });
  y += 2;

  // Meta row
  var metaParts = [];
  if (s.model) metaParts.push('Model: ' + s.model);
  if (s.temperature !== null && s.temperature !== undefined) metaParts.push('Temp: ' + s.temperature);
  metaParts.push('Duration: ' + (s.duration_seconds || 0) + 's');
  metaParts.push('Messages: ' + (s.message_count || 0));
  bodyText(metaParts.join('   |   '), { size: 9, color: '#888888' });
  y += 4;

  // ── GPT Scores ──
  var scores = s.gpt_scores || {};
  var scoreKeys = Object.keys(scores);
  if (scoreKeys.length > 0) {
    var overall = calcOverall(scores);
    sectionTitle('GPT Scores — Overall: ' + overall.toFixed(1) + '/10');

    var scoreOrder = ['one_question','reacts_to_guest','navigation','natural_tone','qualifying','conversion_focus','response_quality','response_time','opening_quality','overall_impression'];
    var tableBody = [];
    scoreOrder.forEach(function(key) {
      var sc = scores[key];
      if (!sc) return;
      tableBody.push([SCORE_LABELS[key] || key, sc.score + '/10', sc.explanation || '']);
    });

    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Criterion', 'Score', 'Explanation']],
      body: tableBody,
      styles: { fontSize: 8.5, cellPadding: 3, lineColor: [220, 220, 220], lineWidth: 0.3, textColor: [50, 50, 50] },
      headStyles: { fillColor: [245, 245, 240], textColor: [60, 60, 60], fontStyle: 'bold', fontSize: 8.5 },
      columnStyles: { 0: { cellWidth: 38 }, 1: { cellWidth: 16, halign: 'center', fontStyle: 'bold' }, 2: { cellWidth: contentW - 54 } },
      didParseCell: function(data) {
        if (data.section === 'body' && data.column.index === 1) {
          var val = parseInt(data.cell.raw);
          if (val <= 5) data.cell.styles.textColor = [220, 38, 38];
          else if (val <= 7) data.cell.styles.textColor = [217, 119, 6];
          else data.cell.styles.textColor = [22, 163, 74];
        }
      }
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Ready status ──
  if (s.gpt_ready_for_customers !== null && s.gpt_ready_for_customers !== undefined) {
    checkPage(14);
    var readyLabel = s.gpt_ready_for_customers ? 'READY FOR CUSTOMERS' : 'NOT READY FOR CUSTOMERS';
    var readyColor = s.gpt_ready_for_customers ? '#16a34a' : '#dc2626';
    bodyText(readyLabel, { size: 11, bold: true, color: readyColor });
    if (s.gpt_ready_explanation) {
      bodyText(s.gpt_ready_explanation, { size: 9, color: '#666666', indent: 0 });
    }
    y += 4;
  }

  // ── GPT Flags ──
  var flags = s.gpt_flags || [];
  if (flags.length > 0) {
    sectionTitle('GPT Flags');
    flags.forEach(function(f) {
      var prefix = (f.severity || 'minor').toUpperCase();
      bodyText(prefix + ': ' + (f.issue || ''), { size: 9 });
    });
    y += 2;
  }

  // ── Automatic Warnings ──
  var latencyLog = s.latency_log || [];
  var allWarnings = [];
  latencyLog.forEach(function(turn) {
    if (turn.warnings && turn.warnings.length > 0) {
      turn.warnings.forEach(function(w) { allWarnings.push(w); });
    }
  });
  if (allWarnings.length > 0) {
    sectionTitle('Automatic Warnings');
    allWarnings.forEach(function(w) {
      bodyText((w.type || '') + ': ' + (w.detail || w.message || ''), { size: 9, color: '#d97706' });
    });
    y += 2;
  }

  // ── GPT Summary ──
  if (s.gpt_summary) {
    sectionTitle('GPT Summary');
    bodyText(s.gpt_summary, { size: 10 });
    y += 2;
  }

  // ── Biggest Problem ──
  if (s.gpt_biggest_problem) {
    sectionTitle('Biggest Problem');
    bodyText(s.gpt_biggest_problem, { size: 10, color: '#d97706' });
    y += 2;
  }

  // ── Transcript ──
  var transcript = s.transcript || [];
  if (transcript.length > 0) {
    sectionTitle('Transcript (' + transcript.length + ' messages)');
    transcript.forEach(function(msg, idx) {
      var role = (msg.role || 'user').toUpperCase();
      var text = msg.text || msg.content || '';
      var turnData = latencyLog[idx] || {};
      var totalMs = turnData.total_ms || (turnData.latency && turnData.latency.total_ms) || 0;

      checkPage(12);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(role === 'USER' || role === 'GUEST' ? '#3b82f6' : '#8B6F4E');
      doc.text('[' + role + ']', margin, y);
      if (totalMs) {
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(170, 170, 170);
        doc.text(totalMs + 'ms', pageW - margin - 12, y);
      }
      y += 4;

      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(50, 50, 50);
      var lines = doc.splitTextToSize(text, contentW - 4);
      lines.forEach(function(line) {
        checkPage(4.5);
        doc.text(line, margin + 2, y);
        y += 4;
      });
      y += 2;
    });
  }

  // ── Latency Table ──
  if (latencyLog.length > 0) {
    sectionTitle('Latency per Turn');
    var latencyBody = [];
    latencyLog.forEach(function(t, i) {
      var ms = t.total_ms || (t.latency && t.latency.total_ms) || 0;
      var stt = t.stt_ms || (t.latency && t.latency.stt_ms) || 0;
      var llm = t.llm_ms || (t.latency && t.latency.llm_ms) || 0;
      var tts = t.tts_ms || (t.latency && t.latency.tts_ms) || 0;
      latencyBody.push(['Turn ' + (i + 1), ms + 'ms', stt + 'ms', llm + 'ms', tts + 'ms']);
    });
    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Turn', 'Total', 'STT', 'LLM', 'TTS']],
      body: latencyBody,
      styles: { fontSize: 8, cellPadding: 2.5, lineColor: [220, 220, 220], lineWidth: 0.3, textColor: [50, 50, 50] },
      headStyles: { fillColor: [245, 245, 240], textColor: [60, 60, 60], fontStyle: 'bold', fontSize: 8 },
      columnStyles: { 0: { cellWidth: 20 } },
      didParseCell: function(data) {
        if (data.section === 'body' && data.column.index === 1) {
          var ms = parseInt(data.cell.raw);
          if (ms > 3000) data.cell.styles.textColor = [220, 38, 38];
          else if (ms > 2000) data.cell.styles.textColor = [217, 119, 6];
          else data.cell.styles.textColor = [22, 163, 74];
        }
      }
    });
    y = doc.lastAutoTable.finalY + 6;
  }

  // ── Manual Notes ──
  if (s.manual_note) {
    sectionTitle('Tester Notes');
    bodyText(s.manual_note, { size: 10 });
    y += 2;
  }

  // ── Rating ──
  if (s.manual_rating) {
    checkPage(8);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(139, 111, 78);
    doc.text('Manual rating: ' + s.manual_rating + '/5', margin, y);
    y += 5;
  }

  // ── Tags ──
  var tags = s.manual_tags || [];
  if (tags.length > 0) {
    checkPage(8);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 100, 100);
    doc.text('Tags: ' + tags.join(', '), margin, y);
    y += 5;
  }

  // ── Footer ──
  var pageCount = doc.internal.getNumberOfPages();
  for (var p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(180, 180, 180);
    doc.text('October AI — Test Session Report — Page ' + p + '/' + pageCount, margin, pageH - 8);
    doc.text('Generated ' + new Date().toLocaleDateString('da-DK', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }), pageW - margin - 50, pageH - 8);
  }

  // Save
  var filename = 'test-session_' + (s.vertical || 'unknown') + '_' + (s.created_at ? new Date(s.created_at).toISOString().slice(0, 10) : 'undated') + '.pdf';
  doc.save(filename);
  showToast('PDF downloaded', 'success');
}

function generateFixReport() {
  var vertical = prompt('Enter vertical (all, hotel, education, retail, real_estate_sale, real_estate_development):', 'all');
  if (!vertical) return;
  showToast('Generating fix report...', 'info');
  api('/api/test-sessions/report', { method: 'POST', body: JSON.stringify({ vertical: vertical }) }).then(function(data) {
    lastFixReport = data.report || '';
    showModal('<h2 style="font-family:var(--serif);margin-bottom:16px">Fix Report</h2>'
      + '<div style="white-space:pre-wrap;font-size:13px;line-height:1.7;max-height:60vh;overflow-y:auto">' + esc(lastFixReport) + '</div>'
      + '<div style="display:flex;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">'
      + '<button class="btn btn-dark btn-sm" onclick="copyFixReport()">Copy report</button>'
      + '<button class="btn btn-outline btn-sm" onclick="copyFixForClaude()">Send to Claude Code</button>'
      + '</div>');
  }).catch(function(e) { showToast('Report failed: ' + e.message, 'error'); });
}

function copyFixReport() {
  navigator.clipboard.writeText(lastFixReport);
  showToast('Report copied', 'success');
}

function copyFixForClaude() {
  var formatted = 'OCTOBER AI \u2014 AGENT FIX REPORT\nGenerated: ' + new Date().toISOString().slice(0,10) + '\n\n'
    + lastFixReport + '\n\nINSTRUCTIONS FOR CLAUDE CODE:\nRead this report and generate targeted fix prompts for each issue in priority order.\nStart with the biggest problem identified above.';
  navigator.clipboard.writeText(formatted);
  showToast('Copied for Claude Code', 'success');
}

/* ═══════════════════════════════════════════════
   TEST PROTOCOL PAGE
   ═══════════════════════════════════════════════ */
function loadTestProtocol() {
  var c = document.getElementById('page-test-protocol');
  c.innerHTML = '<div class="page-label">AGENT BUILDER</div>'
    + '<h1 class="page-heading">Test Protocol</h1>'
    + '<p class="page-sub">Standardized test procedures for evaluating voice agents.</p>'

    + '<div style="background:var(--cream);border-radius:10px;padding:16px 20px;margin-bottom:24px">'
    + '<h3 style="font-family:var(--serif);font-size:18px;font-weight:400;margin:0 0 10px">How to run a test</h3>'
    + '<ol style="font-size:13px;line-height:1.8;padding-left:20px;margin:0">'
    + '<li>Open the tour with <code style="background:var(--white);padding:1px 6px;border-radius:4px;font-size:12px;border:1px solid var(--border)">?test=true</code> in the URL</li>'
    + '<li>The red "TEST MODE" badge confirms test logging is active</li>'
    + '<li>Follow the protocol for the relevant vertical below</li>'
    + '<li>Click "End &amp; evaluate" button when done</li>'
    + '<li>The session saves automatically and appears in Test History with GPT scores</li>'
    + '</ol></div>'

    // Protocol tabs
    + '<div style="display:flex;gap:0;border:1.5px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:24px;flex-wrap:wrap">'
    + '<button class="proto-tab active" onclick="showProto(\'standard\',this)">Standard</button>'
    + '<button class="proto-tab" onclick="showProto(\'hotel\',this)">Hotel</button>'
    + '<button class="proto-tab" onclick="showProto(\'education\',this)">Education</button>'
    + '<button class="proto-tab" onclick="showProto(\'retail\',this)">Retail</button>'
    + '<button class="proto-tab" onclick="showProto(\'real_estate_sale\',this)">Real Estate Sale</button>'
    + '<button class="proto-tab" onclick="showProto(\'real_estate_development\',this)">Real Estate Dev</button>'
    + '</div>'
    + '<style>.proto-tab{padding:8px 16px;font-size:13px;border:none;background:var(--cream);color:var(--muted);cursor:pointer;transition:all 0.2s;font-weight:500;font-family:var(--sans)}.proto-tab.active{background:var(--black);color:var(--white)}.proto-tab:hover:not(.active){background:var(--border)}</style>'

    // Standard
    + '<div class="proto-section active" id="proto-standard">'
    + testCard('Session Test', '10 times per vertical', 'Run a full conversation from greeting to conversion. Close and reopen. Verify state resets correctly.')
    + testCard('Stress Test', '3 times', 'Speak quickly. Interrupt the agent mid-sentence. Speak again immediately. Reveals race conditions and double-response bugs.')
    + testCard('Idle Test', '2 times', 'Open the agent and wait 10 minutes without speaking. Then speak. Reveals WebSocket degradation and silence follow-up quality.')
    + testCard('Conversion Test', '5 times', 'Run the conversation targeted towards conversion. Verify booking URL opens correctly and trigger_conversion tool call works.')
    + '<div style="background:var(--cream);border-radius:10px;padding:16px 20px"><h4 style="margin:0 0 8px;font-size:14px">General checks (all verticals)</h4>'
    + protoCheck('Latency', 'Total turn time under 3 seconds')
    + protoCheck('Language', 'Agent stays consistent with configured language')
    + protoCheck('Tool leaks', 'No tool calls or JSON leaks into spoken responses')
    + protoCheck('Repetition', 'Agent does not repeat itself')
    + protoCheck('Silence follow-up', 'On silence, agent asks a natural follow-up question')
    + protoCheck('State reset', 'New session starts with fresh greeting \u2014 no memory from before')
    + '</div></div>'

    // Hotel
    + '<div class="proto-section" id="proto-hotel" style="display:none">'
    + protoQuestions('Hotel', [
      ['Greeting test', 'Say nothing \u2014 wait for the agent. Check greeting is warm, short and natural.'],
      ['Factual knowledge', '"What time is check-in?"'],
      ['Facilities', '"Do you have parking available?"'],
      ['Qualifying + recommendation', '"I\'m traveling with two kids \u2014 what room would you recommend?"'],
      ['Navigation', '"Show me what the suite looks like"'],
      ['Restaurant/facilities', '"Is the restaurant open for dinner?"'],
      ['Details', '"What\'s included in the breakfast?"'],
      ['Conversion', '"I\'d like to book a room for this weekend"']
    ]) + '</div>'

    // Education
    + '<div class="proto-section" id="proto-education" style="display:none">'
    + protoQuestions('Education', [
      ['Greeting', '"Hi, I\'m considering studying here"'],
      ['Program overview', '"What programs do you offer?"'],
      ['Specific program', '"I\'m interested in business \u2014 what courses are available?"'],
      ['Practical info', '"Will my credits transfer back home?"'],
      ['Navigation', '"Can you show me the campus facilities?"'],
      ['Housing', '"What\'s student housing like?"'],
      ['Conversion', '"How do I apply for next semester?"']
    ]) + '</div>'

    // Retail
    + '<div class="proto-section" id="proto-retail" style="display:none">'
    + protoQuestions('Retail', [
      ['Greeting', '"I\'m looking for a sofa"'],
      ['Specific preference', '"Do you have anything in grey?"'],
      ['Price', '"What\'s the price range for sofas?"'],
      ['Materials', '"What materials do you offer?"'],
      ['Navigation', '"Show me your premium collection"'],
      ['Delivery', '"What\'s the delivery time?"'],
      ['Conversion', '"I want to order the grey leather one"']
    ]) + '</div>'

    // Real Estate Sale
    + '<div class="proto-section" id="proto-real_estate_sale" style="display:none">'
    + protoQuestions('Real Estate Sale', [
      ['Greeting', '"I\'m looking for a home"'],
      ['Size', '"What\'s the square footage?"'],
      ['Room details', '"How big is the master bedroom?"'],
      ['Area', '"What school district is this in?"'],
      ['Navigation', '"Show me the living room"'],
      ['Financials', '"What are the HOA fees?"'],
      ['Conversion', '"I\'d like to schedule a viewing"']
    ]) + '</div>'

    // Real Estate Development
    + '<div class="proto-section" id="proto-real_estate_development" style="display:none">'
    + protoQuestions('Real Estate Development', [
      ['Greeting', '"I\'m interested in this development"'],
      ['Qualifying', '"Are you looking to live here or invest?"'],
      ['Availability', '"What units are still available?"'],
      ['Yield', '"What\'s the expected rental yield?"'],
      ['Navigation', '"Show me a two-bedroom unit"'],
      ['Timeline', '"When is the completion date?"'],
      ['Financing', '"What financing options do you offer?"'],
      ['Conversion', '"How do I reserve a unit?"']
    ]) + '</div>';
}

function testCard(title, repeat, desc) {
  return '<div style="background:var(--cream);border-radius:10px;padding:16px 20px;margin-bottom:12px">'
    + '<h4 style="font-family:var(--serif);font-size:16px;font-weight:400;margin:0 0 4px">' + title + '</h4>'
    + '<span style="display:inline-block;font-size:10px;font-weight:600;color:#8B6F4E;background:rgba(139,111,78,0.08);padding:2px 8px;border-radius:980px;margin-bottom:6px">' + repeat + '</span>'
    + '<p style="font-size:13px;color:var(--muted);line-height:1.6;margin:0">' + desc + '</p></div>';
}

function protoCheck(label, text) {
  return '<div style="font-size:13px;padding:6px 12px;border-left:3px solid var(--border);margin-bottom:4px;background:var(--white);border-radius:0 6px 6px 0">'
    + '<span style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;display:block;margin-bottom:1px">' + label + '</span>' + text + '</div>';
}

function protoQuestions(title, items) {
  var html = '<div style="background:var(--cream);border-radius:10px;padding:16px 20px">'
    + '<h4 style="font-family:var(--serif);font-size:16px;font-weight:400;margin:0 0 10px">' + title + ' test questions</h4>';
  items.forEach(function(item) {
    html += protoCheck(item[0], item[1]);
  });
  return html + '</div>';
}

function showProto(id, btn) {
  document.querySelectorAll('.proto-section').forEach(function(s) { s.style.display = 'none'; });
  document.querySelectorAll('.proto-tab').forEach(function(t) { t.classList.remove('active'); });
  document.getElementById('proto-' + id).style.display = 'block';
  if (btn) btn.classList.add('active');
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

/* Client Portal — opens in new tab at /client/demo/agent */


/* ── Keyboard shortcuts ── */
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeModal();
    document.querySelectorAll('.detail-overlay.open').forEach(function(d) { d.classList.remove('open'); });
  }
});

/* ── INIT ── */
var initPage = window.location.hash ? window.location.hash.replace('#', '') : 'overview';
navigateTo(initPage);
