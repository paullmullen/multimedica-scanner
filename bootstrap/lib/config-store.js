"use strict";

/**
 * Config Store — Multimedica Scanner Bootstrap Layer
 *
 * Atomic read/write/backup for /var/lib/multimedica-scanner/state/config.json.
 *
 * config.json holds non-secret operational and commissioning values.
 * Secrets (shared_secret, wifi_password, qr_admin_token) are stored by
 * secrets-store.js instead.
 *
 * MULTIMEDICA_STATE_DIR overrides the default path for tests.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_STATE_DIR = "/var/lib/multimedica-scanner/state";
const CONFIG_SCHEMA_VERSION = 1;
const MAX_BACKUPS = 5;
// ---------------------------------------------------------------------------
// Schema validation (lazy-initialised — loaded on first write attempt)
// Partial validation: checks property types, patterns, and enum values but
// does NOT enforce required fields. Config is assembled incrementally by QR
// scans; required-field completeness is the controller's responsibility.
// ---------------------------------------------------------------------------

let _configValidator = null;

function _getConfigValidator() {
  if (_configValidator) return _configValidator;
  const Ajv = require("ajv");
  const addFormats = require("ajv-formats");
  const baseSchema = require("../../schemas/config.schema.json");
  const partialSchema = Object.assign({}, baseSchema);
  delete partialSchema.required; // allow partial/incremental writes
  const ajv = new (Ajv.default || Ajv)({ strict: false, allErrors: true });
  (addFormats.default || addFormats)(ajv);
  _configValidator = ajv.compile(partialSchema);
  return _configValidator;
}

function _validateConfigObject(obj) {
  const validate = _getConfigValidator();
  if (validate(obj)) return { ok: true };
  return {
    ok: false,
    errors: (validate.errors || []).map((e) => ({
      path: e.instancePath || "(root)",
      message: e.message || "validation failed",
      keyword: e.keyword,
    })),
  };
}
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function stateDir() {
  return process.env.MULTIMEDICA_STATE_DIR || DEFAULT_STATE_DIR;
}

function configPath(dir) {
  return path.join(dir, "config.json");
}

function backupDir(dir) {
  return path.join(dir, "backups");
}

// ---------------------------------------------------------------------------
// Public: read
// ---------------------------------------------------------------------------

/**
 * Read config.json. Returns null if the file does not exist or cannot be parsed.
 * @param {string} [dir]
 * @returns {object|null}
 */
function readConfig(dir) {
  dir = dir || stateDir();
  const p = configPath(dir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: write (atomic merge)
// ---------------------------------------------------------------------------

/**
 * Merge updates into config.json and write atomically.
 * Backs up the existing file before overwriting.
 * @param {object} updates  Fields to merge
 * @param {string} [dir]
 * @returns {object} The written config object
 */
function writeConfig(updates, dir) {
  dir = dir || stateDir();
  const p = configPath(dir);

  fs.mkdirSync(path.dirname(p), { recursive: true });

  const existing = readConfig(dir) || {};
  const next = Object.assign({}, existing, updates, {
    schema_version: CONFIG_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  });

  // Validate BEFORE backup or write — an invalid proposed object never
  // touches the authoritative file, the backup set, or the .tmp path.
  const validation = _validateConfigObject(next);
  if (!validation.ok) {
    const summary = validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    const err = new Error(`Config validation failed: ${summary}`);
    err.validationErrors = validation.errors;
    err.code = "CONFIG_VALIDATION_ERROR";
    throw err;
  }

  if (fs.existsSync(p)) {
    _backupFile(p, dir);
  }

  _atomicWrite(p, JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------------------
// Public: migration from legacy .env content
// ---------------------------------------------------------------------------

/**
 * Migrate non-secret keys from raw legacy .env content into config.json.
 * Does not rename or delete the source file — the caller is responsible
 * (migrateFromLegacyEnv in state-store.js handles file operations).
 *
 * @param {string} rawEnv  Raw contents of the legacy .env file
 * @param {string} [dir]
 * @returns {{ migrated: boolean, keys?: string[], reason?: string }}
 */
function migrateFromEnvContent(rawEnv, dir) {
  dir = dir || stateDir();

  const existing = readConfig(dir);
  if (existing && existing.schema_version === CONFIG_SCHEMA_VERSION) {
    return { migrated: false, reason: "config.json already exists" };
  }

  const env = _parseEnv(rawEnv);
  const updates = {};
  const mapping = {
    ENDPOINT_URL: "endpoint_url",
    LOCATION_ID: "location_id",
    ROOM_ID: "room_id",
    STATION_ID: "station_id",
    DEVICE_ID: "device_id",
  };

  for (const [envKey, configKey] of Object.entries(mapping)) {
    if (env[envKey]) updates[configKey] = env[envKey];
  }

  if (Object.keys(updates).length === 0 && !existing) {
    // Write a minimal bootstrap config even with no keys found
    updates.commissioning_state = "bootstrap_installed";
  } else if (Object.keys(updates).length === 0) {
    return { migrated: false, reason: "no non-secret keys found" };
  }

  updates.commissioning_state = updates.commissioning_state || "bootstrap_installed";
  updates.qr_schema_version = 1;
  updates.config_schema_version = CONFIG_SCHEMA_VERSION;

  writeConfig(updates, dir);
  return { migrated: true, keys: Object.keys(updates) };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function _atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  try {
    const fd = fs.openSync(tmp, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {
    // fsync not critical; best-effort
  }
  fs.renameSync(tmp, filePath);
}

function _backupFile(filePath, dir) {
  const bdir = backupDir(dir);
  fs.mkdirSync(bdir, { recursive: true });

  const name = path.basename(filePath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(bdir, `${name}.${ts}`);
  try {
    fs.copyFileSync(filePath, dest);
  } catch {
    // best-effort
  }

  // Prune to MAX_BACKUPS
  try {
    const entries = fs
      .readdirSync(bdir)
      .filter((e) => e.startsWith(name + "."))
      .sort();
    while (entries.length > MAX_BACKUPS) {
      fs.unlinkSync(path.join(bdir, entries.shift()));
    }
  } catch {
    // best-effort
  }
}

/**
 * Parse a .env-style file into a key→value map.
 * Handles quoted values and comment lines.
 * @param {string} raw
 * @returns {Record<string,string>}
 */
function _parseEnv(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

module.exports = {
  readConfig,
  writeConfig,
  migrateFromEnvContent,
  // exposed for testing
  _parseEnv,
  _atomicWrite,
};
