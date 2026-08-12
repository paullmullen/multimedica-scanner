"use strict";

/**
 * Commissioning — Multimedica Scanner Bootstrap Layer
 *
 * Pure functions for commissioning-state calculation.
 *
 * State is always computed from the authoritative config.json and
 * secrets.json at call time.  The stored commissioning_state field in
 * config.json is metadata written after a successful state change; this
 * module never reads it as input.
 *
 * Secret values are never accepted, stored, or returned here.
 */

// ---------------------------------------------------------------------------
// Required field sets (field names only; no values)
// ---------------------------------------------------------------------------

/** Non-secret config.json fields required for each provisioning step */
const REQUIRED_CONFIG = Object.freeze({
  wifi: Object.freeze(["wifi_ssid", "wifi_security"]),
  station: Object.freeze(["location_id", "room_id", "station_id", "device_id"]),
  cloud: Object.freeze(["endpoint_url"]),
});

/** secrets.json keys whose presence is required for each provisioning step */
const REQUIRED_SECRETS = Object.freeze({
  wifi: Object.freeze(["wifi_password"]),
  cloud: Object.freeze(["shared_secret"]),
});

// ---------------------------------------------------------------------------
// State computation
// ---------------------------------------------------------------------------

/**
 * Compute the current commissioning state from authoritative stored data.
 *
 * This function is deterministic: the same config + secrets always
 * produce the same result, allowing safe restart recovery.
 *
 * @param {object|null} config  - output of config-store.readConfig()
 * @param {object|null} secrets - output of secrets-store.readSecrets()
 * @returns {{
 *   state: string,
 *   configuration_complete: boolean,   // all 3 QR kinds accepted
 *   commissioning_complete: boolean,   // configuration + release installed (Milestone 5+)
 *   release_installed: boolean,        // always false until Milestone 5
 *   production_ready: boolean,         // always false until Milestone 5
 *   missing: string[],
 *   configured: { wifi: boolean, station: boolean, cloud: boolean }
 * }}
 */
function computeState(config, secrets) {
  const cfg = config || {};
  const sec = secrets || {};

  const hasWifi = _hasAll(cfg, REQUIRED_CONFIG.wifi) && _hasAll(sec, REQUIRED_SECRETS.wifi);
  const hasStation = _hasAll(cfg, REQUIRED_CONFIG.station);
  const hasCloud = _hasAll(cfg, REQUIRED_CONFIG.cloud) && _hasAll(sec, REQUIRED_SECRETS.cloud);

  const configuration_complete = hasWifi && hasStation && hasCloud;

  // commissioning_complete requires configuration AND a production release.
  // release_installed and production_ready are always false until Milestone 5.
  const release_installed = false;
  const production_ready = false;
  const commissioning_complete = configuration_complete && release_installed && production_ready;

  const missing = [];
  if (!hasWifi) missing.push("wifi_config");
  if (!hasStation) missing.push("station_config");
  if (!hasCloud) missing.push("cloud_config");

  // State label reflects the highest confirmed level, regardless of order
  let state;
  if (configuration_complete) state = "cloud_configured";
  else if (hasCloud) state = "cloud_configured";
  else if (hasStation) state = "identity_configured";
  else if (hasWifi) state = "network_configured";
  else state = "bootstrap_installed";

  return {
    state,
    configuration_complete,
    commissioning_complete,
    release_installed,
    production_ready,
    missing,
    configured: { wifi: hasWifi, station: hasStation, cloud: hasCloud },
  };
}

// ---------------------------------------------------------------------------
// Operator messages — must never contain secret values
// ---------------------------------------------------------------------------

const QR_LABELS = Object.freeze({
  wifi_config: "Wi-Fi QR",
  station_config: "station QR",
  cloud_config: "cloud QR",
});

/**
 * Return a plain-language operator message for the current state.
 * The message does not include any token, password, or secret.
 *
 * @param {string}   state   - from computeState().state
 * @param {string[]} missing - from computeState().missing
 * @returns {string}
 */
function getStateMessage(state, missing) {
  const remaining = (missing || []).map((k) => QR_LABELS[k] || k).join(", ");

  switch (state) {
    case "starting":
      return "Bootstrap controller starting\u2026";
    case "bootstrap_installed":
      return "Ready. Scan Wi\u2011Fi configuration QR to begin.";
    case "network_configured":
      return remaining
        ? `Wi\u2011Fi accepted. Still needed: ${remaining}.`
        : "Wi\u2011Fi configured.";
    case "identity_configured":
      return remaining ? `Station accepted. Still needed: ${remaining}.` : "Station configured.";
    case "cloud_configured":
      return remaining
        ? `Cloud accepted. Still needed: ${remaining}.`
        : "All configuration accepted. Ready to install production software.";
    case "operational":
      return "Device is operational.";
    default:
      return `Status: ${state}`;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _hasAll(obj, fields) {
  return fields.every((f) => obj[f] != null && obj[f] !== "");
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  computeState,
  getStateMessage,
  REQUIRED_CONFIG,
  REQUIRED_SECRETS,
};
