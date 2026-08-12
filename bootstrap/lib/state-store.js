"use strict";

/**
 * State Store — Multimedica Scanner Bootstrap Layer
 *
 * Atomic read/write for:
 *   - runtime.json          (transient runtime state)
 *   - installed-version.json (active/previous/known-good release record)
 *   - Any other named JSON file in the state directory
 *
 * Also provides the combined legacy .env migration coordinator that calls
 * both config-store and secrets-store and then renames the source file.
 *
 * MULTIMEDICA_STATE_DIR overrides the default path for tests.
 */

const fs = require("fs");
const path = require("path");
const configStore = require("./config-store");
const secretsStore = require("./secrets-store");

const DEFAULT_STATE_DIR = "/var/lib/multimedica-scanner/state";
const MAX_BACKUPS = 5;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function stateDir() {
  return process.env.MULTIMEDICA_STATE_DIR || DEFAULT_STATE_DIR;
}

function backupDir(dir) {
  return path.join(dir, "backups");
}

// ---------------------------------------------------------------------------
// Public: generic JSON read/write
// ---------------------------------------------------------------------------

/**
 * Read a named JSON file from the state directory.
 * Returns null if the file does not exist or cannot be parsed.
 *
 * @param {string} name   Filename, e.g. 'runtime.json'
 * @param {string} [dir]
 * @returns {object|null}
 */
function readJson(name, dir) {
  dir = dir || stateDir();
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write content to a named JSON file atomically.
 * Backs up the existing file before overwriting.
 *
 * @param {string} name     Filename, e.g. 'runtime.json'
 * @param {object} content
 * @param {string} [dir]
 * @returns {object} The written content
 */
function writeJson(name, content, dir) {
  dir = dir || stateDir();
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  if (fs.existsSync(p)) {
    _backupFile(p, dir);
  }

  _atomicWrite(p, JSON.stringify(content, null, 2));
  return content;
}

// ---------------------------------------------------------------------------
// Public: combined legacy .env migration
// ---------------------------------------------------------------------------

/**
 * Migrate a legacy /home/multimedica_edge/scanner/.env file into the
 * authoritative config.json and secrets.json stores.
 *
 * Steps:
 *   1. Read the legacy file.
 *   2. Migrate non-secret keys into config.json via config-store.
 *   3. Migrate secret keys into secrets.json via secrets-store.
 *   4. Rename the legacy file to .env.migrated-<timestamp>.
 *
 * Idempotent: if both stores already exist and have schema_version set,
 * the migration is skipped and the legacy file is left in place.
 *
 * @param {string} envPath  Absolute path to the legacy .env file
 * @param {string} [dir]    State directory (MULTIMEDICA_STATE_DIR if omitted)
 * @returns {{ migrated: boolean, config?: object, secrets?: object, renamedTo?: string, reason?: string }}
 */
function migrateFromLegacyEnv(envPath, dir) {
  dir = dir || stateDir();

  if (!fs.existsSync(envPath)) {
    return { migrated: false, reason: "env file not found" };
  }

  const raw = fs.readFileSync(envPath, "utf8");
  const configResult = configStore.migrateFromEnvContent(raw, dir);
  const secretsResult = secretsStore.migrateFromEnvContent(raw, dir);

  const anyMigrated = configResult.migrated || secretsResult.migrated;
  if (!anyMigrated) {
    return {
      migrated: false,
      reason: "both stores already populated",
      config: configResult,
      secrets: secretsResult,
    };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const renamedTo = `${envPath}.migrated-${ts}`;
  fs.renameSync(envPath, renamedTo);

  return {
    migrated: true,
    config: configResult,
    secrets: secretsResult,
    renamedTo,
  };
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

module.exports = {
  readJson,
  writeJson,
  migrateFromLegacyEnv,
};
