/* global fetch, document, setInterval, clearInterval */
(function () {
  "use strict";

  var POLL_INTERVAL = 2000;

  var STATE_LABELS = {
    starting: "Starting\u2026",
    bootstrap_installed: "Scan Wi\u2011Fi QR to begin",
    network_configured: "Wi\u2011Fi configured",
    identity_configured: "Station configured",
    cloud_configured: "Configuration complete",
    operational: "Operational",
  };

  var QR_LABELS = {
    wifi_config: "Wi\u2011Fi configuration QR",
    station_config: "Station configuration QR",
    cloud_config: "Cloud configuration QR",
  };

  function el(id) {
    return document.getElementById(id);
  }

  function stateClass(state) {
    return "state state-" + state.replace(/_/g, "-");
  }

  function escapeHtml(s) {
    if (!s) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderState(data) {
    var stateEl = el("state-label");
    stateEl.textContent = STATE_LABELS[data.commissioning_state] || data.commissioning_state;
    stateEl.className = stateClass(data.commissioning_state || "starting");

    renderMessage(data.message);
    renderMissing(data.missing_fields);
    renderIdentity(data.identity);
    renderRuntime(data.runtime);

    var luEl = el("last-updated");
    if (luEl && data.last_updated) {
      luEl.textContent = "Updated " + new Date(data.last_updated).toLocaleTimeString();
    }
  }

  function renderRuntime(runtime) {
    var operational = el("operational-panel");
    var commissioning = el("status-card");
    var identity = el("identity-panel");
    if (!runtime) { operational.classList.add("hidden"); return; }
    if (runtime.kind === "overlay" && runtime.overlay) {
      if (!operational.classList.contains("hidden")) operational.classList.remove("hidden");
      renderMessage(runtime.overlay);
      return;
    }
    if (runtime.kind === "room" && runtime.display) {
      commissioning.classList.add("hidden");
      identity.classList.add("hidden");
      operational.classList.remove("hidden");
      var status = runtime.display.status || {}, room = runtime.display.room || {}, station = runtime.display.station || {}, patient = runtime.display.patient || {}, timing = runtime.display.timing || {};
      el("operational-station").textContent = station.label || "—";
      el("operational-status").textContent = runtime.display.mode === "closed" ? "CLÍNICA CERRADA" : (status.label || status.code || "—");
      el("operational-status").className = "status-" + (status.code || "available");
      el("operational-patient").textContent = patient.name || "—";
      el("operational-room").textContent = room.label || "—";
      el("operational-elapsed").textContent = timing.started_at ? elapsedText(timing.started_at) : "";
    }
  }

  function elapsedText(startedAt) {
    var ms = Date.now() - new Date(startedAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "";
    var minutes = Math.floor(ms / 60000);
    return minutes + " min";
  }

  function renderMessage(msg) {
    var box = el("message-box");
    if (!msg || !msg.text) {
      box.textContent = "";
      box.className = "";
      return;
    }
    box.textContent = msg.text;
    box.className = "msg-" + (msg.kind || "info");
  }

  function renderMissing(missing) {
    var list = el("missing-list");
    list.innerHTML = "";
    if (!missing || missing.length === 0) return;
    missing.forEach(function (key) {
      var li = document.createElement("li");
      li.textContent = "Still needed: " + (QR_LABELS[key] || key);
      list.appendChild(li);
    });
  }

  function renderIdentity(identity) {
    var panel = el("identity-panel");
    var dl = el("identity-dl");
    if (!identity) {
      panel.classList.add("hidden");
      dl.innerHTML = "";
      return;
    }
    panel.classList.remove("hidden");
    var fields = [
      ["Location", identity.location_id],
      ["Room", identity.room_id],
      ["Station", identity.station_id],
      ["Device ID", identity.device_id],
    ];
    dl.innerHTML = fields
      .map(function (f) {
        return "<dt>" + escapeHtml(f[0]) + "</dt><dd>" + escapeHtml(f[1] || "\u2014") + "</dd>";
      })
      .join("");
  }

  function poll() {
    fetch("/api/state")
      .then(function (r) {
        return r.json();
      })
      .then(renderState)
      .catch(function (err) {
        var stateEl = el("state-label");
        if (stateEl) stateEl.textContent = "Display error: " + err.message;
      });
  }

  poll();
  setInterval(poll, POLL_INTERVAL);
})();
