/* ═══════════════════════════════════════════════════
   CLIENT PORTAL — Shared JavaScript
   Included on all client subpages.
   ═══════════════════════════════════════════════════ */

/* ── Token & routing ── */
var PP = window.location.pathname.split('/');
var TOKEN = PP[2] || '';
var BASE = '/client/' + TOKEN;
var SERVER = window.location.origin;
var PRODUCTION_SERVER = 'https://www.october-ai.com';

if (!TOKEN) { window.location.href = '/'; }

/* Save token for intelligent routing */
localStorage.setItem('october_client_token', TOKEN);

/* ── Shared data store ── */
var CLIENT_DATA = null;
var ACTIVE_TENANT = null;
var ALL_TENANTS = [];
var CACHED_TENANT_ID = null;

/* ── Fetch client data ── */
async function getClientData() {
  try {
    var res = await fetch(SERVER + '/client/' + TOKEN + '/data');
    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      throw new Error(err.error || 'HTTP ' + res.status);
    }
    CLIENT_DATA = await res.json();
    if (CLIENT_DATA.tenantId) CACHED_TENANT_ID = CLIENT_DATA.tenantId;

    /* Build tenants list */
    ALL_TENANTS = CLIENT_DATA.tenants || [];
    if (ALL_TENANTS.length === 0 && CLIENT_DATA.tenantId) {
      ALL_TENANTS = [{ id: CLIENT_DATA.tenantId, name: CLIENT_DATA.agentName || CLIENT_DATA.propertyName || 'Agent' }];
    }

    /* Determine active tenant */
    var storedTenant = localStorage.getItem('october_active_tenant_' + TOKEN);
    if (storedTenant && ALL_TENANTS.some(function(t) { return t.id === storedTenant; })) {
      ACTIVE_TENANT = ALL_TENANTS.find(function(t) { return t.id === storedTenant; });
    } else if (ALL_TENANTS.length > 0) {
      ACTIVE_TENANT = ALL_TENANTS[0];
      localStorage.setItem('october_active_tenant_' + TOKEN, ACTIVE_TENANT.id);
    }

    return CLIENT_DATA;
  } catch (e) {
    console.error('Failed to load client data:', e);
    return null;
  }
}

/* ── Fetch tenant ID ── */
async function fetchTenantId() {
  if (CACHED_TENANT_ID) return CACHED_TENANT_ID;
  try {
    var res = await fetch(SERVER + '/client/' + TOKEN + '/preview');
    var data = await res.json();
    CACHED_TENANT_ID = data.tenantId || null;
    return CACHED_TENANT_ID;
  } catch (e) { return null; }
}

/* ── POST helpers ── */
async function updateTenant(data) {
  var res = await fetch(SERVER + '/client/' + TOKEN + '/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function uploadText(text) {
  var res = await fetch(SERVER + '/client/' + TOKEN + '/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text })
  });
  return res.json();
}

async function uploadFile(file) {
  var fd = new FormData();
  fd.append('file', file);
  var res = await fetch(SERVER + '/client/' + TOKEN + '/upload-file', {
    method: 'POST',
    body: fd
  });
  return res.json();
}

async function scrapeWebsite() {
  var res = await fetch(SERVER + '/client/' + TOKEN + '/scrape', { method: 'POST' });
  return res.json();
}

