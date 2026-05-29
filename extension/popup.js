/* October AI — LinkedIn Outreach Helper · popup
   Lets the user set the dashboard URL + admin token, then pings /stats to
   confirm the connection and show the current backlog. */

const DEFAULTS = {
  apiBase: "https://admin-dashboard-production-e40e.up.railway.app",
  token: "october-admin-2026"
};

const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.sync.get(["apiBase", "token"]);
  $("apiBase").value = s.apiBase || DEFAULTS.apiBase;
  $("token").value = s.token || DEFAULTS.token;
  ping();
}

function setMsg(text, kind) {
  const m = $("msg");
  m.textContent = text;
  m.className = "msg " + (kind || "");
}

async function ping() {
  const r = await chrome.runtime.sendMessage({ type: "GET_STATS" });
  if (r && r.ok) {
    const c = r.data.counts || {};
    $("stats").style.display = "block";
    $("stats").innerHTML =
      `<b>${r.data.backlog ?? 0}</b> in queue · ETA ~${r.data.eta_weeks ?? "?"} wk<br>` +
      `draft ${c.draft_ready || 0} · approved ${c.approved || 0} · sent ${c.sent || 0} · replied ${c.replied || 0}<br>` +
      `InMail today ${r.data.caps?.inmail?.used_today ?? 0}/${r.data.caps?.inmail?.cap ?? "?"} · ` +
      `notes today ${r.data.caps?.note?.used_today ?? 0}/${r.data.caps?.note?.daily_cap ?? "?"}`;
    setMsg("Connected ✓", "ok");
  } else {
    $("stats").style.display = "none";
    setMsg((r && r.error) || "Could not reach dashboard", "err");
  }
}

$("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    apiBase: $("apiBase").value.trim().replace(/\/+$/, ""),
    token: $("token").value.trim()
  });
  setMsg("Saved — testing…", "");
  ping();
});

load();
