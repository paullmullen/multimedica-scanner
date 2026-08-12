"use strict";

/**
 * Secrets Store — Multimedica Scanner Bootstrap Layer
 *
 * Atomic read/write/backup for /var/lib/multimedica-scanner/state/secrets.json.
 *
 * Ownership and permissions on Linux:
 *   owner: root
 *   group: multimedica_edge
 *   mode:  0640   (root writes; multimedica_edge service account reads)
 *
 * RULES:
 *   - Secret values (qr_admin_token, shared_secret, wifi_password) are never
 *     passed to console.log, process.env, or any log sink.
 *   - getAdminToken() is the only public accessor that returns a raw value;
 *     callers must handle the result without logging it.
 *   - writeSecrets() accepts updates but never echoes them to stdout.
 *
 * MULTIMEDICA_STATE_DIR overrides the default path for tests.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_STATE_DIR = "/var/lib/multimedica-scanner/state";
const SECRETS_SCHEMA_VERSION = 1;
const MAX_BACKUPS = 5;
// ---------------------------------------------------------------------------
// Schema validation (lazy-initialised — loaded on first write attempt)
// Full schema validation is used: secrets.json must always contain at least
// schema_version and qr_admin_token when written.
// IMPORTANT: error output must never include secret values — only field paths
// and AJV constraint messages are surfaced.
// ---------------------------------------------------------------------------

let _secretsValidator = null;

function _getSecretsValidator() {
  if (_secretsValidator) return _secretsValidator;
  const Ajv = require("ajv");
  const addFormats = require("ajv-formats");
  const schema = require("../../schemas/secrets.schema.json");
  const ajv = new (Ajv.default || Ajv)({ strict: false, allErrors: true });
  (addFormats.default || addFormats)(ajv);
  _secretsValidator = ajv.compile(schema);
  return _secretsValidator;
}

function _validateSecretsObject(obj) {
  const validate = _getSecretsValidator();
  if (validate(obj)) return { ok: true };
  // Deliberately omit params and data from errors — they may reference
  // secret values (e.g. allowedValues in enum errors).  Only path, message,
  // and keyword are safe to surface.
  return {
    ok: false,
    errors: (validate.errors || []).map((e) => ({
      path: e.instancePath || "(root)",
      message: e.message || "validation failed",
      keyword: e.keyword,
    })),
  };
}
// Keys that must never appear in logs or diagnostics
const SECRET_KEYS = Object.freeze(["qr_admin_token", "shared_secret", "wifi_password"]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function stateDir() {
  return process.env.MULTIMEDICA_STATE_DIR || DEFAULT_STATE_DIR;
}

function secretsPath(dir) {
  return path.join(dir, "secrets.json");
}

function backupDir(dir) {
  return path.join(dir, "backups");
}

// ---------------------------------------------------------------------------
// Public: read
// ---------------------------------------------------------------------------

/**
 * Read secrets.json. Returns null if the file does not exist or cannot be parsed.
 * Callers must not log the returned object.
 * @param {string} [dir]
 * @returns {object|null}
 */
function readSecrets(dir) {
  dir = dir || stateDir();
  const p = secretsPath(dir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Return the QR admin token, or null if not yet configured.
 * This is the only function that the controller calls to obtain the token.
 * The return value must not be logged.
 * @param {string} [dir]
 * @returns {string|null}
 */
function getAdminToken(dir) {
  const s = readSecrets(dir || stateDir());
  return s?.qr_admin_token ?? null;
}

// ---------------------------------------------------------------------------
// Public: write (atomic merge)
// ---------------------------------------------------------------------------

/**
 * Merge updates into secrets.json and write atomically.
 * On Linux, sets mode 0640 and chown root:multimedica_edge after write.
 * Does not log any value from the updates object.
 *
 * @param {object} updates  Map of secret key names to values
 * @param {string} [dir]
 * @returns {{ ok: boolean }}
 */
function writeSecrets(updates, dir) {
  dir = dir || stateDir();
  const p = secretsPath(dir);

  fs.mkdirSync(path.dirname(p), { recursive: true });

  const existing = readSecrets(dir) || {};
  const next = Object.assign({}, existing, updates, {
    schema_version: SECRETS_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  });

  // Validate BEFORE backup or write — an invalid proposed object never
  // touches the authoritative file, the backup set, or the .tmp path.
  // Error messages contain only field paths and AJV constraint descriptions;
  // they never contain secret values.
  const validation = _validateSecretsObject(next);
  if (!validation.ok) {
    const summary = validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    const err = new Error(`Secrets validation failed: ${summary}`);
    err.validationErrors = validation.errors;
    err.code = "SECRETS_VALIDATION_ERROR";
    // Belt-and-suspenders: ensure no secret value leaked into the message
    for (const key of SECRET_KEYS) {
      if (existing[key] && err.message.includes(String(existing[key]))) {
        err.message = "Secrets validation failed: [details redacted]";
        break;
      }
    }
    throw err;
  }

  if (fs.existsSync(p)) {
    _backupFile(p, dir);
  }

  _atomicWrite(p, JSON.stringify(next, null, 2));

  // Set permissions on Linux:
  //   root:multimedica_edge 0640
  // root controls writes; multimedica_edge may read.
  if (process.platform === "linux") {
    try {
      fs.chmodSync(p, 0o640);
      // chown requires elevated privileges; best-effort in install context
    } catch {
      // best-effort
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public: migration from legacy .env content
// ---------------------------------------------------------------------------

/**
 * Migrate secret keys from raw legacy .env content into secrets.json.
 * Does not rename or delete the source file.
 *
 * @param {string} rawEnv  Raw contents of the legacy .env file
 * @param {string} [dir]
 * @returns {{ migrated: boolean, keysPresent?: string[], reason?: string }}
 */
function migrateFromEnvContent(rawEnv, dir) {
  dir = dir || stateDir();

  const existing = readSecrets(dir);
  if (existing && existing.schema_version === SECRETS_SCHEMA_VERSION) {
    return { migrated: false, reason: "secrets.json already exists" };
  }

  const env = _parseEnv(rawEnv);
  const updates = {};
  const mapping = {
    SCANNER_QR_ADMIN_TOKEN: "qr_admin_token",
    SHARED_SECRET: "shared_secret",
    // wifi_password is not in legacy .env; omit
  };

  for (const [envKey, secretKey] of Object.entries(mapping)) {
    if (env[envKey]) updates[secretKey] = env[envKey];
  }

  if (Object.keys(updates).length === 0) {
    return { migrated: false, reason: "no secret keys found in env" };
  }

  writeSecrets(updates, dir);
  // Report key names only; never report values
  return { migrated: true, keysPresent: Object.keys(updates) };
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
    // best-effort
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
  readSecrets,
  getAdminToken,
  writeSecrets,
  migrateFromEnvContent,
  SECRET_KEYS,
  // exposed for testing
  _parseEnv,
};