async function addSpace(data) {
  var body = { label: data.name || data.label, sweepId: data.sweepId || '' };
  var res = await fetch(SERVER + '/client/' + TOKEN + '/spaces/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function updateSpace(data) {
  var body = { roomId: data.oldKey || data.roomId, label: data.name || data.label, sweepId: data.sweepId || '' };
  var res = await fetch(SERVER + '/client/' + TOKEN + '/spaces/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function deleteSpace(data) {
  var body = { roomId: data.name || data.roomId };
  var res = await fetch(SERVER + '/client/' + TOKEN + '/spaces/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function purchaseMinutes(pkg) {
  var res = await fetch(SERVER + '/client/' + TOKEN + '/purchase-minutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: pkg })
  });
  return res.json();
}

/* ── Agent switcher ── */
function renderAgentSwitcher() {
  var container = document.getElementById('agentSwitcher');
  if (!container) return;

  var activeName = ACTIVE_TENANT ? ACTIVE_TENANT.name : 'Select agent';

  var html = '<button class="agent-switcher-btn" onclick="toggleAgentSwitcher()">'
    + '<svg class="agent-switcher-arrow" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l3 3 3-3"/></svg> '
    + esc(activeName)
    + '</button>'
    + '<div class="agent-switcher-dropdown">';

  ALL_TENANTS.forEach(function(t) {
    var isActive = ACTIVE_TENANT && t.id === ACTIVE_TENANT.id;
    html += '<div class="agent-switcher-item' + (isActive ? ' active' : '') + '" onclick="switchAgent(\'' + t.id + '\')">'
      + '<span class="agent-switcher-dot"></span>'
      + esc(t.name) + (isActive ? ' (active)' : '')
      + '</div>';
  });

  html += '</div>';
  container.innerHTML = html;
}

function toggleAgentSwitcher() {
  var el = document.getElementById('agentSwitcher');
  if (el) el.classList.toggle('open');
}

function switchAgent(tenantId) {
  localStorage.setItem('october_active_tenant_' + TOKEN, tenantId);
  window.location.reload();
}

/* Close switcher on outside click */
document.addEventListener('click', function(e) {
  var sw = document.getElementById('agentSwitcher');
  if (sw && !sw.contains(e.target)) sw.classList.remove('open');
});

/* ── Navigation active state ── */
function setActiveNav() {
  var path = window.location.pathname;
  var navMap = {
    '/agent': 'navAgent',
    '/build': 'navBuild',
    '/analytics': 'navAnalytics',
    '/knowledge': 'navKnowledge',
    '/settings': 'navSettings'
  };
  /* Determine which nav is active */
  var activeKey = null;
  var stripped = path.replace(BASE, '');
  if (!stripped || stripped === '/') activeKey = '/agent';
  else {
    Object.keys(navMap).forEach(function(key) {
      if (stripped.indexOf(key) === 0) activeKey = key;
    });
  }
  if (activeKey && navMap[activeKey]) {
    var el = document.getElementById(navMap[activeKey]);
    if (el) el.classList.add('active');
  }
}

/* ── Resolve data-href links ── */
function resolveLinks() {
  document.querySelectorAll('[data-href]').forEach(function(el) {
    el.href = el.getAttribute('data-href').replace(/\{BASE\}/g, BASE);
  });
  /* Set nav trigger hrefs */
  var navLinks = {
    'navAgent': BASE + '/agent',
    'navBuild': BASE + '/build',
    'navAnalytics': BASE + '/analytics',
    'navKnowledge': BASE + '/knowledge',
    'navSettings': BASE + '/settings'
  };
  Object.keys(navLinks).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.href = navLinks[id];
  });
  /* Back link */
  var back = document.getElementById('backLink');
  if (back) back.href = BASE;
}

/* ── Open agent ── */
async function openAgent() {
  try {
    var tid = CACHED_TENANT_ID;
    if (!tid) tid = await fetchTenantId();
    if (tid) {
      window.open(SERVER + '/tour/' + tid, '_blank');
    } else {
      showToast('No agent found', true);
    }
  } catch (e) { showToast('Could not open agent', true); }
}

/* ── Generate embed code ── */
function generateEmbedCode(tenantId) {
  return '<script>\n  window.OCTOBER_TENANT_ID = "' + tenantId + '";\n  window.OCTOBER_SERVER = "' + PRODUCTION_SERVER + '";\n<\/script>\n<script src="' + PRODUCTION_SERVER + '/kunde/embed.js"><\/script>';
}

/* ── Copy to clipboard ── */
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(function() {
    if (btn) {
      var orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function() { btn.textContent = orig; }, 2000);
    }
    showToast('Copied');
  });
}

/* ── Toast ── */
var toastTimer = null;
function showToast(msg, isError, isSuccess) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '') + (isSuccess ? ' success' : '');
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { el.style.display = 'none'; }, 2500);
}

/* ── Escape HTML ── */
function esc(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ── Format duration ── */
function formatDuration(s) {
  if (!s || s <= 0) return '0s';
  var m = Math.floor(s / 60), r = Math.round(s % 60);
  return m === 0 ? r + 's' : m + 'm ' + r + 's';
}

/* ── Word count helper ── */
function countWords(text) {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

/* ── Dropzone setup ── */
function setupDropzone(dzId, inputId, onFile) {
  var dz = document.getElementById(dzId);
  var fi = document.getElementById(inputId);
  if (dz) {
    dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', function() { dz.classList.remove('dragover'); });
    dz.addEventListener('drop', function(e) { e.preventDefault(); dz.classList.remove('dragover'); if (e.dataTransfer.files.length > 0) onFile(e.dataTransfer.files[0]); });
  }
  if (fi) {
    fi.addEventListener('change', function() { if (fi.files.length > 0) onFile(fi.files[0]); });
  }
}

/* ── Tab switching ── */
function switchTab(tabName, btn) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-pane').forEach(function(p) { p.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  var pane = document.getElementById('pane-' + tabName);
  if (pane) pane.classList.add('active');
}

/* ── Init common ── */
function initCommon() {
  resolveLinks();
  setActiveNav();
}

/* ── Scroll to hash ── */
function scrollToHash() {
  if (window.location.hash) {
    var target = document.querySelector(window.location.hash);
    if (target) {
      setTimeout(function() {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);
    }
  }
}

/* ── Keyboard shortcuts ── */
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    /* Close any open modals */
    document.querySelectorAll('.modal-overlay.open').forEach(function(m) { m.classList.remove('open'); });
    document.querySelectorAll('.wizard-overlay:not(.hidden)').forEach(function(w) { w.classList.add('hidden'); });
    /* Close agent switcher */
    var sw = document.getElementById('agentSwitcher');
    if (sw) sw.classList.remove('open');
  }
});
