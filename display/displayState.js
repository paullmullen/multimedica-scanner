// displayState.js
//
// In-memory store for the current display state.
// Phase 1 goals:
// - One canonical state object
// - Support normal room status mode
// - Support temporary overlay mode
// - Auto-return from overlay to prior room status

const DEFAULT_ROOM_STATE = {
  mode: "room_status",
  updated_at: new Date().toISOString(),
  room: {
    room_id: "unassigned_room",
    label: "Unassigned Room",
  },
  station: {
    station_id: "unassigned_station",
    label: "Unassigned Station",
  },
  status: {
    code: "unavailable",
    label: "NO DISPONIBLE",
  },
  patient: {
    name: null,
  },
  timing: {
    started_at: null,
    elapsed_seconds: 0,
  },
  message: null,
};

let roomState = { ...DEFAULT_ROOM_STATE };
let currentState = { ...roomState };

let overlayTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function clearOverlayTimer() {
  if (overlayTimer) {
    clearTimeout(overlayTimer);
    overlayTimer = null;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function computeElapsedSeconds(startedAt) {
  if (!startedAt) return 0;
  const startedMs = new Date(startedAt).getTime();
  if (Number.isNaN(startedMs)) return 0;
  const elapsedMs = Date.now() - startedMs;
  return elapsedMs > 0 ? Math.floor(elapsedMs / 1000) : 0;
}

function normalizeRoomStatusPayload(payload = {}) {
  const startedAt = payload?.timing?.started_at ?? null;

  return {
    mode: "room_status",
    updated_at: nowIso(),
    room: {
      room_id: payload?.room?.room_id ?? roomState.room.room_id,
      label: payload?.room?.label ?? roomState.room.label,
    },
    station: {
      station_id: payload?.station?.station_id ?? roomState.station.station_id,
      label: payload?.station?.label ?? roomState.station.label,
    },
    status: {
      code: payload?.status?.code ?? roomState.status.code,
      label: payload?.status?.label ?? roomState.status.label,
    },
    patient: {
      name:
        payload?.patient?.name !== undefined
          ? payload.patient.name
          : roomState.patient.name,
    },
    timing: {
      started_at: startedAt,
      elapsed_seconds: computeElapsedSeconds(startedAt),
    },
    message:
      payload?.message !== undefined ? payload.message : roomState.message,
  };
}

function normalizeOverlayPayload(payload = {}) {
  const durationMs =
    Number.isFinite(payload.duration_ms) && payload.duration_ms > 0
      ? payload.duration_ms
      : 4000;

  const expiresAt = new Date(Date.now() + durationMs).toISOString();

  return {
    mode: "overlay",
    updated_at: nowIso(),
    overlay: {
      kind: payload.kind ?? "info",
      severity: payload.severity ?? "info",
      title: payload.title ?? "Mensaje",
      detail: payload.detail ?? "",
      expires_at: expiresAt,
      duration_ms: durationMs,
    },
    return_to: "room_status",
  };
}

function getState() {
  // Recompute elapsed seconds on reads so polling clients stay accurate.
  if (currentState.mode === "room_status") {
    currentState.timing.elapsed_seconds = computeElapsedSeconds(
      currentState?.timing?.started_at ?? null
    );
  }

  return clone(currentState);
}

function getRoomState() {
  roomState.timing.elapsed_seconds = computeElapsedSeconds(
    roomState?.timing?.started_at ?? null
  );
  return clone(roomState);
}

function setRoomStatus(payload = {}) {
  clearOverlayTimer();

  roomState = normalizeRoomStatusPayload(payload);
  currentState = clone(roomState);

  return getState();
}

function setOverlay(payload = {}) {
  clearOverlayTimer();

  const overlayState = normalizeOverlayPayload(payload);
  currentState = overlayState;

  const durationMs = overlayState.overlay.duration_ms;

  overlayTimer = setTimeout(() => {
    currentState = clone(roomState);
    currentState.updated_at = nowIso();
    overlayTimer = null;
  }, durationMs);

  return getState();
}

function resetState() {
  clearOverlayTimer();
  roomState = {
    ...clone(DEFAULT_ROOM_STATE),
    updated_at: nowIso(),
  };
  currentState = clone(roomState);
  return getState();
}

module.exports = {
  getState,
  getRoomState,
  setRoomStatus,
  setOverlay,
  resetState,
};