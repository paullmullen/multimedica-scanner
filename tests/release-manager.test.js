"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const stateStore = require("../bootstrap/lib/state-store");
const { buildRelease } = require("../release/build-production-release");
const { createReleaseManager, CANDIDATE_PORT } = require("../bootstrap/lib/release-manager");

const ROOT = path.join(__dirname, "..");
const VERSION = "5.2.2-test";
const BUILT_AT = "2026-08-17T00:00:00.000Z";
const COMMIT = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mm-release-manager-"));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function schemaValidator() {
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, "schemas", "release-transaction.schema.json"), "utf8")
  );
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function fakeChild({ graceful = true } = {}) {
  const signals = [];
  return {
    pid: 4321,
    signals,
    kill(signal) {
      signals.push(signal);
    },
    async waitForExit() {
      return graceful;
    },
  };
}

function setup({
  commandRunner,
  processLauncher,
  healthRequester,
  isPortAvailable,
  artifactValidator,
} = {}) {
  const root = tempDir();
  const artifactDir = path.join(root, "artifact");
  const artifact = buildRelease({
    sourceDir: ROOT,
    outputDir: artifactDir,
    version: VERSION,
    builtAt: BUILT_AT,
    commit: COMMIT,
  });
  const calls = { commands: [], launches: [] };
  const manager = createReleaseManager({
    roots: { stateRoot: path.join(root, "state"), releaseRoot: path.join(root, "releases") },
    stateStore,
    artifactValidator,
    commandRunner:
      commandRunner ||
      (async (command, args, options) => {
        calls.commands.push({ command, args, options });
        return { code: 0 };
      }),
    processLauncher:
      processLauncher ||
      ((command, args, options) => {
        calls.launches.push({ command, args, options });
        return fakeChild();
      }),
    healthRequester:
      healthRequester ||
      (async () => ({ ok: true, service: "multimedica-production", state: "healthy" })),
    isPortAvailable: isPortAvailable || (async () => true),
    sleep: async () => {},
    clock: () => new Date(BUILT_AT),
    logger: () => {},
  });
  return { root, artifact, manager, calls };
}

