"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const stateStore = require("../bootstrap/lib/state-store");
const { createReleaseManager } = require("../bootstrap/lib/release-manager");

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-recovery-"));
  const releaseRoot = path.join(root, "releases");
  const stateRoot = path.join(root, "state");
  const currentLink = path.join(root, "current");
  fs.mkdirSync(path.join(stateRoot, "releases", "transactions"), { recursive: true });
  fs.mkdirSync(path.join(releaseRoot, "staging"), { recursive: true });
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "schemas", "release-transaction.schema.json"), "utf8"));
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const writes = [];
  const calls = { service: [], health: [], verify: [], switches: [] };
  const store = {
    readJson: (name, dir) => stateStore.readJson(name, dir),
    writeJson: (name, value, dir) => {
      if (name.includes("transactions/")) expect(validate(value)).toBe(true);
      writes.push({ name, value: JSON.parse(JSON.stringify(value)) });
      return stateStore.writeJson(name, value, dir);
    },
  };
  const manager = createReleaseManager({
    roots: { stateRoot, releaseRoot, currentLink },
    stateStore: store,
    serviceController: {
      enable: async () => calls.service.push("enable"),
      restart: async () => calls.service.push("restart"),
      stop: async () => calls.service.push("stop"),
      disable: async () => calls.service.push("disable"),
    },
    productionHealthRequester: async (url) => {
      calls.health.push(url);
      return options.health || { statusCode: 200, body: { service: "multimedica-production", ok: true, state: "healthy" } };
    },
    postPromotionVerifier: async (value) => { calls.verify.push(value); return options.verify === undefined ? { ok: true } : options.verify; },
    rollbackVerifier: async () => ({ ok: true }),
    switchCurrent: (target, transactionId) => {
      calls.switches.push({ target, transactionId });
      const temporary = `${currentLink}.${transactionId}.tmp`;
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      fs.symlinkSync(target, temporary, "junction");
      if (fs.existsSync(currentLink)) fs.unlinkSync(currentLink);
      fs.renameSync(temporary, currentLink);
    },
    isPortAvailable: async () => true,
    sleep: async () => {},
    clock: () => new Date("2026-08-17T00:00:00.000Z"),
  });
  return { root, releaseRoot, stateRoot, currentLink, manager, calls, writes };
}

function transaction(value, stage, overrides = {}) {
  const txn = {
    txn_id: "recovery-txn",
    started_at: "2026-08-17T00:00:00.000Z",
    target_version: "5.2.4-recovery",
    stage,
    stages_completed: ["resolving", "candidate_health_passed", stage],
    artifact_path: null,
    staging_dir: path.join(value.releaseRoot, "staging", "recovery-txn"),
    candidate_pid: null,
    candidate_manifest: {
      version: "5.2.4-recovery",
      entry_point: "production/scan-server.js",
      candidate_port: 3003,
      os_id: "debian-13-trixie-arm64",
      arch: "arm64",
      capability_policy: "capability-qualified",
    },
    rollback_target: null,
    error: null,
    completed_at: null,
    ...overrides,
  };
  stateStore.writeJson(`releases/transactions/${txn.txn_id}.json`, txn, value.stateRoot);
  return txn;
}

function cleanup(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

describe("release promotion interruption recovery", () => {
  let value;
  afterEach(() => { if (value) cleanup(value); value = null; });

  test.each([
    ["promotion_started", "failed"],
    ["candidate_stopped", "failed"],
  ])("does not activate an interrupted pre-switch %s transaction", async (stage, expected) => {
    value = fixture();
    transaction(value, stage);
    const result = await value.manager.reconcileInterruptedPromotions();
    expect(result).toEqual([{ transactionId: "recovery-txn", stage: expected }]);
    expect(fs.existsSync(value.currentLink)).toBe(false);
    expect(value.calls.service).toEqual([]);
    expect(value.calls.switches).toEqual([]);
  });

  test("reconciles version rename by completing the switch and promotion checks", async () => {
    value = fixture();
    const versionDir = path.join(value.releaseRoot, "5.2.4-recovery");
    fs.mkdirSync(versionDir, { recursive: true });
    transaction(value, "version_dir_renamed", { rollback_target: null });
    const result = await value.manager.reconcileInterruptedPromotions();
    expect(result[0].stage).toBe("complete");
    expect(fs.realpathSync(value.currentLink)).toBe(versionDir);
    expect(value.calls.switches).toHaveLength(1);
    expect(value.calls.service).toEqual(["enable", "restart"]);
  });

  test.each(["symlink_updated", "production_started", "production_health_passed", "post_promotion_verified"])(
    "resumes %s without rewriting a valid immutable directory",
    async (stage) => {
      value = fixture();
      const versionDir = path.join(value.releaseRoot, "5.2.4-recovery");
      fs.mkdirSync(versionDir, { recursive: true });
      fs.symlinkSync(versionDir, value.currentLink, "junction");
      transaction(value, stage);
      const result = await value.manager.reconcileInterruptedPromotions();
      expect(result[0].stage).toBe("complete");
      expect(fs.existsSync(versionDir)).toBe(true);
      expect(value.calls.service).toContain("restart");
      expect(value.calls.switches).toEqual([]);
    }
  );

  test("finalizes known_good_promoted without rerunning service activation", async () => {
    value = fixture();
    const versionDir = path.join(value.releaseRoot, "5.2.4-recovery");
    fs.mkdirSync(versionDir, { recursive: true });
    fs.symlinkSync(versionDir, value.currentLink, "junction");
    transaction(value, "known_good_promoted");
    const result = await value.manager.reconcileInterruptedPromotions();
    expect(result[0].stage).toBe("complete");
    expect(value.calls.service).toEqual([]);
  });

  test("rejects outside current and leaves production disabled on unsafe reconciliation", async () => {
    value = fixture();
    const outside = path.join(value.root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, value.currentLink, "junction");
    transaction(value, "symlink_updated");
    const result = await value.manager.reconcileInterruptedPromotions();
    expect(result[0]).toEqual({ transactionId: "recovery-txn", stage: "first_activation_failed" });
    expect(value.calls.service).toContain("disable");
    expect(value.calls.switches).toEqual([]);
  });

  test("refuses stale promotion lock until reconciliation owns and clears it", async () => {
    value = fixture();
    fs.mkdirSync(path.join(value.releaseRoot, ".promotion-lock"));
    transaction(value, "promotion_started");
    const result = await value.manager.reconcileInterruptedPromotions();
    expect(result[0].stage).toBe("failed");
    expect(fs.existsSync(path.join(value.releaseRoot, ".promotion-lock"))).toBe(false);
  });

  test("does not touch completed, rolled back, or abandoned transactions", async () => {
    value = fixture();
    for (const stage of ["complete", "rolled_back", "abandoned", "failed", "rollback_failed"]) {
      const id = `recovery-${stage}`;
      transaction(value, stage, { txn_id: id, stages_completed: [stage] });
    }
    expect(await value.manager.reconcileInterruptedPromotions()).toEqual([]);
    expect(value.calls.service).toEqual([]);
  });
});
