"use strict";

/**
 * State Store Tests
 *
 * Tests:
 * - config-store: atomic write, backup rotation, migration from env content
 * - secrets-store: atomic write, backup rotation, migration from env content,
 *                  getAdminToken isolation
 * - state-store: readJson, writeJson, combined migrateFromLegacyEnv
 * - JSON Schema validation: config.schema.json and secrets.schema.json
 *   accept valid documents and reject known-bad inputs using AJV
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const configStore = require("../bootstrap/lib/config-store");
const secretsStore = require("../bootstrap/lib/secrets-store");
const stateStore = require("../bootstrap/lib/state-store");

// ---------------------------------------------------------------------------
// AJV schema validation helpers
// ---------------------------------------------------------------------------

let Ajv, addFormats;
let ajvAvailable = false;

try {
  Ajv = require("ajv");
  addFormats = require("ajv-formats");
  ajvAvailable = true;
} catch {
  // ajv not installed yet; schema tests will be skipped
}

function makeValidator() {
  if (!ajvAvailable) return null;
  const ajv = new Ajv.default({ strict: false, allErrors: true });
  addFormats.default(ajv);
  return ajv;
}

function loadSchema(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "schemas", name), "utf8"));
}

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mm-test-"));
}

function rmTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// config-store tests
// ---------------------------------------------------------------------------

describe("config-store", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmTempDir(tmpDir);
  });

  test("readConfig returns null when file does not exist", () => {
    expect(configStore.readConfig(tmpDir)).toBeNull();
  });

  test("writeConfig creates config.json atomically", () => {
    const written = configStore.writeConfig(
      { commissioning_state: "bootstrap_installed", room_id: "r1" },
      tmpDir
    );

    expect(written.commissioning_state).toBe("bootstrap_installed");
    expect(written.room_id).toBe("r1");
    expect(written.schema_version).toBe(1);
    expect(written.updated_at).toBeTruthy();

    // File should exist and be readable
    const onDisk = configStore.readConfig(tmpDir);
    expect(onDisk).toEqual(written);

    // No leftover .tmp file
    expect(fs.existsSync(path.join(tmpDir, "config.json.tmp"))).toBe(false);
  });

  test("writeConfig merges into existing config", () => {
    configStore.writeConfig({ room_id: "r1" }, tmpDir);
    configStore.writeConfig({ station_id: "s1" }, tmpDir);

    const onDisk = configStore.readConfig(tmpDir);
    expect(onDisk.room_id).toBe("r1");
    expect(onDisk.station_id).toBe("s1");
  });

  test("writeConfig backs up existing file before overwrite", () => {
    configStore.writeConfig({ room_id: "original" }, tmpDir);
    configStore.writeConfig({ room_id: "updated" }, tmpDir);

    const backupFiles = fs.readdirSync(path.join(tmpDir, "backups"));
    expect(backupFiles.length).toBeGreaterThanOrEqual(1);
    expect(backupFiles.some((f) => f.startsWith("config.json."))).toBe(true);
  });

  test("backup rotation keeps at most 5 backups", () => {
    for (let i = 0; i < 8; i++) {
      configStore.writeConfig({ counter: i }, tmpDir);
    }

    const backupFiles = fs
      .readdirSync(path.join(tmpDir, "backups"))
      .filter((f) => f.startsWith("config.json."));
    expect(backupFiles.length).toBeLessThanOrEqual(5);
  });

  test("_parseEnv handles quoted values and comments", () => {
    const raw = `
# comment
ROOM_ID=room1
STATION_ID="station 1"
DEVICE_ID='device-1'
EMPTY=
`.trim();
    const env = configStore._parseEnv(raw);
    expect(env.ROOM_ID).toBe("room1");
    expect(env.STATION_ID).toBe("station 1");
    expect(env.DEVICE_ID).toBe("device-1");
    expect(env.EMPTY).toBe("");
  });

  test("migrateFromEnvContent writes non-secret keys to config.json", () => {
    const raw = `
ENDPOINT_URL=https://example.invalid/fn
LOCATION_ID=loc1
ROOM_ID=room1
STATION_ID=nursing
DEVICE_ID=scanner01
SHARED_SECRET=should-not-appear-in-config
SCANNER_QR_ADMIN_TOKEN=should-not-appear-in-config
`.trim();

    const result = configStore.migrateFromEnvContent(raw, tmpDir);
    expect(result.migrated).toBe(true);
    expect(result.keys).toContain("endpoint_url");
    expect(result.keys).toContain("location_id");
    expect(result.keys).toContain("room_id");

    const config = configStore.readConfig(tmpDir);
    expect(config.endpoint_url).toBe("https://example.invalid/fn");
    expect(config.location_id).toBe("loc1");

    // Secrets must never end up in config.json
    expect(config).not.toHaveProperty("qr_admin_token");
    expect(config).not.toHaveProperty("shared_secret");
    expect(JSON.stringify(config)).not.toContain("should-not-appear-in-config");
  });

  test("migrateFromEnvContent skips when config.json already exists", () => {
    configStore.writeConfig({ room_id: "existing" }, tmpDir);
    const result = configStore.migrateFromEnvContent("ROOM_ID=new", tmpDir);
    expect(result.migrated).toBe(false);

    const config = configStore.readConfig(tmpDir);
    expect(config.room_id).toBe("existing");
  });
});

// ---------------------------------------------------------------------------
// secrets-store tests
// ---------------------------------------------------------------------------

describe("secrets-store", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    delete process.env.SCANNER_QR_ADMIN_TOKEN;
    delete process.env.MULTIMEDICA_STATE_DIR;
  });

  afterEach(() => {
    rmTempDir(tmpDir);
    delete process.env.SCANNER_QR_ADMIN_TOKEN;
    delete process.env.MULTIMEDICA_STATE_DIR;
  });

  test("readSecrets returns null when file does not exist", () => {
    expect(secretsStore.readSecrets(tmpDir)).toBeNull();
  });

  test("getAdminToken returns null when secrets.json does not exist", () => {
    expect(secretsStore.getAdminToken(tmpDir)).toBeNull();
  });

  test("getAdminToken returns null even if env var is set", () => {
    process.env.SCANNER_QR_ADMIN_TOKEN = "env-token";
    expect(secretsStore.getAdminToken(tmpDir)).toBeNull();
  });

  test("writeSecrets creates secrets.json atomically", () => {
    secretsStore.writeSecrets({ qr_admin_token: "test-token" }, tmpDir);

    const onDisk = secretsStore.readSecrets(tmpDir);
    expect(onDisk.qr_admin_token).toBe("test-token");
    expect(onDisk.schema_version).toBe(1);

    // No leftover .tmp
    expect(fs.existsSync(path.join(tmpDir, "secrets.json.tmp"))).toBe(false);
  });

  test("getAdminToken reads from secrets.json, not from env", () => {
    process.env.SCANNER_QR_ADMIN_TOKEN = "env-token-should-be-ignored";
    secretsStore.writeSecrets({ qr_admin_token: "file-token" }, tmpDir);

    expect(secretsStore.getAdminToken(tmpDir)).toBe("file-token");
  });

  test("writeSecrets merges into existing secrets", () => {
    secretsStore.writeSecrets({ qr_admin_token: "tok" }, tmpDir);
    secretsStore.writeSecrets({ shared_secret: "sec" }, tmpDir);

    const onDisk = secretsStore.readSecrets(tmpDir);
    expect(onDisk.qr_admin_token).toBe("tok");
    expect(onDisk.shared_secret).toBe("sec");
  });

  test("writeSecrets backs up existing file before overwrite", () => {
    secretsStore.writeSecrets({ qr_admin_token: "v1" }, tmpDir);
    secretsStore.writeSecrets({ qr_admin_token: "v2" }, tmpDir);

    const backups = fs.readdirSync(path.join(tmpDir, "backups"));
    expect(backups.some((f) => f.startsWith("secrets.json."))).toBe(true);
  });

  test("SECRET_KEYS exports the list of protected key names", () => {
    expect(secretsStore.SECRET_KEYS).toContain("qr_admin_token");
    expect(secretsStore.SECRET_KEYS).toContain("shared_secret");
    expect(secretsStore.SECRET_KEYS).toContain("wifi_password");
  });

  test("migrateFromEnvContent extracts secret keys", () => {
    const raw = `
SCANNER_QR_ADMIN_TOKEN=test-token-value
SHARED_SECRET=test-shared-value
ROOM_ID=should-not-be-here
`.trim();

    const result = secretsStore.migrateFromEnvContent(raw, tmpDir);
    expect(result.migrated).toBe(true);
    expect(result.keysPresent).toContain("qr_admin_token");
    expect(result.keysPresent).toContain("shared_secret");
    // Result must not contain values, only key names
    expect(JSON.stringify(result)).not.toContain("test-token-value");
    expect(JSON.stringify(result)).not.toContain("test-shared-value");

    const secrets = secretsStore.readSecrets(tmpDir);
    expect(secrets.qr_admin_token).toBe("test-token-value");
    expect(secrets.shared_secret).toBe("test-shared-value");
    // Non-secret keys must not appear
    expect(secrets).not.toHaveProperty("room_id");
  });

  test("migrateFromEnvContent skips when secrets.json already exists", () => {
    secretsStore.writeSecrets({ qr_admin_token: "original" }, tmpDir);
    const result = secretsStore.migrateFromEnvContent("SCANNER_QR_ADMIN_TOKEN=new-value", tmpDir);
    expect(result.migrated).toBe(false);

    const secrets = secretsStore.readSecrets(tmpDir);
    expect(secrets.qr_admin_token).toBe("original");
  });
});

// ---------------------------------------------------------------------------
// state-store: readJson / writeJson
// ---------------------------------------------------------------------------

describe("state-store readJson / writeJson", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmTempDir(tmpDir);
  });

  test("readJson returns null for missing file", () => {
    expect(stateStore.readJson("runtime.json", tmpDir)).toBeNull();
  });

  test("writeJson creates the file and returns content", () => {
    const content = { status: "ok", version: "1.0.0" };
    const written = stateStore.writeJson("runtime.json", content, tmpDir);

    expect(written).toEqual(content);
    const onDisk = stateStore.readJson("runtime.json", tmpDir);
    expect(onDisk).toEqual(content);
  });

  test("writeJson backs up existing file", () => {
    stateStore.writeJson("installed-version.json", { current_version: "v1" }, tmpDir);
    stateStore.writeJson("installed-version.json", { current_version: "v2" }, tmpDir);

    const backups = fs.readdirSync(path.join(tmpDir, "backups"));
    expect(backups.some((f) => f.startsWith("installed-version.json."))).toBe(true);
  });

  test("no leftover .tmp files after writeJson", () => {
    stateStore.writeJson("runtime.json", { x: 1 }, tmpDir);
    expect(fs.existsSync(path.join(tmpDir, "runtime.json.tmp"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// state-store: migrateFromLegacyEnv
// ---------------------------------------------------------------------------

describe("state-store migrateFromLegacyEnv", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmTempDir(tmpDir);
  });

  test("returns migrated:false when env file does not exist", () => {
    const result = stateStore.migrateFromLegacyEnv(path.join(tmpDir, "nonexistent.env"), tmpDir);
    expect(result.migrated).toBe(false);
  });

  test("migrates both config and secrets from legacy .env", () => {
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "ENDPOINT_URL=https://example.invalid/fn",
        "SHARED_SECRET=test-shared-value",
        "SCANNER_QR_ADMIN_TOKEN=test-admin-token",
        "ROOM_ID=room1",
        "STATION_ID=station1",
        "DEVICE_ID=device1",
        "LOCATION_ID=loc1",
      ].join("\n")
    );

    const result = stateStore.migrateFromLegacyEnv(envPath, tmpDir);
    expect(result.migrated).toBe(true);

    // Legacy file is renamed
    expect(fs.existsSync(envPath)).toBe(false);
    expect(result.renamedTo).toMatch(/\.migrated-/);
    expect(fs.existsSync(result.renamedTo)).toBe(true);

    // Non-secret values in config.json
    const config = configStore.readConfig(tmpDir);
    expect(config.endpoint_url).toBe("https://example.invalid/fn");
    expect(config.room_id).toBe("room1");

    // Secret values in secrets.json
    const secrets = secretsStore.readSecrets(tmpDir);
    expect(secrets.qr_admin_token).toBe("test-admin-token");
    expect(secrets.shared_secret).toBe("test-shared-value");

    // Secrets not in config.json
    expect(JSON.stringify(config)).not.toContain("test-admin-token");
    expect(JSON.stringify(config)).not.toContain("test-shared-value");
  });

  test("skips migration when both stores already populated", () => {
    configStore.writeConfig({ room_id: "existing" }, tmpDir);
    secretsStore.writeSecrets({ qr_admin_token: "existing-token" }, tmpDir);

    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "ROOM_ID=new\nSCANNER_QR_ADMIN_TOKEN=new-token\n");

    const result = stateStore.migrateFromLegacyEnv(envPath, tmpDir);
    expect(result.migrated).toBe(false);

    // Original values preserved
    expect(configStore.readConfig(tmpDir).room_id).toBe("existing");
    expect(secretsStore.readSecrets(tmpDir).qr_admin_token).toBe("existing-token");

    // Legacy file not renamed
    expect(fs.existsSync(envPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// config-store: writeConfig schema validation (pre-write guard)
// ---------------------------------------------------------------------------

describe("config-store write validation", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmTempDir(tmpDir);
  });

  test("valid write with commissioning_state succeeds", () => {
    const result = configStore.writeConfig({ commissioning_state: "bootstrap_installed" }, tmpDir);
    expect(result.commissioning_state).toBe("bootstrap_installed");
    expect(configStore.readConfig(tmpDir)).toBeTruthy();
  });

  test("invalid commissioning_state throws CONFIG_VALIDATION_ERROR", () => {
    expect(() =>
      configStore.writeConfig({ commissioning_state: "not_a_real_state" }, tmpDir)
    ).toThrow(expect.objectContaining({ code: "CONFIG_VALIDATION_ERROR" }));
  });

  test("invalid write leaves authoritative file unchanged", () => {
    // Write a valid config first so there is an authoritative file
    configStore.writeConfig({ commissioning_state: "bootstrap_installed", room_id: "r1" }, tmpDir);
    const before = configStore.readConfig(tmpDir);

    // Attempt an invalid write
    expect(() => configStore.writeConfig({ commissioning_state: "bogus" }, tmpDir)).toThrow();

    // Authoritative file is unchanged
    expect(configStore.readConfig(tmpDir)).toEqual(before);
  });

  test("invalid write leaves backup set unchanged", () => {
    configStore.writeConfig({ commissioning_state: "bootstrap_installed" }, tmpDir);
    // One more valid write to populate backups
    configStore.writeConfig({ commissioning_state: "operational" }, tmpDir);
    const backupsBefore = fs.existsSync(path.join(tmpDir, "backups"))
      ? fs.readdirSync(path.join(tmpDir, "backups")).filter((f) => f.startsWith("config.json."))
          .length
      : 0;

    // Invalid write must not add a backup
    expect(() => configStore.writeConfig({ commissioning_state: "bogus" }, tmpDir)).toThrow();

    const backupsAfter = fs.existsSync(path.join(tmpDir, "backups"))
      ? fs.readdirSync(path.join(tmpDir, "backups")).filter((f) => f.startsWith("config.json."))
          .length
      : 0;
    expect(backupsAfter).toBe(backupsBefore);
  });

  test("no .tmp file is left after an invalid write attempt", () => {
    expect(() => configStore.writeConfig({ commissioning_state: "bogus" }, tmpDir)).toThrow();
    expect(fs.existsSync(path.join(tmpDir, "config.json.tmp"))).toBe(false);
  });

  test("validation error message contains field path and reason", () => {
    let caughtErr;
    try {
      configStore.writeConfig({ commissioning_state: "bogus" }, tmpDir);
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeDefined();
    expect(caughtErr.message).toMatch(/commissioning_state/);
    expect(caughtErr.validationErrors).toBeInstanceOf(Array);
    expect(caughtErr.validationErrors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// secrets-store: writeSecrets schema validation (pre-write guard)
// ---------------------------------------------------------------------------

describe("secrets-store write validation", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmTempDir(tmpDir);
  });

  test("valid write with qr_admin_token succeeds", () => {
    const result = secretsStore.writeSecrets({ qr_admin_token: "test-token" }, tmpDir);
    expect(result.ok).toBe(true);
    expect(secretsStore.readSecrets(tmpDir).qr_admin_token).toBe("test-token");
  });

  test("write missing qr_admin_token on fresh store throws SECRETS_VALIDATION_ERROR", () => {
    // No existing secrets.json — merged object will lack qr_admin_token
    expect(() => secretsStore.writeSecrets({ shared_secret: "only-a-secret" }, tmpDir)).toThrow(
      expect.objectContaining({ code: "SECRETS_VALIDATION_ERROR" })
    );
  });

  test("invalid write leaves authoritative file unchanged", () => {
    secretsStore.writeSecrets({ qr_admin_token: "tok" }, tmpDir);
    const before = secretsStore.readSecrets(tmpDir);

    // qr_admin_token: null violates "type": "string" after the merge
    expect(() => secretsStore.writeSecrets({ qr_admin_token: null }, tmpDir)).toThrow();

    expect(secretsStore.readSecrets(tmpDir)).toEqual(before);
  });

  test("invalid write leaves backup set unchanged", () => {
    secretsStore.writeSecrets({ qr_admin_token: "tok" }, tmpDir);
    secretsStore.writeSecrets({ qr_admin_token: "tok2" }, tmpDir);
    const backupsBefore = fs
      .readdirSync(path.join(tmpDir, "backups"))
      .filter((f) => f.startsWith("secrets.json.")).length;

    // qr_admin_token: null violates "type": "string" — backup must not be created
    expect(() => secretsStore.writeSecrets({ qr_admin_token: null }, tmpDir)).toThrow();

    const backupsAfter = fs
      .readdirSync(path.join(tmpDir, "backups"))
      .filter((f) => f.startsWith("secrets.json.")).length;
    expect(backupsAfter).toBe(backupsBefore);
  });

  test("validation error never contains a secret value", () => {
    // Write valid secrets first so existing values are in the store
    secretsStore.writeSecrets({ qr_admin_token: "super-secret-tok" }, tmpDir);

    let caughtErr;
    try {
      // additionalProperties:false rejects an unknown field; the error path
      // references the field name only, not any secret value
      secretsStore.writeSecrets(
        { qr_admin_token: "super-secret-tok", forbidden_extra_field: "evil" },
        tmpDir
      );
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeDefined();
    // The error must not echo back the secret value
    expect(caughtErr.message).not.toContain("super-secret-tok");
    if (caughtErr.validationErrors) {
      expect(JSON.stringify(caughtErr.validationErrors)).not.toContain("super-secret-tok");
    }
  });
});

// ---------------------------------------------------------------------------
// JSON Schema validation (requires ajv + ajv-formats)
// ---------------------------------------------------------------------------

const maybeDescribe = ajvAvailable ? describe : describe.skip;

maybeDescribe("JSON Schema validation", () => {
  // A fresh AJV instance per test avoids "schema already exists" errors
  // that occur when the same $id is compiled twice in one AJV instance.
  function freshValidate(schemaName) {
    const av = makeValidator();
    const schema = loadSchema(schemaName);
    return av.compile(schema);
  }

  test("config.schema.json compiles without error", () => {
    expect(() => freshValidate("config.schema.json")).not.toThrow();
  });

  test("secrets.schema.json compiles without error", () => {
    expect(() => freshValidate("secrets.schema.json")).not.toThrow();
  });

  test("config.schema.json validates a good config document", () => {
    const validate = freshValidate("config.schema.json");
    const good = {
      schema_version: 1,
      bootstrap_version: "1.0.0",
      commissioning_state: "bootstrap_installed",
      updated_at: "2026-08-11T10:00:00Z",
    };
    expect(validate(good)).toBe(true);
  });

  test("config.schema.json rejects missing commissioning_state", () => {
    const validate = freshValidate("config.schema.json");
    const bad = { schema_version: 1, bootstrap_version: "1.0.0" };
    expect(validate(bad)).toBe(false);
  });

  test("config.schema.json rejects invalid commissioning_state value", () => {
    const validate = freshValidate("config.schema.json");
    const bad = {
      schema_version: 1,
      bootstrap_version: "1.0.0",
      commissioning_state: "invalid_state",
    };
    expect(validate(bad)).toBe(false);
  });

  test("secrets.schema.json validates a good secrets document", () => {
    const validate = freshValidate("secrets.schema.json");
    const good = {
      schema_version: 1,
      qr_admin_token: "test-token",
      updated_at: "2026-08-11T10:00:00Z",
    };
    expect(validate(good)).toBe(true);
  });

  test("secrets.schema.json rejects missing qr_admin_token", () => {
    const validate = freshValidate("secrets.schema.json");
    const bad = { schema_version: 1 };
    expect(validate(bad)).toBe(false);
  });

  test("all 15 schema files parse as valid JSON", () => {
    const schemaDir = path.join(__dirname, "..", "schemas");
    const files = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"));
    expect(files.length).toBe(15);
    for (const file of files) {
      expect(() => JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"))).not.toThrow();
    }
  });

  test("all 15 schema files compile with AJV without error", () => {
    const schemaDir = path.join(__dirname, "..", "schemas");
    const files = fs.readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json"));
    for (const file of files) {
      const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"));
      const av = makeValidator();
      expect(() => av.compile(schema)).not.toThrow();
    }
  });
});
