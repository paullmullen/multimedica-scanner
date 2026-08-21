"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createController } = require("../bootstrap/controller");
const {
  createGateServiceController,
  runStartupRecovery,
  PRODUCTION_UNIT,
  GATE_PATH,
} = require("../bootstrap/release-startup-recovery");

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-startup-gate-"));
  const releaseRoot = path.join(root, "releases");
  const stateRoot = path.join(root, "state");
  const currentLink = path.join(root, "current");
  const gatePath = path.join(root, "run", "production-allowed");
  fs.mkdirSync(path.join(releaseRoot, "5.2.5-safe"), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  const calls = [];
  const stateStore = options.stateStore || {
    readJson: () => ({
      current_symlink: currentLink,
      current_dir: path.join(releaseRoot, "5.2.5-safe"),
      last_known_good_dir: path.join(releaseRoot, "5.2.5-safe"),
      current_version: "5.2.5-safe",
      last_known_good_version: "5.2.5-safe",
    }),
    writeJson: () => {},
  };
  fs.symlinkSync(path.join(releaseRoot, "5.2.5-safe"), currentLink, "junction");
  const manager = options.manager || {
    reconcileInterruptedPromotions: jest.fn().mockResolvedValue(options.outcomes || []),
    waitForProductionHealth: jest
      .fn()
      .mockResolvedValue({ ok: true, service: "multimedica-production", state: "healthy" }),
  };
  return {
    root,
    releaseRoot,
    stateRoot,
    currentLink,
    gatePath,
    stateStore,
    manager,
    calls,
    run: () =>
      runStartupRecovery({
        fs,
        path,
        stateStore,
        releaseManager: manager,
        releaseRoot,
        stateRoot,
        currentLink,
        gatePath,
        logger: options.logger,
        runSystemctl:
          options.runSystemctl ||
          (async (command, unit) => calls.push({ command, unit, gate: fs.existsSync(gatePath) })),
      }),
  };
}

