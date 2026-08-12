"use strict";

/**
 * Health — Multimedica Scanner Bootstrap Controller
 *
 * Lightweight health state for the controller process.
 * No secret values are stored here.
 */

const STARTED_AT = new Date().toISOString();

const _state = {
  scanner_connected: false,
  qr_admin_token_loaded: false,
};

function setField(key, value) {
  _state[key] = value;
}

/**
 * Return a snapshot safe for inclusion in status responses.
 * Never include secret values.
 */
function getSnapshot() {
  return Object.assign({}, _state, {
    service: "multimedica-controller",
    started_at: STARTED_AT,
    uptime_seconds: Math.floor((Date.now() - new Date(STARTED_AT).getTime()) / 1000),
  });
}

module.exports = { setField, getSnapshot, STARTED_AT };
