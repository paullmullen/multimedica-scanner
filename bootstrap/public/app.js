/* global document, fetch, setInterval, window */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) api.start(root.document);
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var POLL_INTERVAL_MS = 2000;
  var lastRuntime = null;

  var STATE_LABELS = {
    starting: "Iniciando…",
    bootstrap_installed: "Escanee el QR de Wi‑Fi para comenzar",
    network_configured: "Wi‑Fi configurado",
    identity_configured: "Estación configurada",
    cloud_configured: "Configuración completa",
    operational: "Operacional",
  };

  var QR_LABELS = {
    wifi_config: "configuración de Wi‑Fi",
    station_config: "configuración de estación",
    cloud_config: "configuración de nube",
  };

  var DISPLAY_CLASSES = [
    "state-vacant",
    "state-in-process",
    "state-unavailable",
    "state-waiting",
    "state-clinic-closed",
    "state-candidate",
    "overlay-success",
    "overlay-error",
    "overlay-warning",
    "overlay-info",
  ];

  function runtimeView(runtime) {
    if (!runtime || typeof runtime !== "object") return { mode: "commissioning" };
    if (runtime.kind === "overlay" && runtime.overlay) {
      return {
        mode: "overlay",
        severity: runtime.overlay.severity || "info",
        title: runtime.overlay.title || "MENSAJE",
        detail: runtime.overlay.detail || "",
      };
    }
    if (runtime.kind !== "room" || !runtime.display) return { mode: "commissioning" };

    var display = runtime.display;
    var status = display.status || {};
    var room = display.room || {};
    var station = display.station || {};
    var patient = display.patient || {};
    var label = status.label || statusLabel(status.code);
    var candidate =
      /^candidate-/i.test(runtime.state_id || "") || String(label).toUpperCase() === "CANDIDATE";
    if (candidate) {
      return {
        mode: "candidate",
        status: "CANDIDATE",
        detail: "Validación física de la versión candidata",
        station: station.label || station.id || "VALIDACIÓN",
      };
    }
    if (display.mode === "closed") {
      return {
        mode: "closed",
        status: "CLÍNICA\nCERRADA",
        patient: "El sistema está conectado y esperando la próxima jornada.",
        room: room.label || room.id || "—",
        station: station.label || station.id || "—",
        updatedAt: display.updated_at,
      };
    }
    return {
      mode: "room",
      code: status.code || "available",
      status: label,
      patient: patient.name || "—",
      room: room.label || room.id || "—",
      station: station.label || station.id || "—",
      startedAt: display.timing && display.timing.started_at,
      updatedAt: display.updated_at,
    };
  }

  function statusLabel(code) {
    return {
      in_process: "EN\nPROCESO",
      patient_waiting: "PACIENTE\nEN ESPERA",
      unavailable: "NO\nDISPONIBLE",
      available: "DISPONIBLE",
      vacant: "DISPONIBLE",
    }[code] || "DISPONIBLE";
  }

  function start(doc) {
    function el(id) { return doc.getElementById(id); }

    function showCommissioning(data) {
      el("commissioning-screen").classList.remove("hidden");
      el("app").classList.add("hidden");
      var state = data.commissioning_state || "starting";
      el("commissioning-state").textContent = STATE_LABELS[state] || state;
      el("commissioning-state").className = "commissioning-state state-" + state.replace(/_/g, "-");
      var message = data.message || {};
      el("commissioning-message").textContent = message.text || "";
      el("commissioning-message").className = "commissioning-message msg-" + (message.kind || "info");
      var missing = data.missing_fields || [];
      el("commissioning-missing").innerHTML = missing.map(function (key) {
        return "<li>Falta: " + escapeHtml(QR_LABELS[key] || key) + "</li>";
      }).join("");
      var identity = data.identity || {};
      el("commissioning-identity").textContent = [
        identity.location_id,
        identity.room_id,
        identity.station_id,
        identity.device_id,
      ].filter(Boolean).join(" · ");
    }

    function showRuntime(view) {
      el("commissioning-screen").classList.add("hidden");
      el("app").classList.remove("hidden");
      DISPLAY_CLASSES.forEach(function (name) { el("app").classList.remove(name); });
      if (view.mode === "overlay") {
        el("app").classList.add("overlay-" + view.severity);
        setText("statusText", overlayIcon(view.severity) + "\n" + view.title);
        setText("patientName", view.detail || " ");
        setText("stationBadge", "ALERTA");
        setText("stationValue", " ");
        setText("updatedValue", shortTime(Date.now()));
        setHealth("◆ Mensaje del sistema", "health-degraded");
        return;
      }
      if (view.mode === "candidate") {
        el("app").classList.add("state-candidate");
        setText("statusText", view.status);
        setText("patientName", view.detail);
        setText("stationBadge", "CAND");
        setText("stationValue", view.station);
        setText("updatedValue", shortTime(Date.now()));
        setHealth("◆ VALIDACIÓN DE VERSIÓN · Confirme físicamente", "health-candidate");
        return;
      }
      if (view.mode === "closed") {
        el("app").classList.add("state-clinic-closed");
      } else {
        el("app").classList.add(roomClass(view.code));
      }
      setText("statusText", view.status);
      setText("patientName", view.patient);
      setText("stationValue", view.station);
      setText("stationBadge", String(view.station || "—").slice(0, 3).toUpperCase());
      setText("updatedValue", shortTime(view.updatedAt || Date.now()));
      setHealth(view.mode === "closed" ? "○ Clínica cerrada · Conectado" : "● Conectado", "health-healthy");
    }

    function render(data) {
      var view = runtimeView(data.runtime);
      if (view.mode === "commissioning") showCommissioning(data);
      else { lastRuntime = data.runtime; showRuntime(view); }
    }

    function poll() {
      fetch("/api/state", { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) throw new Error("Display API " + response.status);
          return response.json();
        })
        .then(render)
        .catch(function () {
          if (lastRuntime) showRuntime(runtimeView(lastRuntime));
          setHealth("⚠ Sin conexión con la pantalla", "health-degraded");
        });
    }

    function setText(id, value) { var node = el(id); if (node) node.textContent = value || "—"; }
    function setHealth(text, className) { var node = el("healthStrip"); if (node) { node.textContent = text; node.className = "health-strip " + className; } }

    function refreshClock() {
      setText("dateTimeValue", new Date().toLocaleString("es-GT", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: false,
      }));
    }

    poll();
    refreshClock();
    setInterval(poll, POLL_INTERVAL_MS);
    setInterval(refreshClock, 1000);
  }

  function roomClass(code) {
    return {
      in_process: "state-in-process",
      patient_waiting: "state-waiting",
      unavailable: "state-unavailable",
    }[code] || "state-vacant";
  }

  function overlayIcon(severity) {
    return { success: "✓", error: "!", warning: "⚠", info: "i" }[severity] || "i";
  }

  function shortTime(value) {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  return { runtimeView: runtimeView, statusLabel: statusLabel, roomClass: roomClass, start: start };
});