function cleanup(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

describe("privileged production recovery gate", () => {
  let value;
  afterEach(() => {
    if (value) cleanup(value);
    value = null;
  });

  test("controller source has no recovery startup or systemctl integration", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "controller.js"),
      "utf8"
    );
    expect(source).not.toContain("reconcileInterruptedPromotions");
    expect(source).not.toContain("systemctl");
    expect(typeof createController).toBe("function");
  });

  test("ordinary safe boot removes then recreates gate before production restart", async () => {
    value = fixture();
    fs.mkdirSync(path.dirname(value.gatePath), { recursive: true });
    fs.writeFileSync(value.gatePath, "stale\n");
    await value.run();
    expect(value.calls).toEqual([
      { command: "stop", unit: PRODUCTION_UNIT, gate: false },
      { command: "restart", unit: PRODUCTION_UNIT, gate: true },
    ]);
    expect(fs.readFileSync(value.gatePath, "utf8")).toBe("allowed\n");
  });

  test("recoverable promotion creates gate before restarting production", async () => {
    value = fixture({ outcomes: [{ transactionId: "txn", stage: "complete" }] });
    await value.run();
    expect(value.calls).toEqual([
      { command: "stop", unit: PRODUCTION_UNIT, gate: false },
      { command: "restart", unit: PRODUCTION_UNIT, gate: true },
    ]);
  });

  test("production stop completes before reconciliation begins", async () => {
    value = fixture({
      manager: {
        reconcileInterruptedPromotions: jest.fn(async () => {
          value.calls.push({ command: "reconcile" });
          return [];
        }),
        waitForProductionHealth: jest.fn().mockResolvedValue({
          ok: true,
          service: "multimedica-production",
          state: "healthy",
        }),
      },
    });
    await value.run();
    expect(value.calls.map((call) => call.command)).toEqual(["stop", "reconcile", "restart"]);
  });

  test("initial production stop failure prevents reconciliation and never disables", async () => {
    const reconcile = jest.fn();
    value = fixture({
      manager: {
        reconcileInterruptedPromotions: reconcile,
        waitForProductionHealth: jest.fn(),
      },
      runSystemctl: async (command, unit) => {
        value.calls.push({ command, unit, gate: fs.existsSync(value.gatePath) });
        throw new Error("stop failed");
      },
    });
    await expect(value.run()).rejects.toThrow("release startup recovery failed");
    expect(reconcile).not.toHaveBeenCalled();
    expect(value.calls).toEqual([{ command: "stop", unit: PRODUCTION_UNIT, gate: false }]);
  });

  test.each(["first_activation_failed", "rollback_failed"])(
    "%s leaves gate absent and stops production",
    async (stage) => {
      value = fixture({ outcomes: [{ transactionId: "txn", stage }] });
      await expect(value.run()).rejects.toThrow("release startup recovery failed");
      expect(fs.existsSync(value.gatePath)).toBe(false);
      expect(value.calls).toEqual([{ command: "stop", unit: PRODUCTION_UNIT, gate: false }]);
    }
  );

  test("recovery errors stop production without exposing sensitive values", async () => {
    const logger = jest.fn();
    value = fixture({
      logger,
      manager: {
        reconcileInterruptedPromotions: jest
          .fn()
          .mockRejectedValue(new Error("fake-shared-secret fake-patient-barcode")),
        waitForProductionHealth: jest.fn(),
      },
    });
    await expect(value.run()).rejects.toThrow("release startup recovery failed");
    expect(logger.mock.calls.flat().join(" ")).not.toMatch(
      /fake-shared-secret|fake-patient-barcode/
    );
  });

  test("repeated recovery is idempotent", async () => {
    value = fixture();
    await value.run();
    await value.run();
    expect(value.calls).toHaveLength(4);
    expect(
      value.calls.filter((call) => call.command === "restart").every((call) => call.gate)
    ).toBe(true);
  });

  test("adapter never uses persistent disable and only accepts the exact unit", async () => {
    const adapterPath = path.join(os.tmpdir(), `mm-gate-${Date.now()}`);
    const calls = [];
    const adapter = createGateServiceController({
      gatePath: adapterPath,
      runSystemctl: async (command, unit) => calls.push({ command, unit }),
    });
    await adapter.enable();
    await adapter.disable();
    expect(calls).toEqual([{ command: "stop", unit: PRODUCTION_UNIT }]);
    expect(calls.some((call) => call.command === "disable")).toBe(false);
    expect(calls.every((call) => call.unit === "multimedica-production.service")).toBe(true);
  });

  test("production unit contains the exact volatile gate and remains unprivileged", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "systemd", "multimedica-production.service"),
      "utf8"
    );
    expect(source).toContain(`ConditionPathExists=${GATE_PATH}`);
    expect(source).toContain("User=multimedica_edge");
    expect(source).toContain("Group=multimedica_edge");
    expect(source).toContain(
      "ExecStart=/usr/bin/node /opt/multimedica-scanner/current/production/scan-server.js"
    );
    for (const relation of ["Before", "After", "Wants", "Requires", "BindsTo", "PartOf"]) {
      expect(source).not.toContain(`${relation}=multimedica-production.service`);
    }
  });

  test("recovery unit contains no production dependency edge", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "systemd", "multimedica-release-recovery.service"),
      "utf8"
    );
    for (const relation of ["Before", "After", "Wants", "Requires", "BindsTo", "PartOf"]) {
      expect(source).not.toContain(`${relation}=multimedica-production.service`);
    }
  });

  test("recovery unit is root-owned, oneshot, hardened, and has no caller arguments", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "systemd", "multimedica-release-recovery.service"),
      "utf8"
    );
    expect(source).toContain("Type=oneshot");
    expect(source).toContain("User=root");
    expect(source).toContain("Group=root");
    expect(source).toContain("RemainAfterExit=yes");
    expect(source).toContain("RuntimeDirectory=multimedica-scanner");
    expect(source).toContain("RuntimeDirectoryMode=0755");
    expect(source).toContain("ReadWritePaths=");
    expect(source).toContain("/run/multimedica-scanner");
    expect(source).toContain(
      "ExecStart=/usr/bin/node /opt/multimedica-scanner/bootstrap/release-startup-recovery.js"
    );
    expect(source).toContain("NoNewPrivileges=yes");
    expect(source).toContain("ProtectSystem=strict");
    expect(source).not.toMatch(/ExecStart=.*\s--/);
  });
});

describe("physical kiosk startup presentation", () => {
  test("keeps the panel blank until Chromium reports ready", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "start-kiosk.sh"),
      "utf8"
    );
    const blankAt = source.indexOf("xset dpms force off");
    const launchAt = source.indexOf('"$CHROMIUM_BIN"');
    const readyAt = source.indexOf('curl -fs "$CHROMIUM_READY_URL"');
    const revealAt = source.indexOf("xset dpms force on");
    expect(blankAt).toBeGreaterThan(-1);
    expect(launchAt).toBeGreaterThan(blankAt);
    expect(readyAt).toBeGreaterThan(launchAt);
    expect(revealAt).toBeGreaterThan(readyAt);
    expect(source).toContain("--remote-debugging-address=127.0.0.1");
    expect(source).toContain("--remote-debugging-port=9222");
    expect(source).toContain("xsetroot -solid black");
  });
});
