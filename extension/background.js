/* October AI — LinkedIn Outreach Helper · service worker
 *
 * All network calls to the dashboard go through here. The service worker
 * holds the host_permissions grant, so it can reach the Railway API without
 * tripping the page's CORS policy. The content script and popup just send
 * messages; this worker does the fetch and returns JSON.
 *
 * It never talks to LinkedIn's servers and never sends anything on the
 * user's behalf — it only reads drafts and reports a manual "sent" click. */

const DEFAULTS = {
  apiBase: "https://admin-dashboard-production-e40e.up.railway.app",
  token: "october-admin-2026"
};

async function cfg() {
  const s = await chrome.storage.sync.get(["apiBase", "token"]);
  return {
    apiBase: (s.apiBase || DEFAULTS.apiBase).replace(/\/+$/, ""),
    token: s.token || DEFAULTS.token
  };
}

async function apiFetch(path, opts = {}) {
  const { apiBase, token } = await cfg();
  const res = await fetch(apiBase + path, {
    method: opts.method || "GET",
    headers: Object.assign(
      { "Content-Type": "application/json", "x-admin-token": token },
      opts.headers || {}
    ),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_NEXT": {
          const qs = msg.channel ? `?channel=${encodeURIComponent(msg.channel)}` : "";
          sendResponse({ ok: true, data: await apiFetch("/api/linkedin/next" + qs) });
          break;
        }
        case "GET_STATS":
          sendResponse({ ok: true, data: await apiFetch("/api/linkedin/stats") });
          break;
        case "MARK_SENT":
          sendResponse({ ok: true, data: await apiFetch(`/api/linkedin/leads/${msg.id}/sent`, { method: "POST" }) });
          break;
        case "SKIP":
          sendResponse({ ok: true, data: await apiFetch(`/api/linkedin/leads/${msg.id}/skip`, { method: "POST" }) });
          break;
        case "SET_NAME":
          // Persist the person's first name; server re-renders the [Name] token.
          sendResponse({ ok: true, data: await apiFetch(`/api/linkedin/leads/${msg.id}`, {
            method: "PATCH", body: { first_name: msg.firstName || "" }
          }) });
          break;
        case "PING":
          sendResponse({ ok: true, data: await apiFetch("/api/linkedin/stats") });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // keep the channel open for the async response
});
