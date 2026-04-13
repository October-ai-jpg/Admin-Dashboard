/**
 * October AI — Embeddable Voice Concierge Widget (V3)
 *
 * Client-side energy VAD → PCM16 over WebSocket → server STT+LLM+TTS → PCM16 playback
 * No OpenAI Realtime API dependency.
 *
 * Usage:
 *   <div id="october-ai" style="width:100%;height:600px;"></div>
 *   <script src="https://YOUR_SERVER/embed.js" data-tenant="TENANT_ID"></script>
 *
 * Or voice-only floating button:
 *   <script src="https://YOUR_SERVER/embed.js" data-tenant="TENANT_ID" data-mode="voice-only"></script>
 */
(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════════════
   * MatterportController — SDK-ready abstraction layer
   *
   * Today:  iframe + URL params (no SDK needed)
   * Future: swap internals to use mpSdk.* when commercial license is ready
   * ═══════════════════════════════════════════════════════════════════ */
  function MatterportController(iframeEl, cfg) {
    this._iframe = iframeEl;
    this._modelId = cfg.modelId || "";
    this._fadeEl = cfg.fadeEl || null;
    this._currentMode = "inside";
    this._sdkActive = false;
    this._mpSdk = null;
    this._sweepCallbacks = [];
    this._modeCallbacks = [];
    this._lastSweepId = null;

    // Listen for sweep.change events from Matterport iframe
    var self = this;
    this._messageHandler = function (event) {
      if (!event.data || typeof event.data !== "string") return;
      try {
        var msg = JSON.parse(event.data);
        if (msg.type === "sweep.change" || msg.type === "sweep" || (msg.namespace === "showcase" && msg.type === "sweep")) {
          var sweepId = msg.sweepId || (msg.data && msg.data.sweepId) || msg.sid;
          if (sweepId && sweepId !== self._lastSweepId) {
            self._lastSweepId = sweepId;
            self._sweepCallbacks.forEach(function (cb) { try { cb(sweepId); } catch (e) {} });
          }
        }
      } catch (e) {}
    };
    window.addEventListener("message", this._messageHandler);

    // SDK activation: check for pre-set key or listen for runtime event
    if (window.MATTERPORT_SDK_KEY) {
      this.activateSDK(window.MATTERPORT_SDK_KEY);
    }
    this._sdkEventHandler = function (e) {
      if (e.detail && e.detail.sdkKey) self.activateSDK(e.detail.sdkKey);
    };
    window.addEventListener("enableMatterportSDK", this._sdkEventHandler);
  }

  MatterportController.prototype.navigateToSweep = function (sweepId) {
    if (!this._iframe || !sweepId) return;
    if (this._sdkActive && this._mpSdk) {
      // SDK path (future)
      try { this._mpSdk.Sweep.moveTo(sweepId); } catch (e) { console.warn("[MatterportCtrl] SDK moveTo failed:", e); }
      return;
    }
    // iframe fallback: reload src with sweep param
    var url = "https://my.matterport.com/show/?m=" + this._modelId + "&ss=" + sweepId + "&sr=-.05,.5&play=1&qs=1";
    var iframe = this._iframe;
    var fadeEl = this._fadeEl;
    if (fadeEl) {
      fadeEl.classList.add("active");
      setTimeout(function () {
        iframe.src = url;
        iframe.addEventListener("load", function onLoad() {
          iframe.removeEventListener("load", onLoad);
          setTimeout(function () { fadeEl.classList.remove("active"); }, 400);
        }, { once: true });
        setTimeout(function () { fadeEl.classList.remove("active"); }, 4000);
      }, 350);
    } else {
      iframe.src = url;
    }
  };

  MatterportController.prototype.setViewMode = function (mode) {
    if (!this._iframe || !this._modelId) return;
    if (!["inside", "floorplan", "dollhouse"].includes(mode)) return;
    if (mode === this._currentMode) return;

    var prevMode = this._currentMode;
    this._currentMode = mode;

    if (this._sdkActive && this._mpSdk) {
      // SDK path (future)
      var sdkModes = { inside: "INSIDE", floorplan: "FLOORPLAN", dollhouse: "DOLLHOUSE" };
      try { this._mpSdk.Mode.moveTo(this._mpSdk.Mode.Mode[sdkModes[mode]]); } catch (e) { console.warn("[MatterportCtrl] SDK mode switch failed:", e); }
      this._fireModeChange(mode, prevMode);
      return;
    }

    // iframe fallback: reload with mode-specific URL params
    var base = "https://my.matterport.com/show/?m=" + this._modelId + "&play=1&qs=1";
    if (mode === "floorplan") {
      base += "&f=1&fp=1";
    } else if (mode === "dollhouse") {
      base += "&dh=1";
    }
    // Preserve current sweep if we have one
    if (this._lastSweepId && mode === "inside") {
      base += "&ss=" + this._lastSweepId;
    }

    var iframe = this._iframe;
    var fadeEl = this._fadeEl;
    var self = this;
    if (fadeEl) {
      fadeEl.classList.add("active");
      setTimeout(function () {
        iframe.src = base;
        iframe.addEventListener("load", function onLoad() {
          iframe.removeEventListener("load", onLoad);
          setTimeout(function () { fadeEl.classList.remove("active"); }, 400);
        }, { once: true });
        setTimeout(function () { fadeEl.classList.remove("active"); }, 4000);
        self._fireModeChange(mode, prevMode);
      }, 350);
    } else {
      iframe.src = base;
      this._fireModeChange(mode, prevMode);
    }
  };

  MatterportController.prototype.getCurrentMode = function () {
    return this._currentMode;
  };

  MatterportController.prototype.enableMeasurements = function () {
    if (this._sdkActive && this._mpSdk) {
      // SDK path (future)
      return { success: true };
    }
    console.log("[MatterportCtrl] enableMeasurements requires SDK — not available in iframe mode");
    return { success: false, reason: "Requires Matterport SDK" };
  };

  MatterportController.prototype.disableMeasurements = function () {
    if (this._sdkActive && this._mpSdk) {
      return { success: true };
    }
    return { success: false, reason: "Requires Matterport SDK" };
  };

  MatterportController.prototype.toggleDefurnish = function (on) {
    if (this._sdkActive && this._mpSdk) {
      // SDK path (future)
      return { success: true };
    }
    console.log("[MatterportCtrl] toggleDefurnish requires SDK — not available in iframe mode");
    return { success: false, reason: "Requires Matterport SDK" };
  };

  MatterportController.prototype.activateSDK = function (sdkKey) {
    // Stub — will be implemented when commercial SDK license is available.
    // Steps: 1) load SDK bundle, 2) create showcase, 3) swap method internals, 4) set _sdkActive=true
    console.log("[MatterportCtrl] SDK activation requested (key:", sdkKey ? "present" : "missing", ") — stub, not yet implemented");
    // this._sdkActive = true;
    // this._mpSdk = sdk;
  };

  MatterportController.prototype.isSDKActive = function () {
    return this._sdkActive;
  };

  MatterportController.prototype.onSweepChange = function (callback) {
    if (typeof callback === "function") this._sweepCallbacks.push(callback);
  };

  MatterportController.prototype.onModeChange = function (callback) {
    if (typeof callback === "function") this._modeCallbacks.push(callback);
  };

  MatterportController.prototype._fireModeChange = function (newMode, prevMode) {
    this._modeCallbacks.forEach(function (cb) { try { cb(newMode, prevMode); } catch (e) {} });
  };

  MatterportController.prototype.destroy = function () {
    window.removeEventListener("message", this._messageHandler);
    window.removeEventListener("enableMatterportSDK", this._sdkEventHandler);
    this._sweepCallbacks = [];
    this._modeCallbacks = [];
    this._iframe = null;
    this._fadeEl = null;
    this._mpSdk = null;
  };

  /* ── Config from script tag ── */
  var scripts = document.querySelectorAll("script[data-tenant]");
  var scriptTag = scripts[scripts.length - 1];
  if (!scriptTag) { console.error("October AI: Missing data-tenant attribute"); return; }

  var TENANT_ID = scriptTag.getAttribute("data-tenant");
  var MODE = scriptTag.getAttribute("data-mode") || "full";
  var SERVER = scriptTag.src.replace(/\/embed\.js.*$/, "");
  var CONTAINER_ID = scriptTag.getAttribute("data-container") || "october-ai";

  if (!TENANT_ID) { console.error("October AI: data-tenant is required"); return; }

  /* ── VAD Parameters ── */
  var VAD_SPEECH_THRESHOLD = 0.015;
  var VAD_SILENCE_MS = 1000;             // 1s silence → end-of-speech (computed to frames in worklet)
  var VAD_SPEECH_FRAMES_TO_START = 3;
  var VAD_PRE_ROLL_FRAMES = 8;
  var VAD_MIN_SPEECH_FRAMES = 10;        // ~200ms minimum

  /* ── Inject CSS ── */
  var style = document.createElement("style");
  style.textContent = [
    ".oct-wrap{position:relative;width:100%;height:100%;min-height:400px;background:#000;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    ".oct-iframe{width:100%;height:100%;border:0;display:block}",
    ".oct-overlay{position:absolute;top:14px;right:14px;z-index:30;display:flex;align-items:flex-start;gap:10px;pointer-events:none}",
    ".oct-badge{display:flex;align-items:center;gap:10px;padding:10px 14px 10px 10px;border-radius:16px;background:linear-gradient(135deg,rgba(28,28,28,.78),rgba(12,12,12,.62));border:1px solid rgba(255,255,255,.12);color:#fff;backdrop-filter:blur(14px) saturate(130%);box-shadow:0 12px 40px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.08);transition:transform .25s,border-color .25s,box-shadow .25s;user-select:none;max-width:300px;pointer-events:none}",
    ".oct-badge.speaking{transform:translateY(-1px) scale(1.01);border-color:rgba(225,196,134,.35);box-shadow:0 14px 44px rgba(0,0,0,.32),0 0 0 1px rgba(225,196,134,.08),inset 0 1px 0 rgba(255,255,255,.08)}",
    ".oct-icon-wrap{position:relative;width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,rgba(224,197,142,.24),rgba(193,153,81,.12));border:1px solid rgba(225,196,134,.24);display:grid;place-items:center;flex:0 0 auto;overflow:hidden}",
    ".oct-glow{position:absolute;inset:0;opacity:0;border-radius:inherit;background:radial-gradient(circle,rgba(225,196,134,.22) 0%,rgba(225,196,134,0) 68%);transition:opacity .25s}",
    ".oct-badge.speaking .oct-glow{opacity:1;animation:octPulse 1.35s infinite ease-in-out}",
    ".oct-icon{width:20px;height:20px;display:block;color:#e1c486;position:relative;z-index:1}",
    ".oct-text{min-width:0;display:flex;flex-direction:column;justify-content:center;line-height:1.1}",
    ".oct-title{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,248,236,.96);white-space:nowrap}",
    ".oct-state{margin-top:3px;font-size:11px;color:rgba(255,255,255,.72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".oct-mic{width:46px;height:46px;border:none;border-radius:14px;background:linear-gradient(135deg,rgba(24,24,24,.8),rgba(10,10,10,.68));color:#fff;cursor:pointer;font-size:18px;display:grid;place-items:center;backdrop-filter:blur(12px) saturate(130%);border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 40px rgba(0,0,0,.24),inset 0 1px 0 rgba(255,255,255,.06);transition:transform .2s,opacity .2s;pointer-events:auto}",
    ".oct-mic:hover{transform:scale(1.04)}",
    ".oct-mic.muted{opacity:.7;border-color:rgba(255,255,255,.08)}",
    ".oct-fade{position:absolute;inset:0;background:#000;opacity:0;z-index:10;pointer-events:none;transition:opacity .35s ease}",
    ".oct-fade.active{opacity:1}",
    /* Loading overlay — shown during initial Matterport load */
    ".oct-loading-overlay{position:absolute;inset:0;z-index:12;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#1a1a1a;transition:opacity .6s ease}",
    ".oct-loading-overlay.hidden{opacity:0;pointer-events:none}",
    ".oct-loading-name{font-size:18px;font-weight:500;color:#fff;letter-spacing:-.02em;margin-bottom:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    ".oct-loading-dots{display:flex;gap:6px}",
    ".oct-loading-dots span{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.5);animation:octLoadDot 1.4s ease-in-out infinite}",
    ".oct-loading-dots span:nth-child(2){animation-delay:.2s}",
    ".oct-loading-dots span:nth-child(3){animation-delay:.4s}",
    "@keyframes octLoadDot{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}",
    ".oct-loading-sub{font-size:12px;color:rgba(255,255,255,.45);margin-top:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    "@keyframes octPulse{0%{transform:scale(1);opacity:.55}50%{transform:scale(1.12);opacity:.95}100%{transform:scale(1);opacity:.55}}",
    ".oct-float{position:fixed;bottom:24px;right:24px;z-index:99999;display:flex;align-items:flex-end;gap:10px;pointer-events:none}",
    ".oct-float .oct-badge{pointer-events:auto}",
    ".oct-float .oct-mic{pointer-events:auto}",
    /* Agent icon circle */
    ".oct-agent-icon{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);z-index:35;width:64px;height:64px;border-radius:50%;cursor:pointer;pointer-events:auto;border:2px solid rgba(255,255,255,.2);overflow:hidden;background:rgba(20,20,20,.85);backdrop-filter:blur(12px);display:grid;place-items:center;transition:transform .2s;animation:octIconPulse 3s infinite ease-in-out}",
    ".oct-agent-icon:hover{transform:translateX(-50%) scale(1.06)}",
    ".oct-agent-icon.speaking{border-color:rgba(225,196,134,.5);box-shadow:0 0 20px rgba(225,196,134,.15);animation:none}",
    ".oct-agent-icon.thinking{border-color:rgba(147,130,220,.4);animation:octThinkPulse 2s infinite ease-in-out}",
    ".oct-agent-icon.user_speaking{border-color:rgba(96,165,250,.5);animation:octUserPulse 1.2s infinite ease-in-out}",
    ".oct-agent-icon img{width:100%;height:100%;object-fit:cover;border-radius:50%}",
    ".oct-agent-icon svg{width:32px;height:32px;color:#e1c486}",
    /* Sound waves for speaking */
    ".oct-waves{position:absolute;bottom:0;left:50%;transform:translateX(-50%);display:flex;gap:3px;align-items:flex-end;height:20px;opacity:0;transition:opacity .2s}",
    ".oct-agent-icon.speaking .oct-waves{opacity:1}",
    ".oct-wave{width:3px;background:#e1c486;border-radius:2px;animation:octWave 0.6s infinite ease-in-out}",
    ".oct-wave:nth-child(1){animation-delay:0s;height:8px}",
    ".oct-wave:nth-child(2){animation-delay:.15s;height:14px}",
    ".oct-wave:nth-child(3){animation-delay:.3s;height:8px}",
    "@keyframes octWave{0%,100%{height:6px}50%{height:16px}}",
    "@keyframes octThinkPulse{0%,100%{border-color:rgba(147,130,220,.25);box-shadow:none}50%{border-color:rgba(147,130,220,.5);box-shadow:0 0 16px rgba(147,130,220,.12)}}",
    "@keyframes octUserPulse{0%,100%{border-color:rgba(96,165,250,.3)}50%{border-color:rgba(96,165,250,.6)}}",
    "@keyframes octIconPulse{0%,100%{border-color:rgba(255,255,255,.15);box-shadow:0 0 0 0 rgba(225,196,134,0)}50%{border-color:rgba(225,196,134,.35);box-shadow:0 0 14px rgba(225,196,134,.1)}}",
    /* Transcript panel */
    ".oct-transcript{position:absolute;bottom:96px;left:50%;transform:translateX(-50%);z-index:34;width:320px;max-height:200px;overflow-y:auto;background:rgba(12,12,12,.88);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:12px 14px;backdrop-filter:blur(14px);display:none;pointer-events:auto}",
    ".oct-transcript.open{display:block}",
    ".oct-transcript-msg{font-size:12px;line-height:1.5;margin-bottom:8px;color:rgba(255,255,255,.8)}",
    ".oct-transcript-msg.user{color:rgba(96,165,250,.9);text-align:right}",
    ".oct-transcript-msg.assistant{color:rgba(225,196,134,.9)}",
    /* Trial status pill */
    ".oct-trial-pill{position:absolute;top:14px;left:14px;z-index:36;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:500;color:#fff;background:rgba(22,163,74,.85);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.15);transition:background .5s,border-color .5s;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    ".oct-trial-pill.amber{background:rgba(217,119,6,.85);border-color:rgba(217,119,6,.3)}",
    ".oct-trial-pill.red{background:rgba(220,38,38,.85);border-color:rgba(220,38,38,.3)}",
    /* Paywall overlay */
    ".oct-paywall-bg{position:absolute;inset:0;z-index:50;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    ".oct-paywall{background:#fff;border-radius:20px;padding:40px;max-width:480px;width:90%;text-align:center;color:#111;box-shadow:0 24px 80px rgba(0,0,0,.35)}",
    ".oct-paywall-check{width:48px;height:48px;margin:0 auto 20px;background:rgba(22,163,74,.1);border-radius:50%;display:grid;place-items:center;animation:octFadeIn .6s ease}",
    ".oct-paywall-check svg{width:28px;height:28px;color:#16a34a}",
    ".oct-paywall h2{font-size:24px;font-weight:500;margin:0 0 12px;line-height:1.3}",
    ".oct-paywall .pw-sub{font-size:16px;color:#666;line-height:1.5;margin-bottom:24px}",
    ".oct-paywall .pw-bullets{text-align:left;margin:0 auto 28px;max-width:320px}",
    ".oct-paywall .pw-bullet{display:flex;align-items:center;gap:10px;font-size:15px;color:#333;margin-bottom:10px}",
    ".oct-paywall .pw-bullet svg{width:18px;height:18px;color:#16a34a;flex-shrink:0}",
    ".oct-paywall .pw-cta{display:block;width:100%;padding:16px;border:none;border-radius:12px;background:#111;color:#fff;font-size:16px;font-weight:600;cursor:pointer;transition:transform .15s,background .15s}",
    ".oct-paywall .pw-cta:hover{background:#333;transform:scale(1.01)}",
    ".oct-paywall .pw-fine{font-size:13px;color:#999;margin-top:14px;line-height:1.5}",
    ".oct-paywall .pw-link{display:inline-block;margin-top:10px;font-size:13px;color:#666;text-decoration:none;cursor:pointer}",
    ".oct-paywall .pw-link:hover{color:#111}",
    "@keyframes octFadeIn{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}",
    /* Reload popup */
    ".oct-reload-bg{position:absolute;inset:0;z-index:55;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;animation:octFadeIn .3s ease}",
    ".oct-reload{background:#fff;border-radius:20px;padding:36px 32px;max-width:380px;width:85%;text-align:center;color:#111;box-shadow:0 24px 80px rgba(0,0,0,.35)}",
    ".oct-reload-icon{width:48px;height:48px;margin:0 auto 18px;background:rgba(234,179,8,.1);border-radius:50%;display:grid;place-items:center}",
    ".oct-reload-icon svg{width:26px;height:26px;color:#d97706}",
    ".oct-reload h3{font-size:18px;font-weight:600;margin:0 0 8px;line-height:1.3}",
    ".oct-reload p{font-size:14px;color:#666;line-height:1.5;margin:0 0 24px}",
    ".oct-reload .oct-reload-btn{display:block;width:100%;padding:14px;border:none;border-radius:12px;background:#111;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:transform .15s,background .15s}",
    ".oct-reload .oct-reload-btn:hover{background:#333;transform:scale(1.01)}",
    ".oct-reload .oct-reload-btn-secondary{display:block;width:100%;padding:14px;border:1px solid #e5e7eb;border-radius:12px;background:#fff;color:#111;font-size:15px;font-weight:600;cursor:pointer;margin-top:10px;transition:background .15s}",
    ".oct-reload .oct-reload-btn-secondary:hover{background:#f5f5f5}",
    /* Demo questions panel */
    ".oct-demo-btn{position:absolute;bottom:20px;right:20px;z-index:35;width:40px;height:40px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(20,20,20,.85);backdrop-filter:blur(12px);color:#fff;font-size:18px;font-weight:600;cursor:pointer;display:grid;place-items:center;transition:transform .2s,border-color .2s;pointer-events:auto}",
    ".oct-demo-btn:hover{transform:scale(1.08);border-color:rgba(255,255,255,.35)}",
    ".oct-demo-panel{position:absolute;bottom:70px;right:20px;z-index:36;background:rgba(255,255,255,.97);border-radius:16px;padding:16px;min-width:260px;max-width:320px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    ".oct-demo-panel.open{display:block}",
    ".oct-demo-title{font-size:12px;color:#999;font-weight:500;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}",
    ".oct-demo-chip{display:block;width:100%;text-align:left;padding:10px 14px;margin-bottom:6px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;color:#333;font-size:13px;cursor:pointer;transition:background .15s,border-color .15s;line-height:1.3}",
    ".oct-demo-chip:last-child{margin-bottom:0}",
    ".oct-demo-chip:hover{background:#f9fafb;border-color:#d1d5db}",
    ".oct-demo-chip.copied{background:#f0fdf4;border-color:#86efac;color:#16a34a}",
    /* Toast notification */
    ".oct-toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:100000;background:#fff;color:#111;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:12px 20px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.15);opacity:0;transition:opacity .4s ease;pointer-events:none;max-width:400px;text-align:center;line-height:1.4}",
    ".oct-toast.visible{opacity:1}",
    /* View mode buttons — real estate only */
    ".oct-viewmode{position:absolute;top:14px;left:14px;z-index:35;display:flex;gap:6px;pointer-events:auto}",
    ".oct-viewmode-btn{padding:6px 14px;border-radius:20px;border:1px solid rgba(255,255,255,.2);background:rgba(20,20,20,.7);color:rgba(255,255,255,.85);font-size:12px;font-weight:500;cursor:pointer;backdrop-filter:blur(10px);transition:all .2s;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    ".oct-viewmode-btn:hover{background:rgba(40,40,40,.85);border-color:rgba(255,255,255,.3)}",
    ".oct-viewmode-btn.active{background:rgba(225,196,134,.2);border-color:rgba(225,196,134,.4);color:#e1c486}"
  ].join("\n");
  document.head.appendChild(style);

  /* ── Build DOM ── */
  var container = document.getElementById(CONTAINER_ID);
  var isVoiceOnly = MODE === "voice-only";
  var wrap, iframe, fadeEl;
  var matterportCtrl = null;
  var viewModeEl = null;

  if (!isVoiceOnly) {
    if (!container) { console.error("October AI: No container #" + CONTAINER_ID); return; }
    wrap = document.createElement("div");
    wrap.className = "oct-wrap";
    container.appendChild(wrap);
    iframe = document.createElement("iframe");
    iframe.className = "oct-iframe";
    iframe.allow = "microphone; autoplay";
    wrap.appendChild(iframe);
    fadeEl = document.createElement("div");
    fadeEl.className = "oct-fade";
    wrap.appendChild(fadeEl);
  }

  var overlay = document.createElement("div");
  overlay.className = isVoiceOnly ? "oct-float" : "oct-overlay";

  var badge = document.createElement("div");
  badge.className = "oct-badge";
  badge.innerHTML = [
    '<div class="oct-icon-wrap">',
    '  <div class="oct-glow"></div>',
    '  <svg class="oct-icon" viewBox="0 0 24 24" fill="none"><path d="M5 18.5C5 16.567 6.567 15 8.5 15h7C17.433 15 19 16.567 19 18.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M8.5 15v-1.1c0-1.768 1.232-3.287 2.95-3.65l.55-.116.55.116c1.718.363 2.95 1.882 2.95 3.65V15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M7.5 10.5C7.5 8.015 9.515 6 12 6s4.5 2.015 4.5 4.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="6" r="1.25" fill="currentColor"/></svg>',
    '</div>',
    '<div class="oct-text">',
    '  <div class="oct-title">AI Concierge</div>',
    '  <div class="oct-state" id="octState">Starter op</div>',
    '</div>'
  ].join("");

  var micBtn = document.createElement("button");
  micBtn.className = "oct-mic";
  micBtn.textContent = "\uD83C\uDFA4";
  micBtn.setAttribute("aria-label", "Microphone toggle");

  // Mic button + overlay removed — agent icon at bottom is the primary UI
  // micBtn kept as detached element so mute/unmute logic still works internally

  var stateEl = badge.querySelector(".oct-state");

  /* ── Agent icon circle + transcript panel ── */
  var agentIconEl = document.createElement("div");
  agentIconEl.className = "oct-agent-icon";
  agentIconEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 18.5C5 16.567 6.567 15 8.5 15h7C17.433 15 19 16.567 19 18.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="12" cy="9" r="3.5" stroke="currentColor" stroke-width="1.7"/></svg><div class="oct-waves"><div class="oct-wave"></div><div class="oct-wave"></div><div class="oct-wave"></div></div>';

  var transcriptPanel = document.createElement("div");
  transcriptPanel.className = "oct-transcript";
  var transcriptMessages = [];
  var transcriptOpen = false;

  agentIconEl.onclick = function () {
    transcriptOpen = !transcriptOpen;
    transcriptPanel.classList.toggle("open", transcriptOpen);
  };

  function addTranscriptMsg(role, text) {
    transcriptMessages.push({ role: role, text: text });
    if (transcriptMessages.length > 5) transcriptMessages.shift();
    renderTranscript();
  }

  function renderTranscript() {
    transcriptPanel.innerHTML = "";
    transcriptMessages.forEach(function (m) {
      var div = document.createElement("div");
      div.className = "oct-transcript-msg " + m.role;
      div.textContent = m.text.length > 120 ? m.text.slice(0, 120) + "..." : m.text;
      transcriptPanel.appendChild(div);
    });
    transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
  }

  if (!isVoiceOnly && wrap) {
    wrap.appendChild(agentIconEl);
    wrap.appendChild(transcriptPanel);
  } else if (isVoiceOnly) {
    agentIconEl.style.position = "fixed";
    agentIconEl.style.bottom = "24px";
    agentIconEl.style.left = "50%";
    transcriptPanel.style.position = "fixed";
    document.body.appendChild(agentIconEl);
    document.body.appendChild(transcriptPanel);
  }

  /* ── State ── */
  var ws = null;
  var audioContext = null;
  var micStream = null;
  var workletNode = null;
  var workletRegistered = false;
  var agentStatus = "idle"; // idle | thinking | speaking | user_speaking
  var nextPlayTime = 0;
  var currentSources = [];
  var playbackGain = null;
  var isMicMuted = false;
  var hasWsConnected = false;
  var hasWelcomePlayed = false;
  var wsReconnectCount = 0;
  var wsReconnectMax = 10;
  var config = {};
  var isRecoveringAudio = false;
  var vadSuppressed = false;         // True while agent is speaking — suppress VAD
  var vadSuppressTimer = null;       // Timer for 600ms cooldown after speaking ends

  /* ── Trial / paywall state ── */
  var freeSecondsLimit = 600;       // 10 minutes
  var trialActive = true;
  var trialStarted = false;
  var trialSecondsUsed = 0;
  var trialInterval = null;
  var trialStorageKey = "october_trial_used_" + TENANT_ID;
  var activatedStorageKey = "october_activated_" + TENANT_ID;
  var paywallShown = false;

  // Restore trial state from localStorage
  var storedSeconds = parseInt(localStorage.getItem(trialStorageKey) || "0");
  if (storedSeconds > 0) trialSecondsUsed = storedSeconds;
  if (localStorage.getItem(activatedStorageKey) === "true") trialActive = false;

  function setState(text) { stateEl.textContent = text; }

  /* ── Toast notification ── */
  var toastEl = null;
  var toastTimer = null;
  var toastShown = false; // Only show once per session
  function showToast(msg) {
    if (toastShown) return;
    toastShown = true;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "oct-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("visible");
    }, 8000);
  }

  /* ── Reload popup (audio failure) ── */
  var reloadPopupShown = false;
  function showReloadPopup() {
    if (reloadPopupShown) return;
    reloadPopupShown = true;

    // Stop everything gracefully
    try { stopAllAudio(); } catch (e) {}
    if (ws) { try { ws.close(); } catch (e) {} }

    var parentEl = isVoiceOnly ? document.body : wrap;
    var bg = document.createElement("div");
    bg.className = "oct-reload-bg";
    if (isVoiceOnly) {
      bg.style.position = "fixed";
      bg.style.zIndex = "100001";
    }
    bg.innerHTML = [
      '<div class="oct-reload">',
      '  <div class="oct-reload-icon">',
      '    <svg viewBox="0 0 24 24" fill="none"><path d="M12 9v4m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      '  </div>',
      '  <h3>Audio disconnected</h3>',
      '  <p>The audio connection was lost. Please reload to continue the conversation.</p>',
      '  <button class="oct-reload-btn">Reload</button>',
      '</div>'
    ].join("");
    parentEl.appendChild(bg);

    bg.querySelector(".oct-reload-btn").onclick = function () {
      window.location.reload();
    };
  }

  var unclearPopupShown = false;
  function showUnclearAudioPopup() {
    if (unclearPopupShown || reloadPopupShown) return;
    unclearPopupShown = true;

    var parentEl = isVoiceOnly ? document.body : wrap;
    var bg = document.createElement("div");
    bg.className = "oct-reload-bg";
    if (isVoiceOnly) {
      bg.style.position = "fixed";
      bg.style.zIndex = "100001";
    }
    bg.innerHTML = [
      '<div class="oct-reload">',
      '  <div class="oct-reload-icon">',
      '    <svg viewBox="0 0 24 24" fill="none"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      '  </div>',
      '  <h3>We\u2019re having trouble hearing you</h3>',
      '  <p>Try speaking a bit more clearly and closer to your microphone. If that doesn\u2019t help, reloading the page often fixes it.</p>',
      '  <button class="oct-reload-btn">Try again</button>',
      '  <button class="oct-reload-btn-secondary">Reload page</button>',
      '</div>'
    ].join("");
    parentEl.appendChild(bg);

    bg.querySelector(".oct-reload-btn").onclick = function () {
      try { bg.remove(); } catch (e) {}
      unclearPopupShown = false;
    };
    bg.querySelector(".oct-reload-btn-secondary").onclick = function () {
      window.location.reload();
    };
  }

  /* ── Mic inactivity detection ── */
  var lastMicActivityAt = Date.now();
  var micInactivityTimer = null;
  function resetMicActivity() {
    lastMicActivityAt = Date.now();
  }
  function startMicInactivityCheck() {
    if (micInactivityTimer) clearTimeout(micInactivityTimer);
    micInactivityTimer = setInterval(function () {
      if (!hasWsConnected || isMicMuted) return;
      if (agentStatus === "speaking" || agentStatus === "thinking") {
        resetMicActivity(); // Don't count agent activity as mic inactivity
        return;
      }
      if (Date.now() - lastMicActivityAt > 60000) {
        showToast("Having trouble hearing you \u2014 try refreshing the page");
        clearInterval(micInactivityTimer);
        micInactivityTimer = null;
      }
    }, 5000);
  }

  function refreshUI() {
    badge.classList.toggle("speaking", agentStatus === "speaking");
    micBtn.classList.toggle("muted", isMicMuted);
    micBtn.textContent = isMicMuted ? "\uD83D\uDD07" : "\uD83C\uDFA4";
    // Update agent icon states
    agentIconEl.classList.remove("speaking", "thinking", "user_speaking");
    if (agentStatus === "speaking") agentIconEl.classList.add("speaking");
    else if (agentStatus === "thinking") agentIconEl.classList.add("thinking");
    else if (agentStatus === "user_speaking") agentIconEl.classList.add("user_speaking");

    if (agentStatus === "speaking") { setState("Speaking"); return; }
    if (agentStatus === "thinking") { setState("Thinking..."); return; }
    if (!hasWsConnected) { setState("Connecting..."); return; }
    if (isMicMuted) { setState("Microphone muted"); return; }
    setState("Listening");
  }

  /* ── AudioContext management ── */
  var audioRecoveryAttempts = 0;
  var audioRecoveryMax = 3;

  function ensureAudioContext() {
    if (!audioContext || audioContext.state === "closed") {
      // If context was closed unexpectedly (not first init), it means audio broke
      if (audioContext && audioContext.state === "closed") {
        audioRecoveryAttempts++;
        if (audioRecoveryAttempts >= audioRecoveryMax) {
          showReloadPopup();
          // Still create new context so we return something valid
        }
      }
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      audioContext.onstatechange = function () {
        if (!audioContext) return;
        if (audioContext.state === "closed") {
          // Audio context was destroyed — likely new session loaded
          console.warn("October AI: AudioContext closed unexpectedly");
          showReloadPopup();
          return;
        }
        if (audioContext.state === "interrupted") {
          isRecoveringAudio = true;
          stopAllAudio();
          audioContext.resume().then(function () {
            if (audioContext.state === "running") {
              isRecoveringAudio = false;
              audioRecoveryAttempts = 0;
              rebuildAudioPipeline();
            }
          }).catch(function () {
            audioRecoveryAttempts++;
            if (audioRecoveryAttempts >= audioRecoveryMax) {
              showReloadPopup();
            }
          });
        } else if (audioContext.state === "suspended") {
          audioContext.resume().catch(function () {});
        } else if (audioContext.state === "running" && isRecoveringAudio) {
          isRecoveringAudio = false;
          audioRecoveryAttempts = 0;
          rebuildAudioPipeline();
        }
      };
    }
    return audioContext;
  }

  function getPlaybackGain() {
    var ctx = ensureAudioContext();
    if (!playbackGain || playbackGain.context !== ctx) {
      playbackGain = ctx.createGain();
      playbackGain.connect(ctx.destination);
    }
    return playbackGain;
  }

  /* ── PCM16 Playback (gapless) ── */
  var playbackFailures = 0;
  function playPCM16Chunk(pcm16Buffer) {
    try {
    var ctx = ensureAudioContext();
    if (ctx.state !== "running") { try { ctx.resume(); } catch (e) {} }

    var int16 = new Int16Array(pcm16Buffer);
    var float32 = new Float32Array(int16.length);
    for (var i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    var audioBuffer = ctx.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    var source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(getPlaybackGain());

    var now = ctx.currentTime;
    var startTime = (nextPlayTime > now) ? nextPlayTime : now;
    source.start(startTime);
    nextPlayTime = startTime + audioBuffer.duration;

    currentSources.push(source);
    source.onended = function () {
      var idx = currentSources.indexOf(source);
      if (idx !== -1) currentSources.splice(idx, 1);
    };
    playbackFailures = 0; // Reset on success
    } catch (e) {
      playbackFailures++;
      console.warn("October AI: Playback error (" + playbackFailures + "):", e.message);
      if (playbackFailures >= 3) {
        showReloadPopup();
      }
    }
  }

  function stopAllAudio() {
    clearPlaybackBuffer();
    agentStatus = "idle";
    refreshUI();
  }

  /** Stop scheduled audio sources and reset playback position (no UI change). */
  function clearPlaybackBuffer() {
    if (playbackGain) {
      try { playbackGain.disconnect(); } catch (e) {}
      playbackGain = null;
    }
    currentSources.forEach(function (s) { try { s.stop(); } catch (e) {} });
    currentSources = [];
    nextPlayTime = audioContext ? audioContext.currentTime : 0;
  }

  /* ── VAD AudioWorklet ── */
  var VAD_WORKLET_CODE = [
    "class VADProcessor extends AudioWorkletProcessor {",
    "  constructor() {",
    "    super();",
    "    this.state = 'IDLE';",
    "    this.speechFrameCount = 0;",
    "    this.silenceFrameCount = 0;",
    "    this.speechBuffer = [];",
    "    this.preRoll = [];",
    "    this.totalSpeechFrames = 0;",
    "    this.threshold = " + VAD_SPEECH_THRESHOLD + ";",
    "    this.silenceToStop = Math.ceil(" + VAD_SILENCE_MS + " / (128 / sampleRate * 1000));",
    "    this.speechToStart = " + VAD_SPEECH_FRAMES_TO_START + ";",
    "    this.preRollMax = " + VAD_PRE_ROLL_FRAMES + ";",
    "    this.minSpeechFrames = " + VAD_MIN_SPEECH_FRAMES + ";",
    "    this.port.onmessage = (e) => {",
    "      if (e.data.type === 'setThreshold') this.threshold = e.data.value;",
    "      if (e.data.type === 'reset') { this.state = 'IDLE'; this.speechBuffer = []; this.preRoll = []; this.speechFrameCount = 0; this.silenceFrameCount = 0; this.totalSpeechFrames = 0; }",
    "    };",
    "  }",
    "  process(inputs) {",
    "    var input = inputs[0];",
    "    if (!input || !input[0]) return true;",
    "    var samples = input[0];",
    "",
    "    // Resample to 24kHz",
    "    var ratio = sampleRate / 24000;",
    "    var outLen = Math.floor(samples.length / ratio);",
    "    var resampled = new Float32Array(outLen);",
    "    for (var i = 0; i < outLen; i++) {",
    "      var idx = Math.floor(i * ratio);",
    "      resampled[i] = samples[idx];",
    "    }",
    "",
    "    // Calculate RMS",
    "    var sum = 0;",
    "    for (var j = 0; j < resampled.length; j++) sum += resampled[j] * resampled[j];",
    "    var rms = Math.sqrt(sum / resampled.length);",
    "    var isSpeech = rms > this.threshold;",
    "",
    "    if (this.state === 'IDLE') {",
    "      this.preRoll.push(resampled);",
    "      if (this.preRoll.length > this.preRollMax) this.preRoll.shift();",
    "      if (isSpeech) {",
    "        this.speechFrameCount++;",
    "        if (this.speechFrameCount >= this.speechToStart) {",
    "          this.state = 'SPEAKING';",
    "          this.speechBuffer = this.preRoll.slice();",
    "          this.preRoll = [];",
    "          this.totalSpeechFrames = this.speechFrameCount;",
    "          this.silenceFrameCount = 0;",
    "          this.port.postMessage({ type: 'speech_start' });",
    "        }",
    "      } else {",
    "        this.speechFrameCount = 0;",
    "      }",
    "    } else if (this.state === 'SPEAKING') {",
    "      this.speechBuffer.push(resampled);",
    "      this.totalSpeechFrames++;",
    "      if (isSpeech) {",
    "        this.silenceFrameCount = 0;",
    "      } else {",
    "        this.silenceFrameCount++;",
    "        if (this.silenceFrameCount >= this.silenceToStop) {",
    "          if (this.totalSpeechFrames >= this.minSpeechFrames) {",
    "            var totalLen = 0;",
    "            for (var k = 0; k < this.speechBuffer.length; k++) totalLen += this.speechBuffer[k].length;",
    "            var combined = new Float32Array(totalLen);",
    "            var offset = 0;",
    "            for (var m = 0; m < this.speechBuffer.length; m++) {",
    "              combined.set(this.speechBuffer[m], offset);",
    "              offset += this.speechBuffer[m].length;",
    "            }",
    "            this.port.postMessage({ type: 'speech_end', audio: combined }, [combined.buffer]);",
    "          }",
    "          this.state = 'IDLE';",
    "          this.speechBuffer = [];",
    "          this.preRoll = [];",
    "          this.speechFrameCount = 0;",
    "          this.silenceFrameCount = 0;",
    "          this.totalSpeechFrames = 0;",
    "        }",
    "      }",
    "    }",
    "    return true;",
    "  }",
    "}",
    'registerProcessor("vad-processor", VADProcessor);'
  ].join("\n");

  /* ── Microphone + VAD setup ── */
  async function initMicrophone() {
    try {
      if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
      if (workletNode) { try { workletNode.disconnect(); } catch (e) {} workletNode = null; }

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });

      var track = micStream.getAudioTracks()[0];
      if (track) {
        track.onended = function () { recoverMicrophone(); };
        track.onmute = function () { setState("Microphone interrupted"); };
        track.onunmute = function () { refreshUI(); };
      }

      isMicMuted = false;
      var ctx = ensureAudioContext();
      if (ctx.state !== "running") await ctx.resume();

      await setupVADWorklet(micStream);
    } catch (e) {
      console.warn("October AI: Microphone not available:", e.name);
      isMicMuted = true;
      try { ensureAudioContext(); audioContext.resume(); } catch (err) {}
      if (e.name === "NotAllowedError" || e.name === "PermissionDeniedError") {
        showMicPermissionPopup();
      }
    }
  }

  var micPermissionPopupShown = false;
  function showMicPermissionPopup() {
    if (micPermissionPopupShown || reloadPopupShown) return;
    micPermissionPopupShown = true;

    var parentEl = isVoiceOnly ? document.body : wrap;
    var bg = document.createElement("div");
    bg.className = "oct-reload-bg";
    if (isVoiceOnly) {
      bg.style.position = "fixed";
      bg.style.zIndex = "100001";
    }
    bg.innerHTML = [
      '<div class="oct-reload">',
      '  <div class="oct-reload-icon">',
      '    <svg viewBox="0 0 24 24" fill="none"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      '  </div>',
      '  <h3>Microphone access needed</h3>',
      '  <p>Microphone access is needed to talk with the agent. Please allow microphone access in your browser settings and refresh the page.</p>',
      '  <button class="oct-reload-btn">Reload page</button>',
      '</div>'
    ].join("");
    parentEl.appendChild(bg);

    bg.querySelector(".oct-reload-btn").onclick = function () {
      window.location.reload();
    };
  }

  async function setupVADWorklet(stream) {
    var ctx = ensureAudioContext();

    if (!workletRegistered) {
      var blob = new Blob([VAD_WORKLET_CODE], { type: "application/javascript" });
      var url = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(url);
        workletRegistered = true;
      } catch (e) {
        if (e.message && e.message.includes("already")) {
          workletRegistered = true;
        } else {
          console.warn("October AI: AudioWorklet not supported");
          URL.revokeObjectURL(url);
          return;
        }
      }
      URL.revokeObjectURL(url);
    }

    var source = ctx.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(ctx, "vad-processor");

    workletNode.port.onmessage = function (e) {
      if (isMicMuted) return;
      // Suppress VAD while agent is speaking or during cooldown (echo suppression)
      if (vadSuppressed) return;

      if (e.data.type === "speech_start") {
        resetMicActivity();
        // Interrupt agent if speaking
        if (agentStatus === "speaking") {
          stopAllAudio();
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "interrupt" }));
          }
        }
        agentStatus = "user_speaking";
        refreshUI();
      }

      if (e.data.type === "speech_end") {
        agentStatus = "idle";
        refreshUI();

        // Start trial timer on first user speech
        if (!trialStarted && trialActive) startTrialTimer();

        // Convert Float32 → PCM16 Int16Array → send binary
        var float32 = e.data.audio;
        var pcm16 = new Int16Array(float32.length);
        for (var i = 0; i < float32.length; i++) {
          var s = Math.max(-1, Math.min(1, float32[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(pcm16.buffer);
        }
      }
    };

    source.connect(workletNode);
    // Silent destination to keep worklet alive
    var gain = ctx.createGain();
    gain.gain.value = 0;
    workletNode.connect(gain);
    gain.connect(ctx.destination);
  }

  async function rebuildAudioPipeline() {
    try {
      if (workletNode) { try { workletNode.disconnect(); } catch (e) {} workletNode = null; }
      if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });

      var track = micStream.getAudioTracks()[0];
      if (track) {
        track.onended = function () { recoverMicrophone(); };
      }

      await setupVADWorklet(micStream);
      isMicMuted = false;
      micRecoveryAttempts = 0;
      refreshUI();
    } catch (e) {
      recoverMicrophone();
    }
  }

  var micRecoveryAttempts = 0;
  var micRecoveryMax = 3;

  async function recoverMicrophone() {
    if (micRecoveryAttempts >= micRecoveryMax) {
      showReloadPopup();
      return;
    }
    micRecoveryAttempts++;
    setState("Recovering microphone... (" + micRecoveryAttempts + ")");
    await new Promise(function (r) { setTimeout(r, Math.min(1000 * micRecoveryAttempts, 5000)); });
    try {
      await initMicrophone();
      refreshUI();
    } catch (e) { recoverMicrophone(); }
  }

  /* ── Room mappings ── */
  var ROOM_SWEEPS = {};
  var ROOM_LABELS = {};
  var SWEEP_TO_PLACE = {};

  function loadRoomMappings(roomMappings) {
    if (!roomMappings) return;
    Object.keys(roomMappings).forEach(function (key) {
      var entry = roomMappings[key];
      if (typeof entry === "object") {
        if (entry.sweepId) ROOM_SWEEPS[key] = entry.sweepId;
        ROOM_LABELS[key] = entry.label || key;
      } else if (typeof entry === "string") {
        ROOM_LABELS[key] = entry;
      }
    });
    SWEEP_TO_PLACE = {};
    Object.keys(ROOM_SWEEPS).forEach(function (key) {
      SWEEP_TO_PLACE[ROOM_SWEEPS[key]] = key;
    });
  }

  /* ── Matterport navigation (delegated to controller) ── */
  function navigateToSweep(sweepId) {
    if (matterportCtrl) { matterportCtrl.navigateToSweep(sweepId); }
  }

  /* ── Position tracking via MatterportController ── */
  // Sweep change listening is set up in boot() after controller is instantiated

  /* ── Visibility + device change recovery ── */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      if (audioContext && (audioContext.state === "suspended" || audioContext.state === "interrupted")) {
        audioContext.resume().catch(function () {});
      }
      if (micStream) {
        var track = micStream.getAudioTracks()[0];
        if (!track || track.readyState === "ended") recoverMicrophone();
      }
    }
  });

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    var deviceChangeDebounce = null;
    navigator.mediaDevices.addEventListener("devicechange", function () {
      if (deviceChangeDebounce) clearTimeout(deviceChangeDebounce);
      deviceChangeDebounce = setTimeout(function () {
        deviceChangeDebounce = null;
        if (micStream) {
          var track = micStream.getAudioTracks()[0];
          if (!track || track.readyState === "ended") { recoverMicrophone(); return; }
        }
        rebuildAudioPipeline();
      }, 500);
    });
  }

  /* Unlock AudioContext on user gesture */
  function handleUserGesture() {
    if (audioContext && audioContext.state !== "running") {
      audioContext.resume().catch(function () {});
    }
  }
  document.addEventListener("click", handleUserGesture);
  document.addEventListener("touchstart", handleUserGesture);

  /* ── Conversion overlay (booking button) ── */
  var convOverlayEl = null;
  function showConversionOverlay(url, message) {
    if (convOverlayEl) { try { convOverlayEl.remove(); } catch (e) {} }
    var overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;bottom:70px;right:14px;z-index:40;background:rgba(28,28,28,.94);border:1px solid rgba(225,196,134,.3);border-radius:16px;padding:20px;min-width:240px;max-width:300px;backdrop-filter:blur(14px);color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center";
    if (isVoiceOnly) overlay.style.cssText = overlay.style.cssText.replace("position:absolute", "position:fixed");

    var msgEl = document.createElement("div");
    msgEl.style.cssText = "font-size:14px;margin-bottom:14px;line-height:1.4";
    msgEl.textContent = message;
    overlay.appendChild(msgEl);

    var btn = document.createElement("a");
    btn.href = url;
    btn.target = "_blank";
    btn.rel = "noopener";
    btn.textContent = "Go to booking";
    btn.style.cssText = "display:inline-block;padding:10px 24px;border:none;border-radius:10px;background:linear-gradient(135deg,#e1c486,#c99a45);color:#1a1611;font-weight:700;font-size:14px;text-decoration:none;cursor:pointer";
    overlay.appendChild(btn);

    var dismiss = document.createElement("div");
    dismiss.textContent = "Maybe later";
    dismiss.style.cssText = "margin-top:10px;font-size:12px;color:rgba(255,255,255,.5);cursor:pointer";
    dismiss.onclick = function () { overlay.remove(); convOverlayEl = null; };
    overlay.appendChild(dismiss);

    if (isVoiceOnly) { document.body.appendChild(overlay); } else if (wrap) { wrap.appendChild(overlay); }
    convOverlayEl = overlay;
  }

  /* ── Info collection form ── */
  var infoFormEl = null;
  function showInfoForm(fields, reason) {
    if (infoFormEl) { try { infoFormEl.remove(); } catch (e) {} }
    var formWrap = document.createElement("div");
    formWrap.style.cssText = "position:absolute;bottom:70px;right:14px;z-index:40;background:rgba(28,28,28,.92);border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:20px;min-width:260px;max-width:320px;backdrop-filter:blur(14px);color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px";
    if (isVoiceOnly) formWrap.style.cssText = formWrap.style.cssText.replace("position:absolute", "position:fixed");

    var title = document.createElement("div");
    title.style.cssText = "font-weight:600;font-size:14px;margin-bottom:4px";
    title.textContent = "A few details";
    formWrap.appendChild(title);
    if (reason) {
      var sub = document.createElement("div");
      sub.style.cssText = "color:rgba(255,255,255,.6);font-size:12px;margin-bottom:12px";
      sub.textContent = reason;
      formWrap.appendChild(sub);
    }

    var labels = { name: "Name", email: "Email", phone: "Phone", date: "Date", party_size: "Group size" };
    var types = { name: "text", email: "email", phone: "tel", date: "date", party_size: "number" };
    var inputs = {};
    fields.forEach(function (f) {
      var label = document.createElement("label");
      label.style.cssText = "display:block;margin-bottom:8px;font-size:12px;color:rgba(255,255,255,.7)";
      label.textContent = labels[f] || f;
      var input = document.createElement("input");
      input.type = types[f] || "text";
      input.placeholder = labels[f] || f;
      input.style.cssText = "display:block;width:100%;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-size:13px;outline:none;box-sizing:border-box;margin-top:4px";
      label.appendChild(input);
      formWrap.appendChild(label);
      inputs[f] = input;
    });

    var btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:12px";
    var submitBtn = document.createElement("button");
    submitBtn.textContent = "Submit";
    submitBtn.style.cssText = "flex:1;padding:8px;border:none;border-radius:8px;background:#e1c486;color:#1a1611;font-weight:600;font-size:13px;cursor:pointer";
    submitBtn.onclick = function () {
      var data = {};
      Object.keys(inputs).forEach(function (k) { if (inputs[k].value.trim()) data[k] = inputs[k].value.trim(); });
      if (Object.keys(data).length > 0 && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "user_info", data: data }));
      }
      formWrap.remove();
      infoFormEl = null;
    };
    var cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Skip";
    cancelBtn.style.cssText = "padding:8px 12px;border:1px solid rgba(255,255,255,.2);border-radius:8px;background:transparent;color:rgba(255,255,255,.7);font-size:13px;cursor:pointer";
    cancelBtn.onclick = function () { formWrap.remove(); infoFormEl = null; };
    btnRow.appendChild(submitBtn);
    btnRow.appendChild(cancelBtn);
    formWrap.appendChild(btnRow);
    if (isVoiceOnly) { document.body.appendChild(formWrap); } else if (wrap) { wrap.appendChild(formWrap); }
    infoFormEl = formWrap;
    var firstInput = formWrap.querySelector("input");
    if (firstInput) setTimeout(function () { firstInput.focus(); }, 100);
  }

  /* ── WebSocket ── */
  function connectWS() {
    var proto = SERVER.indexOf("https") === 0 ? "wss:" : "ws:";
    var host = SERVER.replace(/^https?:\/\//, "");
    var wsUrl = proto + "//" + host + "/ws/voice";
    if (config.voiceToken) wsUrl += "?token=" + encodeURIComponent(config.voiceToken);
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      hasWsConnected = true;
      wsReconnectCount = 0;
      nextPlayTime = 0;
      refreshUI();

      ws.send(JSON.stringify({
        type: "session_init",
        tenantId: TENANT_ID,
        token: config.voiceToken || null,
        skipWelcome: hasWelcomePlayed
      }));
      hasWelcomePlayed = true;
    };

    ws.onmessage = function (event) {
      if (event.data instanceof ArrayBuffer) {
        // PCM16 audio from server — mute mic IMMEDIATELY on first audio byte
        if (!vadSuppressed) {
          vadSuppressed = true;
          if (vadSuppressTimer) { clearTimeout(vadSuppressTimer); vadSuppressTimer = null; }
          if (micStream) { micStream.getAudioTracks().forEach(function (t) { t.enabled = false; }); }
          if (workletNode) { workletNode.port.postMessage({ type: "reset" }); }
        }
        agentStatus = "speaking";
        refreshUI();
        playPCM16Chunk(event.data);
        return;
      }

      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }

      if (msg.type === "status") {
        if (msg.value === "thinking") {
          // New turn starting — stop any stale audio still playing from previous stream
          clearPlaybackBuffer();
          agentStatus = "thinking";
          // Also suppress during thinking — prevents echo from tail of previous audio
          vadSuppressed = true;
          if (vadSuppressTimer) { clearTimeout(vadSuppressTimer); vadSuppressTimer = null; }
          if (micStream) { micStream.getAudioTracks().forEach(function (t) { t.enabled = false; }); }
          if (workletNode) { workletNode.port.postMessage({ type: "reset" }); }
          refreshUI();
        }
        if (msg.value === "speaking") {
          // New TTS stream starting — stop any stale audio still playing from previous stream
          clearPlaybackBuffer();
          agentStatus = "speaking";
          vadSuppressed = true;
          if (vadSuppressTimer) { clearTimeout(vadSuppressTimer); vadSuppressTimer = null; }
          if (micStream) { micStream.getAudioTracks().forEach(function (t) { t.enabled = false; }); }
          if (workletNode) { workletNode.port.postMessage({ type: "reset" }); }
          refreshUI();
        }
        if (msg.value === "idle") {
          agentStatus = "idle";
          nextPlayTime = audioContext ? audioContext.currentTime : 0;
          // Keep mic muted for 1200ms after speaking ends (room reverb + echo tail)
          if (vadSuppressTimer) clearTimeout(vadSuppressTimer);
          vadSuppressTimer = setTimeout(function () {
            vadSuppressed = false;
            vadSuppressTimer = null;
            // Reset VAD BEFORE unmuting so pre-roll buffer is clean
            if (workletNode) { workletNode.port.postMessage({ type: "reset" }); }
            if (micStream && !isMicMuted) { micStream.getAudioTracks().forEach(function (t) { t.enabled = true; }); }
          }, 1200);
          refreshUI();
        }
        if (msg.value === "connected") {
          agentStatus = "idle";
          nextPlayTime = audioContext ? audioContext.currentTime : 0;
          // On initial connect: suppress mic until greeting finishes
          vadSuppressed = true;
          if (micStream) { micStream.getAudioTracks().forEach(function (t) { t.enabled = false; }); }
          if (workletNode) { workletNode.port.postMessage({ type: "reset" }); }
          refreshUI();
        }
      }

      if (msg.type === "navigate") {
        var sweepId = ROOM_SWEEPS[msg.roomId];
        if (sweepId) { navigateToSweep(sweepId); }
      }

      if (msg.type === "conversion") {
        var convUrl = msg.url || config.bookingUrl;
        if (convUrl) {
          window.open(convUrl, "_blank");
        }
      }

      if (msg.type === "set_view_mode") {
        if (matterportCtrl) {
          matterportCtrl.setViewMode(msg.mode);
          // Update view mode buttons if present
          if (viewModeEl) {
            viewModeEl.querySelectorAll(".oct-viewmode-btn").forEach(function (b) {
              b.classList.toggle("active", b.getAttribute("data-mode") === msg.mode);
            });
          }
        }
      }

      if (msg.type === "enable_measurements") {
        if (matterportCtrl) { matterportCtrl.enableMeasurements(); }
      }

      if (msg.type === "toggle_defurnish") {
        if (matterportCtrl) { matterportCtrl.toggleDefurnish(msg.enabled); }
      }

      if (msg.type === "collect_info") {
        showInfoForm(msg.fields || [], msg.reason || "");
      }

      if (msg.type === "transcript") {
        console.log("October AI [" + msg.role + "]: " + msg.text);
        addTranscriptMsg(msg.role, msg.text);
      }

      if (msg.type === "quota_exceeded") {
        setState("Minutes limit reached");
      }

      if (msg.type === "idle_timeout") {
        setState("Session ended");
      }

      if (msg.type === "error") {
        console.error("October AI:", msg.message);
        setState(msg.message || "Error");
      }

      if (msg.type === "unclear_audio") {
        showUnclearAudioPopup();
      }
    };

    ws.onclose = function () {
      hasWsConnected = false;
      refreshUI();
      if (wsReconnectCount < wsReconnectMax) {
        wsReconnectCount++;
        var delay = Math.min(1000 * Math.pow(2, wsReconnectCount - 1), 30000);
        setTimeout(connectWS, delay);
      } else {
        setState("Connection lost");
        showReloadPopup();
      }
    };

    ws.onerror = function () { setState("Connection error"); };
  }

  /* ── Mic button ── */
  micBtn.onclick = function () {
    if (!micStream) return;
    if (agentStatus === "speaking") {
      stopAllAudio();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "interrupt" }));
      }
      return;
    }
    isMicMuted = !isMicMuted;
    micStream.getAudioTracks().forEach(function (t) { t.enabled = !isMicMuted; });
    // Reset VAD state when unmuting
    if (!isMicMuted && workletNode) {
      workletNode.port.postMessage({ type: "reset" });
    }
    refreshUI();
  };

  /* ── Trial timer ── */
  function startTrialTimer() {
    if (trialInterval || !trialActive) return;
    trialStarted = true;
    trialInterval = setInterval(function () {
      if (!trialActive || paywallShown) return;
      trialSecondsUsed++;
      localStorage.setItem(trialStorageKey, trialSecondsUsed.toString());
      updateTrialPill();
      if (trialSecondsUsed >= freeSecondsLimit) {
        triggerPaywall();
      }
    }, 1000);
  }

  function triggerPaywall() {
    if (paywallShown) return;
    paywallShown = true;
    trialActive = false;
    if (trialInterval) { clearInterval(trialInterval); trialInterval = null; }
    // Stop all audio immediately
    stopAllAudio();
    // Close websocket
    if (ws) { try { ws.close(); } catch (e) {} }
    // Hide trial pill
    if (trialPillEl) trialPillEl.style.display = "none";
    showPaywallOverlay();
  }

  /* ── Trial status pill ── */
  var trialPillEl = null;
  function createTrialPill() {
    if (trialPillEl) return;
    trialPillEl = document.createElement("div");
    trialPillEl.className = "oct-trial-pill";
    if (!isVoiceOnly && wrap) {
      wrap.appendChild(trialPillEl);
    } else if (isVoiceOnly) {
      trialPillEl.style.position = "fixed";
      trialPillEl.style.top = "14px";
      trialPillEl.style.left = "14px";
      document.body.appendChild(trialPillEl);
    }
    updateTrialPill();
  }

  function updateTrialPill() {
    if (!trialPillEl || !trialActive) return;
    var left = Math.max(0, freeSecondsLimit - trialSecondsUsed);
    var minLeft = Math.floor(left / 60);
    var secLeft = left % 60;
    var label = "Free preview \u00b7 " + minLeft + ":" + (secLeft < 10 ? "0" : "") + secLeft + " left";
    trialPillEl.textContent = label;
    // Color coding
    trialPillEl.classList.remove("amber", "red");
    if (left <= 30) trialPillEl.classList.add("red");
    else if (left <= 60) trialPillEl.classList.add("amber");
  }

  /* ── Paywall overlay ── */
  function showPaywallOverlay() {
    var agName = config.agentName || config.propertyName || "this agent";
    var bg = document.createElement("div");
    bg.className = "oct-paywall-bg";
    bg.innerHTML = '<div class="oct-paywall">' +
      '<div class="oct-paywall-check"><svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>' +
      '<h2>You\u2019ve seen what ' + escHtml(agName) + ' can do</h2>' +
      '<div class="pw-sub">Give your visitors this experience 24/7 \u2014 guided conversations, instant answers, and direct paths to booking.</div>' +
      '<div class="pw-bullets">' +
        '<div class="pw-bullet"><svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Available around the clock</div>' +
        '<div class="pw-bullet"><svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Navigates visitors through your space</div>' +
        '<div class="pw-bullet"><svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Guides them towards taking action</div>' +
      '</div>' +
      '<button class="pw-cta" id="octPaywallCta">Activate for $149 / month</button>' +
      '<div class="pw-fine">Includes 1,000 minutes per month \u00b7 Cancel anytime</div>' +
      '<a class="pw-link" href="mailto:hello@october-ai.com">Questions? Contact us \u2192</a>' +
    '</div>';

    if (!isVoiceOnly && wrap) { wrap.appendChild(bg); } else { document.body.appendChild(bg); }

    bg.querySelector("#octPaywallCta").onclick = function () {
      this.textContent = "Redirecting...";
      this.style.opacity = "0.7";
      fetch(SERVER + "/api/tour/" + TENANT_ID + "/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.checkoutUrl) {
          localStorage.setItem(activatedStorageKey, "true");
          window.open(d.checkoutUrl, "_blank");
        }
      }).catch(function () {
        bg.querySelector("#octPaywallCta").textContent = "Activate for $149 / month";
        bg.querySelector("#octPaywallCta").style.opacity = "1";
      });
    };
  }

  function escHtml(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  /* ── Demo questions panel ── */
  var demoBtn = null;
  var demoPanel = null;

  function createDemoPanel(questions) {
    if (!questions || questions.length === 0) return;
    // "?" button
    demoBtn = document.createElement("button");
    demoBtn.className = "oct-demo-btn";
    demoBtn.textContent = "?";
    demoBtn.setAttribute("aria-label", "Suggested questions");

    // Panel
    demoPanel = document.createElement("div");
    demoPanel.className = "oct-demo-panel";
    demoPanel.innerHTML = '<div class="oct-demo-title">Try asking\u2026</div>';
    questions.forEach(function (q) {
      var chip = document.createElement("button");
      chip.className = "oct-demo-chip";
      chip.textContent = q;
      chip.onclick = function () {
        navigator.clipboard.writeText(q).then(function () {
          chip.classList.add("copied");
          var orig = chip.textContent;
          chip.textContent = "Copied!";
          setTimeout(function () { chip.textContent = orig; chip.classList.remove("copied"); }, 1200);
        }).catch(function () {
          // Fallback: show as tooltip text
          chip.classList.add("copied");
          var orig = chip.textContent;
          chip.textContent = "\u2714 " + orig;
          setTimeout(function () { chip.textContent = orig; chip.classList.remove("copied"); }, 1200);
        });
      };
      demoPanel.appendChild(chip);
    });

    demoBtn.onclick = function () {
      demoPanel.classList.toggle("open");
    };

    if (!isVoiceOnly && wrap) {
      wrap.appendChild(demoPanel);
      wrap.appendChild(demoBtn);
    } else if (isVoiceOnly) {
      demoBtn.style.position = "fixed";
      demoBtn.style.bottom = "24px";
      demoBtn.style.right = "24px";
      demoPanel.style.position = "fixed";
      demoPanel.style.bottom = "70px";
      demoPanel.style.right = "24px";
      document.body.appendChild(demoPanel);
      document.body.appendChild(demoBtn);
    }
  }

  /* ── Boot ── */
  async function boot() {
    setState("Loading...");
    try {
      var res = await fetch(SERVER + "/api/tour/" + TENANT_ID + "/config");
      if (!res.ok) { setState("Tour not found"); return; }
      config = await res.json();
      if (!config.modelId) { setState("Invalid tour config"); return; }
      loadRoomMappings(config.roomMappings);
      // Apply agent branding
      if (config.agentName) {
        var titleEl = badge.querySelector(".oct-title");
        if (titleEl) titleEl.textContent = config.agentName;
      }
      if (config.agentIcon) {
        agentIconEl.innerHTML = '<img src="' + config.agentIcon + '" alt="Agent"><div class="oct-waves"><div class="oct-wave"></div><div class="oct-wave"></div><div class="oct-wave"></div></div>';
      }
      // Set Matterport iframe src immediately after config is loaded
      if (!isVoiceOnly && iframe && config.modelId) {
        iframe.src = "https://my.matterport.com/show/?m=" + config.modelId + "&play=1";
      }
    } catch (e) { setState("Connection error"); return; }

    // Check activation state — if already activated or plan active, skip trial
    if (config.planActive) {
      trialActive = false;
      localStorage.setItem(activatedStorageKey, "true");
    }

    // Check if activated via URL param (redirect from Stripe)
    if (window.location.search.indexOf("activated=true") !== -1) {
      trialActive = false;
      localStorage.setItem(activatedStorageKey, "true");
    }

    // Check if trial already expired from localStorage
    if (trialActive && trialSecondsUsed >= freeSecondsLimit) {
      trialActive = false;
    }

    // Create demo questions panel
    createDemoPanel(config.demoQuestions);

    // Create trial pill if trial is active
    if (trialActive) {
      createTrialPill();
    }

    // Instantiate MatterportController now that we have config
    if (!isVoiceOnly && iframe && config.modelId) {
      matterportCtrl = new MatterportController(iframe, { modelId: config.modelId, fadeEl: fadeEl });
      // Set up sweep change tracking
      matterportCtrl.onSweepChange(function (sweepId) {
        var place = SWEEP_TO_PLACE[sweepId];
        if (place && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "position_update", placeId: place, sweepId: sweepId }));
        }
      });
    }

    // View mode buttons — real estate verticals only
    var isRealEstateVertical = config.vertical === "real_estate_sale" || config.vertical === "real_estate_development";
    if (!isVoiceOnly && wrap && isRealEstateVertical) {
      viewModeEl = document.createElement("div");
      viewModeEl.className = "oct-viewmode";
      ["inside", "floorplan", "dollhouse"].forEach(function (mode) {
        var btn = document.createElement("button");
        btn.className = "oct-viewmode-btn" + (mode === "inside" ? " active" : "");
        btn.textContent = mode === "inside" ? "Inside" : mode === "floorplan" ? "Floor Plan" : "Overview";
        btn.setAttribute("data-mode", mode);
        btn.onclick = function () {
          if (matterportCtrl) { matterportCtrl.setViewMode(mode); }
          viewModeEl.querySelectorAll(".oct-viewmode-btn").forEach(function (b) { b.classList.remove("active"); });
          btn.classList.add("active");
        };
        viewModeEl.appendChild(btn);
      });
      wrap.appendChild(viewModeEl);

      // Sync buttons when mode changes programmatically (e.g. via GPT tool call)
      if (matterportCtrl) {
        matterportCtrl.onModeChange(function (newMode) {
          if (viewModeEl) {
            viewModeEl.querySelectorAll(".oct-viewmode-btn").forEach(function (b) {
              b.classList.toggle("active", b.getAttribute("data-mode") === newMode);
            });
          }
        });
      }
    }

    if (!isVoiceOnly && iframe && (config.vertical === "retail" || isRealEstateVertical)) {
      // Show loading overlay while Matterport loads (retail + real estate)
      var loadingOverlay = document.createElement("div");
      loadingOverlay.className = "oct-loading-overlay";
      var brandBg = config.brandColor || "#1a1a1a";
      loadingOverlay.style.background = brandBg;
      var agentLabel = config.agentName || config.propertyName || "";
      loadingOverlay.innerHTML = (agentLabel ? '<div class="oct-loading-name">' + agentLabel + '</div>' : '') +
        '<div class="oct-loading-dots"><span></span><span></span><span></span></div>' +
        '<div class="oct-loading-sub">Setting up your experience...</div>';
      wrap.appendChild(loadingOverlay);

      // Dismiss on Matterport PLAYING event or fallback timeout
      function dismissLoading() {
        if (loadingOverlay && !loadingOverlay.classList.contains("hidden")) {
          loadingOverlay.classList.add("hidden");
          setTimeout(function () { if (loadingOverlay.parentNode) loadingOverlay.parentNode.removeChild(loadingOverlay); }, 700);
        }
      }
      window.addEventListener("message", function onMpReady(event) {
        try {
          if (!event.data || typeof event.data !== "string") return;
          var msg = JSON.parse(event.data);
          if ((msg.type === "application.state" && msg.data === "webgl.playing") ||
              (msg.namespace === "showcase" && msg.type === "application.state")) {
            dismissLoading();
            window.removeEventListener("message", onMpReady);
          }
        } catch (e) {}
      });
      // Fallback: dismiss after 12 seconds max
      setTimeout(dismissLoading, 12000);
    }

    await initMicrophone();

    if (!trialActive && localStorage.getItem(activatedStorageKey) !== "true") {
      triggerPaywall();
      return;
    }

    connectWS();
    startMicInactivityCheck();
    refreshUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
