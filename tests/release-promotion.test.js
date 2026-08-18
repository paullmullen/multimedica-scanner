"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const stateStore = require("../bootstrap/lib/state-store");
const { buildRelease } = require("../release/build-production-release");
const { createReleaseManager } = require("../bootstrap/lib/release-manager");

const ROOT = path.join(__dirname, "..");
const VERSION = "5.2.3-promotion";
const BUILT_AT = "2026-08-17T00:00:00.000Z";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mm-promotion-"));
}

function child(pid = 5001) {
  return { pid, signals: [], kill(signal) { this.signals.push(signal); }, async waitForExit() { return true; } };
}

function schemaCheck() {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schemas", "release-transaction.schema.json"), "utf8"));
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function fixture(options = {}) {
  const root = tempDir();
  const artifactDir = path.join(root, "artifact");
  const artifact = buildRelease({ sourceDir: ROOT, outputDir: artifactDir, version: VERSION, builtAt: BUILT_AT, commit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" });
  const releaseRoot = path.join(root, "releases");
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(releaseRoot, { recursive: true });
  const writes = [];
  const validTransaction = schemaCheck();
  const recordingStore = {
    readJson: (name, dir) => stateStore.readJson(name, dir),
    writeJson: (name, value, dir) => {
      if (name.includes("transactions/")) expect(validTransaction(value)).toBe(true);
      writes.push({ name, value: JSON.parse(JSON.stringify(value)) });
      return stateStore.writeJson(name, value, dir);
    },
  };
  const calls = { service: [], productionUrls: [], verifiers: [] };
  const candidate = child();
  const manager = createReleaseManager({
    roots: { stateRoot, releaseRoot, currentLink: path.join(root, "current") },
    stateStore: recordingStore,
    commandRunner: async () => ({ code: 0 }),
    processLauncher: () => candidate,
    healthRequester: async () => ({ service: "multimedica-production", ok: true, state: "healthy" }),
    productionHealthRequester: async (url) => {
      calls.productionUrls.push(url);
      const health = typeof options.productionHealth === "function" ? options.productionHealth() : options.productionHealth;
      return health || { statusCode: 200, body: { service: "multimedica-production", ok: true, state: "healthy" } };
    },
    postPromotionVerifier: async (value) => { calls.verifiers.push(value); return options.verifier === undefined ? { ok: true } : options.verifier; },
    rollbackVerifier: async () => options.rollbackVerifier === undefined ? { ok: true } : options.rollbackVerifier,
    switchCurrent: (target, transactionId) => {
      const temporary = path.join(path.dirname(path.join(root, "current")), `.current.${transactionId}.tmp`);
      fs.symlinkSync(target, temporary, "junction");
      if (fs.existsSync(path.join(root, "current"))) fs.unlinkSync(path.join(root, "current"));
      fs.renameSync(temporary, path.join(root, "current"));
    },
    serviceController: {
      enable: async () => calls.service.push("enable"),
      restart: async () => calls.service.push("restart"),
      stop: async () => calls.service.push("stop"),
      disable: async () => calls.service.push("disable"),
    },
    isPortAvailable: async () => true,
    sleep: async () => {},
    clock: () => new Date(BUILT_AT),
  });
  return { root, releaseRoot, stateRoot, artifact, manager, candidate, calls, writes };
}

async function stage(fixtureValue) {
  const staged = await fixtureValue.manager.stageArtifact({ artifactPath: fixtureValue.artifact.artifactPath, expectedSha256: fixtureValue.artifact.sha256, version: VERSION });
  await fixtureValue.manager.startCandidate(staged.transactionId);
  return staged.transactionId;
}

function cleanup(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

describe("release promotion and automatic rollback", () => {
  let value;
  afterEach(() => { if (value) cleanup(value); value = null; });

  test("blocks promotion before candidate health and promotes first activation atomically", async () => {
    value = fixture();
    const staged = await value.manager.stageArtifact({ artifactPath: value.artifact.artifactPath, expectedSha256: value.artifact.sha256, version: VERSION });
    await expect(value.manager.promoteCandidate(staged.transactionId)).rejects.toThrow("release promotion failed");
    const transaction = stateStore.readJson(`releases/transactions/${staged.transactionId}.json`, value.stateRoot);
    expect(transaction.stage).toBe("failed");

    const transactionId = await stage(value);
    const result = await value.manager.promoteCandidate(transactionId);
    expect(result.stage).toBe("complete");
    expect(fs.realpathSync(path.join(value.root, "current"))).toBe(path.join(value.releaseRoot, VERSION));
    expect(fs.existsSync(path.join(value.releaseRoot, VERSION))).toBe(true);
    expect(value.candidate.signals).toContain("SIGTERM");
    expect(value.calls.productionUrls).toEqual(["http://127.0.0.1:3002/api/status"]);
    expect(value.calls.service).toEqual(["enable", "restart"]);
    expect(stateStore.readJson("installed-version.json", value.stateRoot)).toMatchObject({ current_version: VERSION, last_known_good_version: VERSION });
  });

  test("replaces an existing release and restores it after production health failure", async () => {
    value = fixture({ productionHealth: () => value.calls.service.length <= 2
      ? { statusCode: 503, body: { service: "multimedica-production", ok: false, state: "starting" } }
      : { statusCode: 200, body: { service: "multimedica-production", ok: true, state: "healthy" } } });
    const previous = path.join(value.releaseRoot, "5.2.2-existing");
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, path.join(value.root, "current"), "junction");
    stateStore.writeJson("installed-version.json", { current_version: "5.2.2-existing", current_dir: previous, current_symlink: path.join(value.root, "current"), previous_version: null, previous_dir: null, last_known_good_version: "5.2.2-existing", last_known_good_dir: previous, last_activation_at: BUILT_AT, last_activation_txn: "old" }, value.stateRoot);
    const transactionId = await stage(value);
    await expect(value.manager.promoteCandidate(transactionId)).rejects.toThrow("rolled back");
    expect(fs.realpathSync(path.join(value.root, "current"))).toBe(previous);
    expect(value.calls.service).toContain("stop");
    expect(value.calls.service).toContain("restart");
    expect(stateStore.readJson("installed-version.json", value.stateRoot).current_version).toBe("5.2.2-existing");
    expect(stateStore.readJson(`releases/transactions/${transactionId}.json`, value.stateRoot).stage).toBe("rolled_back");
  });

  test("rejects wrong production port, missing verifier, and outside current target", async () => {
    value = fixture({ productionHealth: { statusCode: 200, body: { service: "multimedica-production", ok: true, state: "healthy" } }, verifier: { ok: false } });
    const transactionId = await stage(value);
    await expect(value.manager.promoteCandidate(transactionId)).rejects.toThrow("rolled back");
    expect(value.calls.productionUrls.every((url) => url.includes(":3002/"))).toBe(true);

    cleanup(value);
    value = fixture();
    fs.symlinkSync(path.dirname(value.releaseRoot), path.join(value.root, "current"), "junction");
    const outsideId = await stage(value);
    await expect(value.manager.promoteCandidate(outsideId)).rejects.toThrow("release promotion failed");
    expect(value.calls.service).toEqual([]);
  });

  test("disables production on first activation failure and records rollback_failed when restoration fails", async () => {
    value = fixture({ verifier: { ok: false } });
    const firstId = await stage(value);
    await expect(value.manager.promoteCandidate(firstId)).rejects.toThrow("release promotion rolled back");
    expect(value.calls.service).toContain("disable");
    expect(stateStore.readJson(`releases/transactions/${firstId}.json`, value.stateRoot).stage).toBe("first_activation_failed");

    cleanup(value);
    value = fixture({ verifier: { ok: false }, rollbackVerifier: { ok: false } });
    const previous = path.join(value.releaseRoot, "5.2.2-existing");
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, path.join(value.root, "current"), "junction");
    const failedId = await stage(value);
    await expect(value.manager.promoteCandidate(failedId)).rejects.toThrow("rollback failed");
    expect(value.calls.service).toContain("disable");
    expect(stateStore.readJson(`releases/transactions/${failedId}.json`, value.stateRoot).stage).toBe("rollback_failed");
  });
});
