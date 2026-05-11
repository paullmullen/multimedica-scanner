window.addEventListener("error", (event) => {
  console.error(
    "WINDOW ERROR:",
    event.message,
    event.filename,
    event.lineno,
    event.colno,
    event.error
  );
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("UNHANDLED PROMISE REJECTION:", event.reason);
});

console.log("APP STARTED");

const appEl = document.getElementById("app");
const statusTextEl = document.getElementById("statusText");
const patientNameEl = document.getElementById("patientName");
const roomValueEl = document.getElementById("roomValue");
const stationValueEl = document.getElementById("stationValue");
const stationBadgeEl = document.getElementById("stationBadge");
const elapsedValueEl = document.getElementById("elapsedValue");
const updatedValueEl = document.getElementById("updatedValue");
const dateTimeValueEl = document.getElementById("dateTimeValue");

const iconBySeverity = {
  success: "✓",
  error: "!",
  warning: "⚠",
  info: "i",
};

let healthStripEl = null;
let currentRenderedState = null;
let startedAtMs = null;
let lastMode = null;
let lastStatusCode = null;

const DISPLAY_CONFIG = Object.freeze({
  health: Object.freeze({
    stale_ms: 90 * 1000,
    very_stale_ms: 180 * 1000,
  }),
  refresh: Object.freeze({
    clock_ms: 1000,
    elapsed_ms: 1000,
    health_ms: 1000,
    display_poll_ms: 2000,
  }),
});

const DISPLAY_CLASS_NAMES = Object.freeze([
  "state-vacant",
  "state-in-process",
  "state-unavailable",
  "state-waiting",
  "state-clinic-closed",
  "overlay-success",
  "overlay-error",
  "overlay-warning",
  "overlay-info",
  "trust-untrusted",
]);

function clearDisplayClasses() {
  if (!appEl) return;
  appEl.classList.remove(...DISPLAY_CLASS_NAMES);
}

function getRenderMode(state) {
  const operationalMode = state?.operational_mode || state?.health?.operational_mode || "open";

  if (state?.health?.trust_level === "untrusted") {
    return "untrusted";
  }

  if ((state?.mode || "room_status") === "overlay") {
    return "overlay";
  }

  if (operationalMode === "closed") {
    return "clinic_closed";
  }

  return "room_status";
}

function ensureHealthStrip() {
  if (healthStripEl) return healthStripEl;

  healthStripEl = document.getElementById("healthStrip");

  if (healthStripEl) return healthStripEl;

  const footerEl = document.querySelector(".footer");

  healthStripEl = document.createElement("div");
  healthStripEl.id = "healthStrip";
  healthStripEl.className = "health-strip health-healthy";
  healthStripEl.textContent = "● Conectado";

  if (footerEl) {
    footerEl.appendChild(healthStripEl);
  } else {
    document.body.appendChild(healthStripEl);
  }

  return healthStripEl;
}

function formatAge(ms) {
  if (!ms || ms < 0) return "ahora";

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `hace ${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return `hace ${hours}h`;
}

function renderHealthStrip(state) {
  const strip = ensureHealthStrip();
  const health = state?.health || {};

  const connectivity = health.connectivity || "online";
  const trustLevel = health.trust_level || "trusted";
  const lastCloudSyncAt =
    health.last_cloud_sync_at || health.updated_at || state?.updated_at || Date.now();

  const syncAgeMs = Date.now() - new Date(lastCloudSyncAt).getTime();

  let level = "healthy";
  let text = "Conectado";

  if (trustLevel === "untrusted") {
    level = "untrusted";
    text = "✖ Pantalla no confiable · revisar configuración";
  } else if (connectivity === "offline") {
    level = "degraded";
    text = `⚠ Sin conexión · último estado ${formatAge(syncAgeMs)}`;
  } else if (syncAgeMs > DISPLAY_CONFIG.health.very_stale_ms) {
    level = "untrusted";
    text = `✖ Estado muy antiguo · último estado ${formatAge(syncAgeMs)}`;
  } else if (syncAgeMs > DISPLAY_CONFIG.health.stale_ms) {
    level = "degraded";
    text = `⚠ Estado no reciente · actualizado ${formatAge(syncAgeMs)}`;
  }

  strip.className = `health-strip health-${level}`;
  strip.textContent = text;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return "00:00";

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${pad2(minutes)}:${pad2(seconds)}`;
}

