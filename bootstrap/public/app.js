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

    var luEl = el("last-updated");
    if (luEl && data.last_updated) {
      luEl.textContent = "Updated " + new Date(data.last_updated).toLocaleTimeString();
    }
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
