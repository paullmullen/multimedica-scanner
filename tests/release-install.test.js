"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");
const {
  parseArgs,
  claimArtifact,
  acquireLock,
  readYes,
  verifyProductionActivation,
} = require("../bootstrap/release-install");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mm-install-"));
}
function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

describe("simplified InstallRelease root operation", () => {
  let root;
  beforeEach(() => {
    root = tempDir();
  });
  afterEach(() => cleanup(root));

  test("accepts only fixed semantic version, basename, and literal SHA arguments", () => {
    expect(
      parseArgs([
        "--version",
        "1.2.3",
        "--artifact-name",
        "release.tgz",
        "--sha256",
        "a".repeat(64),
      ])
    ).toMatchObject({ version: "1.2.3", artifactName: "release.tgz" });
    expect(() =>
      parseArgs(["--version", "1.2", "--artifact-name", "release.tgz", "--sha256", "a".repeat(64)])
    ).toThrow();
    expect(() =>
      parseArgs([
        "--version",
        "1.2.3",
        "--artifact-name",
        "../release.tgz",
        "--sha256",
        "a".repeat(64),
      ])
    ).toThrow();
    expect(() =>
      parseArgs(["--version", "1.2.3", "--artifact-name", "release.tgz", "--sha256", "hash-file"])
    ).toThrow();
  });

  test("confirmation closes readline and pauses stdin after exact lowercase yes", async () => {
    const input = new PassThrough();
    input.unref = jest.fn();
    const output = new PassThrough();
    const confirmation = readYes(input, output);
    input.end("yes\n");
    await expect(confirmation).resolves.toBeUndefined();
    expect(output.read().toString()).toContain("CANDIDATO");
    expect(input.isPaused()).toBe(true);
    expect(input.unref).toHaveBeenCalledTimes(1);
  });

  test("production activation verifier checks link, version, gate, service, and health", async () => {
    const releaseDir = path.join(root, "releases", "1.2.3");
    const currentLink = "/opt/multimedica-scanner/current";
    const gatePath = "/run/multimedica-scanner/production-allowed";
    const fakeFs = {
      lstatSync: jest.fn((file) => {
        if (file === currentLink)
          return { isSymbolicLink: () => true };
        if (file === gatePath)
          return { isFile: () => true, isSymbolicLink: () => false };
        throw new Error("unexpected path");
      }),
      readlinkSync: jest.fn(() => releaseDir),
    };
    const isServiceActive = jest.fn(async () => true);
    const getJson = jest.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify({
        service: "multimedica-production",
        ok: true,
        state: "healthy",
      }),
    }));

    await expect(
      verifyProductionActivation(
        { version: "1.2.3", releaseDir },
        { fs: fakeFs, isServiceActive, getJson }
      )
    ).resolves.toEqual({ ok: true });
    expect(isServiceActive).toHaveBeenCalledWith("multimedica-production.service");
    expect(getJson).toHaveBeenCalledWith("http://127.0.0.1:3002/api/status");
  });

  test("production activation verifier rejects a mismatched version", async () => {
    const releaseDir = path.join(root, "releases", "1.2.4");
    const fakeFs = {
      lstatSync: jest.fn(() => ({ isSymbolicLink: () => true })),
      readlinkSync: jest.fn(() => releaseDir),
    };
    await expect(
      verifyProductionActivation(
        { version: "1.2.3", releaseDir },
        { fs: fakeFs }
      )
    ).rejects.toThrow("version");
  });

  test("claims an ordinary artifact atomically into a root-only operation directory", () => {
    const transfer = path.join(root, "transfer");
    const operation = path.join(root, "operation");
    fs.mkdirSync(transfer);
    fs.mkdirSync(operation);
    fs.writeFileSync(path.join(transfer, "release.tgz"), "artifact");
    const claimed = claimArtifact("release.tgz", transfer, operation);
    expect(fs.existsSync(path.join(transfer, "release.tgz"))).toBe(false);
    expect(fs.readFileSync(claimed, "utf8")).toBe("artifact");
    expect(fs.lstatSync(claimed).nlink).toBe(1);
    if (process.platform === "linux") expect(fs.statSync(claimed).mode & 0o777).toBe(0o600);
  });

  test("rejects a symlink through the filesystem metadata boundary", () => {
    const transfer = path.join(root, "transfer");
    const operation = path.join(root, "operation");
    fs.mkdirSync(transfer);
    fs.mkdirSync(operation);
    fs.writeFileSync(path.join(transfer, "release.tgz"), "artifact");
    const actualFs = fs;
    jest.resetModules();
    jest.doMock("fs", () => ({
      ...jest.requireActual("fs"),
      lstatSync(file) {
        if (file === path.join(transfer, "release.tgz"))
          return { isFile: () => true, isSymbolicLink: () => true, nlink: 1 };
        return actualFs.lstatSync(file);
      },
    }));
    try {
      const mocked = require("../bootstrap/release-install");
      expect(() => mocked.claimArtifact("release.tgz", transfer, operation)).toThrow("unsafe");
    } finally {
      jest.dontMock("fs");
      jest.resetModules();
    }
  });

  test("rejects hard-link claim mutation on the real filesystem", () => {
    const transfer = path.join(root, "transfer");
    const operation = path.join(root, "operation");
    fs.mkdirSync(transfer);
    fs.mkdirSync(operation);
    const source = path.join(transfer, "release.tgz");
    const target = path.join(transfer, "target.tgz");
    fs.writeFileSync(target, "target");
    fs.linkSync(target, source);
    expect(() => claimArtifact("release.tgz", transfer, operation)).toThrow("unsafe");
  });

  test("rejects post-claim replacement metadata", () => {
    const transfer = path.join(root, "transfer");
    const operation = path.join(root, "operation");
    fs.mkdirSync(transfer);
    fs.mkdirSync(operation);
    const source = path.join(transfer, "release.tgz");
    fs.writeFileSync(source, "artifact");
    const actualFs = fs;
    let claimLstat = false;
    jest.resetModules();
    jest.doMock("fs", () => ({
      ...jest.requireActual("fs"),
      lstatSync(file) {
        const result = actualFs.lstatSync(file);
        if (file === path.join(operation, `${process.pid}-release.tgz`)) {
          claimLstat = true;
          const mocked = Object.create(result);
          Object.defineProperty(mocked, "nlink", { value: 2 });
          return mocked;
        }
        return result;
      },
    }));
    try {
      const mocked = require("../bootstrap/release-install");
      expect(() => mocked.claimArtifact("release.tgz", transfer, operation)).toThrow("unsafe");
      expect(claimLstat).toBe(true);
    } finally {
      jest.dontMock("fs");
      jest.resetModules();
    }
  });

  test("rejects a concurrent active lock and reclaims a stale lock", () => {
    const operation = path.join(root, "operation");
    acquireLock(operation);
    expect(() => acquireLock(operation)).toThrow("another release installation is active");
    fs.writeFileSync(path.join(operation, "operation.lock"), "999999\n");
    expect(() => acquireLock(operation)).not.toThrow();
  });

  test("fixed launcher and sudoers restrict execution", () => {
    const launcher = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "bin", "multimedica-release-install"),
      "utf8"
    );
    const sudoers = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "sudoers", "multimedica-release-install"),
      "utf8"
    );
    expect(launcher).toContain(
      "exec /usr/bin/node /opt/multimedica-scanner/bootstrap/release-install.js"
    );
    expect(sudoers.trim()).toBe(
      "multimedica_edge ALL=(root) NOPASSWD: /usr/local/sbin/multimedica-release-install"
    );
  });

  test("installer installs fixed transfer/operation roots and validates sudoers", () => {
    const installer = fs.readFileSync(
      path.join(__dirname, "..", "bootstrap", "install-bootstrap.sh"),
      "utf8"
    );
    expect(installer).toContain('DATA_ROOT="/var/lib/multimedica-scanner"');
    expect(installer).toContain('TRANSFER_DIR="$DATA_ROOT/release-transfer"');
    expect(installer).toContain('OPERATION_DIR="$DATA_ROOT/release-operation"');
    expect(installer).toContain('chmod 0730 "$TRANSFER_DIR"');
    expect(installer).toContain('chmod 0700 "$OPERATION_DIR"');
    expect(installer).toContain("visudo -cf");
    expect(installer).not.toContain("multimedica-release-install.path");
    expect(installer).not.toContain("systemctl enable multimedica-release-install.service");
  });

  test("PowerShell uses one attached sudo -n operation and literal confirmation", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "provision-scanner.ps1"), "utf8");
    expect(source).toContain("Invoke-InteractiveRemote");
    expect(source).toContain("sudo -n $wrapper");
    expect(source).toContain("$answer -cne 'yes'");
    expect(source).not.toContain("release-install-submit.js");
    expect(source).not.toContain("awaiting_confirmation");
  });

  function operationFixture(overrides = {}) {
    const calls = [];
    const claimed = path.join(root, "operation", "claimed.tgz");
    fs.mkdirSync(path.dirname(claimed), { recursive: true });
    fs.writeFileSync(claimed, "claimed artifact");
    const manager = {
      stageArtifact: jest.fn(async () => {
        calls.push("stageArtifact");
        return { transactionId: "txn-1" };
      }),
      startCandidate: jest.fn(async () => {
        calls.push("startCandidate");
      }),
      promoteCandidate: jest.fn(async () => {
        calls.push("promoteCandidate");
        return { stage: "complete" };
      }),
      abandonStaging: jest.fn(async () => {
        calls.push("abandonStaging");
      }),
      readTransaction: jest.fn(() => ({ stage: overrides.transactionStage || "failed" })),
    };
    const controller = {
      preparePromotion: jest.fn(async () => calls.push("preparePromotion")),
      enable: jest.fn(),
      restart: jest.fn(),
      stop: jest.fn(),
      disable: jest.fn(),
    };
    return {
      calls,
      claimed,
      manager,
      controller,
      deps: {
        operationRoot: path.join(root, "operation"),
        transferRoot: path.join(root, "transfer"),
        acquireLock: jest.fn(() => calls.push("lock")),
        releaseLock: jest.fn(() => calls.push("unlock")),
        claimArtifact: jest.fn(() => {
          calls.push("claimArtifact");
          return claimed;
        }),
        createReleaseManager: jest.fn(() => manager),
        serviceController: () => controller,
        portAvailable: jest.fn(async () =>
          overrides.productionAvailable === undefined ? true : overrides.productionAvailable
        ),
        verifySyntheticState: jest.fn(async () => calls.push("syntheticState")),
        readYes: overrides.readYes || jest.fn(async () => calls.push("yes")),
        fs,
      },
    };
  }

  test("runOperation orchestrates first installation through one manager and cleans claim/lock", async () => {
    const fixture = operationFixture();
    await require("../bootstrap/release-install").runOperation(
      {
        version: "1.2.3",
        artifactName: "release.tgz",
        expectedSha256: require("crypto")
          .createHash("sha256")
          .update(fs.readFileSync(fixture.claimed))
          .digest("hex"),
      },
      fixture.deps
    );
    expect(fixture.calls).toEqual([
      "lock",
      "claimArtifact",
      "stageArtifact",
      "startCandidate",
      "syntheticState",
      "yes",
      "promoteCandidate",
      "unlock",
    ]);
    expect(fixture.deps.createReleaseManager).toHaveBeenCalledTimes(1);
    const managerDeps = fixture.deps.createReleaseManager.mock.calls[0][0];
    expect(managerDeps.postPromotionVerifier).toEqual(expect.any(Function));
    expect(managerDeps.rollbackVerifier).toBe(managerDeps.postPromotionVerifier);
    expect(fs.existsSync(fixture.claimed)).toBe(false);
  });

  test.each(["decline", "eof"])("runOperation %s never promotes and abandons", async (kind) => {
    const fixture = operationFixture({
      readYes: jest.fn(async () => {
        throw new Error("operator ended");
      }),
    });
    await expect(
      require("../bootstrap/release-install").runOperation(
        {
          version: "1.2.3",
          artifactName: "release.tgz",
          expectedSha256: require("crypto")
            .createHash("sha256")
            .update(fs.readFileSync(fixture.claimed))
            .digest("hex"),
        },
        fixture.deps
      )
    ).rejects.toThrow("release installation failed");
    expect(fixture.manager.promoteCandidate).not.toHaveBeenCalled();
    expect(fixture.manager.abandonStaging).toHaveBeenCalledTimes(1);
    expect(fixture.calls).toContain("unlock");
    expect(fs.existsSync(fixture.claimed)).toBe(false);
    void kind;
  });

  test("candidate failure leaves promotion and service control untouched", async () => {
    const fixture = operationFixture();
    fixture.manager.startCandidate.mockRejectedValue(new Error("candidate failed"));
    await expect(
      require("../bootstrap/release-install").runOperation(
        {
          version: "1.2.3",
          artifactName: "release.tgz",
          expectedSha256: require("crypto")
            .createHash("sha256")
            .update(fs.readFileSync(fixture.claimed))
            .digest("hex"),
        },
        fixture.deps
      )
    ).rejects.toThrow("release installation failed");
    expect(fixture.manager.promoteCandidate).not.toHaveBeenCalled();
    expect(fixture.controller.preparePromotion).not.toHaveBeenCalled();
  });

  test("upgrade validation reaches promotion only after authorization on the same manager", async () => {
    const fixture = operationFixture();
    await require("../bootstrap/release-install").runOperation(
      {
        version: "1.2.3",
        artifactName: "release.tgz",
        expectedSha256: require("crypto")
          .createHash("sha256")
          .update(fs.readFileSync(fixture.claimed))
          .digest("hex"),
      },
      fixture.deps
    );
    expect(fixture.calls.indexOf("syntheticState")).toBeLessThan(fixture.calls.indexOf("yes"));
    expect(fixture.calls.indexOf("yes")).toBeLessThan(fixture.calls.indexOf("promoteCandidate"));
    expect(fixture.deps.createReleaseManager).toHaveBeenCalledTimes(1);
  });

  test("runOperation does not expose injected sensitive dependency values", async () => {
    const fixture = operationFixture({
      readYes: jest.fn(async () => {
        throw new Error("secret barcode patient raw subprocess");
      }),
    });
    let error;
    try {
      await require("../bootstrap/release-install").runOperation(
        {
          version: "1.2.3",
          artifactName: "release.tgz",
          expectedSha256: require("crypto")
            .createHash("sha256")
            .update(fs.readFileSync(fixture.claimed))
            .digest("hex"),
        },
        fixture.deps
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).not.toMatch(/secret|barcode|patient|subprocess/);
  });
});
