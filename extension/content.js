/* October AI — LinkedIn Outreach Helper · content script
 *
 * Renders a small floating panel on LinkedIn. The panel pulls the next
 * pending draft from the dashboard and lets the user:
 *   • open the lead's profile / Sales-Nav search
 *   • fill the draft into LinkedIn's own compose box
 *   • copy the draft to the clipboard
 *   • mark the lead as sent (after THEY click LinkedIn's Send)
 *   • skip the lead
 *
 * IMPORTANT — by design this script NEVER clicks Send, Connect, or submits
 * anything to LinkedIn. It only writes text into a field the user already
 * opened. The human stays in the loop for every outbound action. This keeps
 * the workflow within LinkedIn's terms and avoids automation bans. */

(function () {
  if (window.__oaiLiPanelMounted) return;
  window.__oaiLiPanelMounted = true;

  let current = null; // current lead object

  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));

  /* ── Build panel ─────────────────────────────────────────────── */
  const panel = document.createElement("div");
  panel.id = "oai-li-panel";
  panel.innerHTML = `
    <div class="oai-hd">
      <span class="oai-logo">October AI</span>
      <div class="oai-hd-r">
        <span id="oai-backlog" class="oai-pill">—</span>
        <button id="oai-min" title="Minimize">–</button>
      </div>
    </div>
    <div class="oai-body">
      <div id="oai-empty" class="oai-empty">Click <b>Get next</b> to load a draft.</div>
      <div id="oai-lead" class="oai-lead" style="display:none">
        <div class="oai-lead-top">
          <div>
            <div id="oai-name" class="oai-name"></div>
            <div id="oai-company" class="oai-company"></div>
          </div>
          <span id="oai-channel" class="oai-chan"></span>
        </div>
        <div class="oai-fnrow">
          <input id="oai-fn" type="text" placeholder="Person's first name (fills [Name])" autocomplete="off" spellcheck="false">
          <button id="oai-setname" class="oai-btn ghost">Set</button>
        </div>
        <textarea id="oai-draft" rows="7" spellcheck="false"></textarea>
        <div id="oai-charcount" class="oai-cc"></div>
        <div class="oai-actions">
          <button id="oai-open" class="oai-btn ghost">Open profile</button>
          <button id="oai-fill" class="oai-btn primary">Fill message</button>
          <button id="oai-copy" class="oai-btn ghost">Copy</button>
        </div>
        <div class="oai-actions">
          <button id="oai-sent" class="oai-btn ok">Mark sent</button>
          <button id="oai-skip" class="oai-btn ghost">Skip</button>
        </div>
      </div>
    </div>
    <div class="oai-foot">
      <button id="oai-next" class="oai-btn wide">Get next →</button>
    </div>
    <div id="oai-msg" class="oai-msg"></div>
  `;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector(id);
  const toast = (text, kind = "") => {
    const m = $("#oai-msg");
    m.textContent = text;
    m.className = "oai-msg show " + kind;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (m.className = "oai-msg"), 3200);
  };

  /* ── Minimize toggle ─────────────────────────────────────────── */
  $("#oai-min").addEventListener("click", () => {
    panel.classList.toggle("min");
    $("#oai-min").textContent = panel.classList.contains("min") ? "+" : "–";
  });

  /* ── Stats / backlog pill ────────────────────────────────────── */
  async function refreshStats() {
    const r = await send({ type: "GET_STATS" });
    if (r && r.ok) {
      const c = r.data.counts || {};
      $("#oai-backlog").textContent = (r.data.backlog ?? 0) + " queued";
      $("#oai-backlog").title = `draft ${c.draft_ready || 0} · approved ${c.approved || 0} · sent ${c.sent || 0} · replied ${c.replied || 0}`;
    } else {
      $("#oai-backlog").textContent = "offline";
      if (r && r.error) toast(r.error, "err");
    }
  }

  /* ── Render a lead ───────────────────────────────────────────── */
  function showLead(lead) {
    current = lead;
    $("#oai-empty").style.display = "none";
    $("#oai-lead").style.display = "block";
    $("#oai-name").textContent = lead.name || "(no name)";
    $("#oai-company").textContent = lead.company || "";
    const ch = lead.channel === "inmail" ? "InMail" : "Connection note";
    $("#oai-channel").textContent = ch;
    $("#oai-channel").className = "oai-chan " + (lead.channel || "");
    $("#oai-fn").value = lead.first_name || "";
    $("#oai-draft").value = lead.outreach_draft || "";
    updateCharCount();
  }

  /* ── Set the person's first name (fills the [Name] token) ──────── */
  async function setName() {
    if (!current) return;
    const fn = $("#oai-fn").value.trim();
    $("#oai-setname").disabled = true;
    const r = await send({ type: "SET_NAME", id: current.id, firstName: fn });
    $("#oai-setname").disabled = false;
    if (!r || !r.ok) { toast((r && r.error) || "Failed", "err"); return; }
    if (r.data && r.data.lead) {
      current.first_name = r.data.lead.first_name;
      current.outreach_draft = r.data.lead.outreach_draft;
      $("#oai-draft").value = r.data.lead.outreach_draft || "";
      updateCharCount();
    }
    toast(fn ? "Name set — draft updated" : "Name cleared — [Name] restored", "ok");
  }

  function updateCharCount() {
    const len = $("#oai-draft").value.length;
    const isNote = current && current.channel === "note";
    const limit = isNote ? 300 : 1900;
    const el = $("#oai-charcount");
    el.textContent = `${len}${isNote ? " / 300 (note limit)" : ""}`;
    el.className = "oai-cc" + (isNote && len > 300 ? " over" : "");
  }
  $("#oai-draft").addEventListener("input", updateCharCount);
  $("#oai-setname").addEventListener("click", setName);
  $("#oai-fn").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); setName(); } });

  /* ── Get next ────────────────────────────────────────────────── */
  async function getNext() {
    $("#oai-next").disabled = true;
    $("#oai-next").textContent = "Loading…";
    const r = await send({ type: "GET_NEXT" });
    $("#oai-next").disabled = false;
    $("#oai-next").textContent = "Get next →";
    if (!r || !r.ok) { toast((r && r.error) || "Request failed", "err"); return; }
    if (!r.data.lead) {
      current = null;
      $("#oai-lead").style.display = "none";
      $("#oai-empty").style.display = "block";
      $("#oai-empty").textContent = "Queue is empty — no pending drafts.";
      refreshStats();
      return;
    }
    showLead(r.data.lead);
    refreshStats();
  }
  $("#oai-next").addEventListener("click", getNext);

  /* ── Open profile / search ───────────────────────────────────── */
  $("#oai-open").addEventListener("click", () => {
    if (!current) return;
    const url = current.search_url || current.profile_url;
    if (url) window.open(url, "_blank", "noopener");
    else toast("No profile URL for this lead", "err");
  });

  /* ── Copy ────────────────────────────────────────────────────── */
  $("#oai-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#oai-draft").value);
      toast("Copied to clipboard", "ok");
    } catch {
      toast("Copy failed — select and copy manually", "err");
    }
  });

  /* ── Fill LinkedIn's compose box ─────────────────────────────────
     Locates the open message/InMail/connection-note field and writes the
     draft into it, dispatching the events React listens for so the value
     "sticks". Does NOT submit — the user reviews and clicks Send. */
  function findComposeField() {
    const sel = [
      "div.msg-form__contenteditable[contenteditable='true']", // messaging / InMail
      "textarea#custom-message",                                // connection note (old)
      "textarea[name='message']",                               // connection note (variant)
      "div[role='textbox'][contenteditable='true']",            // generic LI editor
      ".msg-form__msg-content-container [contenteditable='true']"
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return el; // visible
    }
    // fall back to whatever editable element is focused
    const a = document.activeElement;
    if (a && (a.isContentEditable || a.tagName === "TEXTAREA")) return a;
    return null;
  }

  function setTextareaValue(el, text) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setContentEditable(el, text) {
    el.focus();
    // Replace existing content with paragraphs LinkedIn's editor expects.
    el.innerHTML = "";
    const p = document.createElement("p");
    p.textContent = text;
    el.appendChild(p);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    // Remove the editor's "empty" placeholder state if present.
    el.classList.remove("msg-form__contenteditable--empty");
  }

  $("#oai-fill").addEventListener("click", () => {
    const text = $("#oai-draft").value;
    const field = findComposeField();
    if (!field) {
      toast("Open the message/note box on LinkedIn first, then Fill", "err");
      return;
    }
    if (field.tagName === "TEXTAREA") setTextareaValue(field, text);
    else setContentEditable(field, text);
    toast("Filled — review, then click LinkedIn's Send", "ok");
  });

  /* ── Mark sent ───────────────────────────────────────────────── */
  $("#oai-sent").addEventListener("click", async () => {
    if (!current) return;
    $("#oai-sent").disabled = true;
    const r = await send({ type: "MARK_SENT", id: current.id });
    $("#oai-sent").disabled = false;
    if (!r || !r.ok) { toast((r && r.error) || "Failed", "err"); return; }
    toast("Marked sent ✓", "ok");
    getNext();
  });

  /* ── Skip ────────────────────────────────────────────────────── */
  $("#oai-skip").addEventListener("click", async () => {
    if (!current) return;
    const r = await send({ type: "SKIP", id: current.id });
    if (!r || !r.ok) { toast((r && r.error) || "Failed", "err"); return; }
    toast("Skipped", "ok");
    getNext();
  });

  refreshStats();
})();
