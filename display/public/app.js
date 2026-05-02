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
function debugScreen(message, data = null) {
  console.log("DISPLAY DEBUG:", message, data || "");

  let debugEl = document.getElementById("debugStatus");

  if (!debugEl) {
    debugEl = document.createElement("div");
    debugEl.id = "debugStatus";
    debugEl.style.position = "fixed";
    debugEl.style.left = "8px";
    debugEl.style.bottom = "8px";
    debugEl.style.zIndex = "99999";
    debugEl.style.background = "rgba(0,0,0,0.75)";
    debugEl.style.color = "white";
    debugEl.style.fontSize = "14px";
    debugEl.style.padding = "6px 8px";
    debugEl.style.borderRadius = "6px";
    debugEl.style.maxWidth = "95vw";
    debugEl.style.whiteSpace = "pre-wrap";
    document.body.appendChild(debugEl);
  }

  debugEl.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
}


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

let startedAtMs = null;
let lastMode = null;
let lastStatusCode = null;

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

  appEl.classList.remove(
    "state-vacant",
    "state-in-process",
    "state-unavailable",
    "state-waiting",
    "overlay-success",
    "overlay-error",
    "overlay-warning",
    "overlay-info"
  );

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

  appEl.classList.remove(
    "state-vacant",
    "state-in-process",
    "state-unavailable",
    "overlay-success",
    "overlay-error",
    "overlay-warning",
    "overlay-info"
  );

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
  const severity = overlay.severity || "warning";
  const title = overlay.title || "Mensaje";
  const detail = overlay.detail || "";
  const updatedAt = state?.updated_at || Date.now();

  lastMode = "overlay";

  applyOverlayClass(severity);

  if (statusTextEl) {
    statusTextEl.textContent = `${iconBySeverity[severity] || "i"}\n${title}`;
  }

  if (patientNameEl) patientNameEl.textContent = detail || " ";
  if (roomValueEl) roomValueEl.textContent = " ";
  if (stationValueEl) stationValueEl.textContent = " ";
  if (stationBadgeEl) stationBadgeEl.textContent = "ALERTA";

  startedAtMs = null;

  if (elapsedValueEl) elapsedValueEl.textContent = "Volviendo...";
  if (updatedValueEl) updatedValueEl.textContent = formatShortTime(updatedAt);
  if (dateTimeValueEl) dateTimeValueEl.textContent = formatFooterDateTime(Date.now());
}

function setDisplayState(state) {
  const mode = state?.mode || "room_status";

  if (mode === "overlay") {
    setOverlayDisplay(state);
    return;
  }

  setRoomStatusDisplay(state);
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
    debugScreen("fetchDisplayState: start");

    const response = await fetch(`/api/display?ts=${Date.now()}`, {
      cache: "no-store",
    });

    debugScreen(`fetchDisplayState: response ${response.status}`);

    if (!response.ok) {
      throw new Error(`Display API returned ${response.status}`);
    }

    const payload = await response.json();

    debugScreen(
      `payload: ${payload?.state?.status?.code || "no status"} / ${payload?.state?.station?.label || "no station"}`
    );

    setDisplayState(payload.state);

    debugScreen(
      `rendered: ${payload?.state?.status?.code || "no status"}`
    );
  } catch (error) {
    console.error("Failed to fetch display state:", error);
    debugScreen(`ERROR: ${error.message}`);

    setDisplayState({
      mode: "room_status",
      updated_at: Date.now(),
      room: { label: "—" },
      station: { label: "—" },
      status: { code: "unavailable", label: "NO DISPONIBLE" },
      patient: { name: "—" },
      timing: { started_at: null },
    });
  }
}

refreshClock();
refreshElapsed();

setInterval(refreshClock, 1000);
setInterval(refreshElapsed, 1000);

fetchDisplayState();
setInterval(fetchDisplayState, 2000);