function copyBootstrapRuntimeClosure(targetRoot) {
  const runtimeFiles = [
    "bootstrap/lib/release-manager.js",
    "bootstrap/lib/release-artifact.js",
    "bootstrap/lib/state-store.js",
    "bootstrap/lib/config-store.js",
    "bootstrap/lib/secrets-store.js",
    "schemas/release-manifest.schema.json",
    "schemas/release-transaction.schema.json",
  ];
  for (const relativePath of runtimeFiles) {
    const source = path.join(ROOT, relativePath);
    const destination = path.join(targetRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const nodeModules = path.join(ROOT, "node_modules");
  if (fs.existsSync(nodeModules)) {
    fs.symlinkSync(nodeModules, path.join(targetRoot, "node_modules"), "junction");
  }
}

function readTransaction(root, id) {
  return stateStore.readJson(`releases/transactions/${id}.json`, path.join(root, "state"));
}

describe("release manager local staging and candidate lifecycle", () => {
  let fixture;

  afterEach(() => {
    if (fixture) removeDir(fixture.root);
    fixture = null;
  });

  test("stages validated local artifact with only allowlisted runtime files", async () => {
    fixture = setup();
    const staged = await fixture.manager.stageArtifact({
      artifactPath: fixture.artifact.artifactPath,
      expectedSha256: fixture.artifact.sha256,
      version: VERSION,
    });
    expect(staged.stage).toBe("deps_installed");
    const transaction = readTransaction(fixture.root, staged.transactionId);
    expect(schemaValidator()(transaction)).toBe(true);
    expect(transaction.stages_completed).toEqual(
      expect.arrayContaining([
        "checksum_verified",
        "compatibility_verified",
        "extracted",
        "deps_installed",
      ])
    );
    expect(fs.existsSync(path.join(transaction.staging_dir, "production", "scan-server.js"))).toBe(
      true
    );
    expect(fs.existsSync(path.join(transaction.staging_dir, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(transaction.staging_dir, "secrets.json"))).toBe(false);
    expect(fixture.calls.commands).toEqual([
      {
        command: process.platform === "win32" ? "npm.cmd" : "npm",
        args: ["ci", "--omit=dev", "--ignore-scripts"],
        options: expect.objectContaining({ cwd: transaction.staging_dir, shell: false }),
      },
    ]);
  });

  test("rejects external hash, version, compatibility, unsafe entries, and duplicate version staging", async () => {
    fixture = setup();
    await expect(
      fixture.manager.stageArtifact({
        artifactPath: fixture.artifact.artifactPath,
        expectedSha256: "0".repeat(64),
        version: VERSION,
      })
    ).rejects.toThrow("external SHA-256");
    await expect(
      fixture.manager.stageArtifact({
        artifactPath: fixture.artifact.artifactPath,
        expectedSha256: fixture.artifact.sha256,
        version: "5.2.3-test",
      })
    ).rejects.toThrow("release version does not match manifest");

    const badValidator = () => ({
      manifest: { ...fixture.artifact.manifest, os_id: "debian-12-bookworm-arm64" },
      entries: [],
    });
    const badManager = createReleaseManager({
      roots: {
        stateRoot: path.join(fixture.root, "bad-state"),
        releaseRoot: path.join(fixture.root, "bad-release"),
      },
      stateStore,
      artifactValidator: badValidator,
      commandRunner: async () => ({ code: 0 }),
      isPortAvailable: async () => true,
    });
    await expect(
      badManager.stageArtifact({
        artifactPath: fixture.artifact.artifactPath,
        expectedSha256: fixture.artifact.sha256,
        version: VERSION,
      })
    ).rejects.toThrow("release compatibility contract is invalid");

    const unsafeValidator = () => ({
      manifest: fixture.artifact.manifest,
      entries: [{ path: "../escape", content: Buffer.from("x") }],
    });
    const unsafeManager = createReleaseManager({
      roots: {
        stateRoot: path.join(fixture.root, "unsafe-state"),
        releaseRoot: path.join(fixture.root, "unsafe-release"),
      },
      stateStore,
      artifactValidator: unsafeValidator,
      commandRunner: async () => ({ code: 0 }),
      isPortAvailable: async () => true,
    });
    await expect(
      unsafeManager.stageArtifact({
        artifactPath: fixture.artifact.artifactPath,
        expectedSha256: fixture.artifact.sha256,
        version: VERSION,
      })
    ).rejects.toThrow("validated artifact entry is unsafe");

    const staged = await fixture.manager.stageArtifact({
      artifactPath: fixture.artifact.artifactPath,
      expectedSha256: fixture.artifact.sha256,
      version: VERSION,
    });
    await expect(
      fixture.manager.stageArtifact({
        artifactPath: fixture.artifact.artifactPath,
        expectedSha256: fixture.artifact.sha256,
        version: VERSION,
      })
    ).rejects.toThrow("release version is already staged");
    expect(readTransaction(fixture.root, staged.transactionId).stage).toBe("deps_installed");
  });

  test("records dependency installation failure safely", async () => {
    fixture = setup({ commandRunner: async () => ({ code: 7 }) });
    await expect(
      fixture.manager.stageArtifact({
        artifactPath: fixture.artifact.artifactPath,
        expectedSha256: fixture.artifact.sha256,
        version: VERSION,
      })
    ).rejects.toThrow("release staging failed");
    const transactions = fs.readdirSync(
      path.join(fixture.root, "state", "releases", "transactions")
    );
    const transaction = readTransaction(fixture.root, path.basename(transactions[0], ".json"));
    expect(transaction.stage).toBe("failed");
    expect(JSON.stringify(transaction)).not.toContain("shared_secret");
  });

  test("starts a candidate on port 3003 with isolated environment and stops idempotently", async () => {
    const child = fakeChild();
    fixture = setup({
      processLauncher: (command, args, options) => {
        fixture.calls.launches.push({ command, args, options });
        return child;
      },
    });
    const staged = await fixture.manager.stageArtifact({
      artifactPath: fixture.artifact.artifactPath,
      expectedSha256: fixture.artifact.sha256,
      version: VERSION,
    });
    const candidate = await fixture.manager.startCandidate(staged.transactionId);
    expect(candidate).toMatchObject({
      port: CANDIDATE_PORT,
      pid: 4321,
      health: { ok: true, service: "multimedica-production", state: "healthy" },
    });
    const launch = fixture.calls.launches[0];
    expect(launch.args).toEqual([
      path.join(
        readTransaction(fixture.root, staged.transactionId).staging_dir,
        "production",
        "scan-server.js"
      ),
    ]);
    expect(launch.options).toMatchObject({
      shell: false,
      env: expect.objectContaining({
        PRODUCTION_PORT: "3003",
        MULTIMEDICA_DISABLE_BOOT_SYNC: "1",
        MULTIMEDICA_STATE_DIR: path.join(fixture.root, "state"),
      }),
    });
    expect(launch.options.env).not.toHaveProperty("SCANNER_SHARED_SECRET");
    expect(readTransaction(fixture.root, staged.transactionId).stage).toBe(
      "candidate_health_passed"
    );
    await fixture.manager.stopCandidate(staged.transactionId);
    await fixture.manager.stopCandidate(staged.transactionId);
    expect(child.signals).toContain("SIGTERM");
    expect(readTransaction(fixture.root, staged.transactionId).stage).toBe("candidate_stopped");
  });

  test("accepts only true healthy responses and rejects start-up failure states", async () => {
    const child = fakeChild();
    const failingHealth = setup({
      processLauncher: () => child,
      healthRequester: async () => ({
        ok: false,
        service: "multimedica-production",
        state: "starting",
      }),
    });
    const staged = await failingHealth.manager.stageArtifact({
      artifactPath: failingHealth.artifact.artifactPath,
      expectedSha256: failingHealth.artifact.sha256,
      version: VERSION,
    });
    await expect(failingHealth.manager.startCandidate(staged.transactionId)).rejects.toThrow(
      "candidate health check failed"
    );
    const transaction = readTransaction(failingHealth.root, staged.transactionId);
    expect(transaction.stage).toBe("failed");
    expect(transaction.error).toBe("candidate health failed");
    expect(transaction.candidate_pid).toBeNull();

    const healthyRuns = setup({
      processLauncher: () => child,
      healthRequester: async () => ({
        ok: true,
        service: "multimedica-production",
        state: "healthy",
      }),
    });
    const healthyStaged = await healthyRuns.manager.stageArtifact({
      artifactPath: healthyRuns.artifact.artifactPath,
      expectedSha256: healthyRuns.artifact.sha256,
      version: VERSION,
    });
    await expect(
      healthyRuns.manager.startCandidate(healthyStaged.transactionId)
    ).resolves.toMatchObject({ health: { ok: true, state: "healthy" } });

    const malformed = setup({
      processLauncher: () => child,
      healthRequester: async () => "not-json",
    });
    const malformedStaged = await malformed.manager.stageArtifact({
      artifactPath: malformed.artifact.artifactPath,
      expectedSha256: malformed.artifact.sha256,
      version: VERSION,
    });
    await expect(malformed.manager.startCandidate(malformedStaged.transactionId)).rejects.toThrow(
      "candidate health check failed"
    );

    const wrongService = setup({
      processLauncher: () => child,
      healthRequester: async () => ({ ok: true, service: "wrong-service", state: "healthy" }),
    });
    const wrongStaged = await wrongService.manager.stageArtifact({
      artifactPath: wrongService.artifact.artifactPath,
      expectedSha256: wrongService.artifact.sha256,
      version: VERSION,
    });
    await expect(wrongService.manager.startCandidate(wrongStaged.transactionId)).rejects.toThrow(
      "candidate health check failed"
    );
  });

  test("rejects occupied candidate port and health failure without touching port 3002", async () => {
    fixture = setup({ isPortAvailable: async (port) => port !== 3003 });
    const staged = await fixture.manager.stageArtifact({
      artifactPath: fixture.artifact.artifactPath,
      expectedSha256: fixture.artifact.sha256,
      version: VERSION,
    });
    await expect(fixture.manager.startCandidate(staged.transactionId)).rejects.toThrow(
      "candidate port 3003 is already occupied"
    );
    expect(fixture.calls.launches).toHaveLength(0);
  });

  test("loads successfully from an installation-shaped tree without a release directory", () => {
    const installationRoot = tempDir();
    try {
      copyBootstrapRuntimeClosure(installationRoot);
      expect(fs.existsSync(path.join(installationRoot, "release"))).toBe(false);
      const installRequire = Module.createRequire(
        path.join(installationRoot, "bootstrap", "lib", "release-manager.js")
      );
      const exported = installRequire("./release-manager");
      expect(typeof exported.createReleaseManager).toBe("function");
      expect(exported.CANDIDATE_PORT).toBe(3003);
    } finally {
      removeDir(installationRoot);
    }
  });

  test("uses forced stop fallback and abandons staging without current release mutation", async () => {
    const child = fakeChild({ graceful: false });
    fixture = setup({ processLauncher: () => child });
    const staged = await fixture.manager.stageArtifact({
      artifactPath: fixture.artifact.artifactPath,
      expectedSha256: fixture.artifact.sha256,
      version: VERSION,
    });
    await fixture.manager.startCandidate(staged.transactionId);
    await fixture.manager.abandonStaging(staged.transactionId);
    expect(child.signals).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
    const transaction = readTransaction(fixture.root, staged.transactionId);
    expect(transaction.stage).toBe("abandoned");
    expect(fs.existsSync(transaction.staging_dir)).toBe(false);
    expect(fs.existsSync(transaction.artifact_path)).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, "releases", "current"))).toBe(false);
  });
});