function formatShortTime(dateValue) {
  if (!dateValue) return "--:--";

  const date = new Date(dateValue);
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatFooterDateTime(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();

  return date.toLocaleString([], {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDisplayStatus(statusCode) {
  switch (statusCode) {
    case "in_process":
      return "EN\nPROCESO";
    case "patient_waiting":
      return "PACIENTE\nEN ESPERA";
    case "unavailable":
      return "NO\nDISPONIBLE";
    case "available":
    case "vacant":
    default:
      return "DISPONIBLE";
  }
}

function applyRoomStateClass(statusCode) {
  if (!appEl) return;

  clearDisplayClasses();

  switch (statusCode) {
    case "in_process":
      appEl.classList.add("state-in-process");
      break;
    case "unavailable":
      appEl.classList.add("state-unavailable");
      break;
    case "patient_waiting":
      appEl.classList.add("state-waiting");
      break;
    case "available":
    case "vacant":
    default:
      appEl.classList.add("state-vacant");
      break;
  }
}

function applyOverlayClass(severity) {
  if (!appEl) return;

  clearDisplayClasses();

  switch (severity) {
    case "success":
      appEl.classList.add("overlay-success");
      break;
    case "error":
      appEl.classList.add("overlay-error");
      break;
    case "warning":
      appEl.classList.add("overlay-warning");
      break;
    case "info":
    default:
      appEl.classList.add("overlay-info");
      break;
  }
}

function setRoomStatusDisplay(state) {
  const statusCode = state?.status?.code || "available";
  const statusLabel = state?.status?.label || toDisplayStatus(statusCode);
  const patientName = state?.patient?.name || "—";
  const roomName = state?.room?.label || "—";
  const stationName = state?.station?.label || "—";
  const startedAt = state?.timing?.started_at || null;
  const updatedAt = state?.updated_at || Date.now();

  lastMode = "room_status";
  lastStatusCode = statusCode;

  applyRoomStateClass(statusCode);

  if (statusTextEl) statusTextEl.textContent = statusLabel;
  if (patientNameEl) patientNameEl.textContent = patientName;
  if (roomValueEl) roomValueEl.textContent = roomName;
  if (stationValueEl) stationValueEl.textContent = stationName;

  if (stationBadgeEl) {
    stationBadgeEl.textContent = String(stationName).slice(0, 3).toUpperCase();
  }

  startedAtMs = startedAt ? new Date(startedAt).getTime() : null;

  if (updatedValueEl) updatedValueEl.textContent = formatShortTime(updatedAt);
  if (dateTimeValueEl) dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
}

function setOverlayDisplay(state) {
  const overlay = state?.overlay || {};
  const severity = overlay.severity || overlay.type || "warning";
  const title = overlay.title || "Mensaje";
  const detail = overlay.detail || overlay.message || "";
  const updatedAt = state?.updated_at || Date.now();

  lastMode = "overlay";
  lastStatusCode = null;
  startedAtMs = null;

  applyOverlayClass(severity);

  if (statusTextEl) {
    statusTextEl.textContent = `${iconBySeverity[severity] || "i"}\n${title}`;
  }

  if (patientNameEl) patientNameEl.textContent = detail || " ";
  if (roomValueEl) roomValueEl.textContent = " ";
  if (stationValueEl) stationValueEl.textContent = " ";
  if (stationBadgeEl) stationBadgeEl.textContent = "ALERTA";
  if (elapsedValueEl) elapsedValueEl.textContent = "Volviendo...";
  if (updatedValueEl) updatedValueEl.textContent = formatShortTime(updatedAt);
  if (dateTimeValueEl) dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
}

function renderClinicClosed(state) {
  if (!appEl) return;

  clearDisplayClasses();
  appEl.classList.add("state-clinic-closed");

  lastMode = "clinic_closed";
  lastStatusCode = null;
  startedAtMs = null;

  if (statusTextEl) {
    statusTextEl.textContent = "CLÍNICA\nCERRADA";
  }

  if (patientNameEl) {
    patientNameEl.textContent = "El sistema está conectado y esperando la próxima jornada.";
  }

  if (roomValueEl) {
    roomValueEl.textContent = state?.room?.label || "—";
  }

  if (stationValueEl) {
    stationValueEl.textContent = state?.station?.label || "—";
  }

  if (stationBadgeEl) {
    const stationName = state?.station?.label || "CLS";
    stationBadgeEl.textContent = String(stationName).slice(0, 3).toUpperCase();
  }

  if (elapsedValueEl) elapsedValueEl.textContent = "—";
  if (updatedValueEl) updatedValueEl.textContent = formatShortTime(Date.now());
  if (dateTimeValueEl) dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
}

function renderUntrustedScreen(state) {
  if (!appEl) return;

  clearDisplayClasses();
  appEl.classList.add("trust-untrusted");

  lastMode = "untrusted";
  lastStatusCode = null;
  startedAtMs = null;

  const health = state?.health || {};
  const message =
    health.last_error_message || "La información en esta pantalla puede ser incorrecta.";

  if (statusTextEl) {
    statusTextEl.textContent = "PANTALLA\nNO CONFIABLE";
  }

  if (patientNameEl) patientNameEl.textContent = message;
  if (roomValueEl) roomValueEl.textContent = "Revisar";
  if (stationValueEl) stationValueEl.textContent = "Configuración";
  if (stationBadgeEl) stationBadgeEl.textContent = "ALERTA";
  if (elapsedValueEl) elapsedValueEl.textContent = "—";
  if (updatedValueEl) updatedValueEl.textContent = formatShortTime(Date.now());
  if (dateTimeValueEl) dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
}

function setDisplayState(state) {
  currentRenderedState = state;

  renderHealthStrip(state);

  switch (getRenderMode(state)) {
    case "untrusted":
      renderUntrustedScreen(state);
      return;

    case "overlay":
      setOverlayDisplay(state);
      return;

    case "clinic_closed":
      renderClinicClosed(state);
      return;

    case "room_status":
    default:
      setRoomStatusDisplay(state);
      return;
  }
}

function refreshHealthStrip() {
  if (!currentRenderedState) return;
  renderHealthStrip(currentRenderedState);
}

function refreshElapsed() {
  if (!elapsedValueEl) return;

  if (lastMode === "room_status" && lastStatusCode === "in_process" && startedAtMs) {
    elapsedValueEl.textContent = formatElapsed(Date.now() - startedAtMs);
  } else {
    elapsedValueEl.textContent = "00:00";
  }
}

function refreshClock() {
  if (!dateTimeValueEl) return;
  dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
}

async function fetchDisplayState() {
  try {
    const response = await fetch(`/api/display?ts=${Date.now()}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Display API returned ${response.status}`);
    }

    const payload = await response.json();
    const nextState = payload.display || payload.state || payload;

    setDisplayState(nextState);
    window.lastKnownGoodState = nextState;
  } catch (error) {
    console.error("Failed to fetch display state:", error);

    if (window.lastKnownGoodState) {
      const degradedState = {
        ...window.lastKnownGoodState,
        health: {
          ...(window.lastKnownGoodState.health || {}),
          connectivity: "offline",
          trust_level: "degraded",
          last_error_at: Date.now(),
          last_error_message: String(error),
        },
      };

      setDisplayState(degradedState);
    }
  }
}

refreshClock();
refreshElapsed();

setInterval(refreshClock, DISPLAY_CONFIG.refresh.clock_ms);
setInterval(refreshElapsed, DISPLAY_CONFIG.refresh.elapsed_ms);
setInterval(refreshHealthStrip, DISPLAY_CONFIG.refresh.health_ms);

fetchDisplayState();
setInterval(fetchDisplayState, DISPLAY_CONFIG.refresh.display_poll_ms);
