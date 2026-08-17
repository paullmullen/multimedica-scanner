"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  ALLOWLIST,
  buildRelease,
  createDeterministicTgz,
  validateArtifact,
  validateManifest,
} = require("../release/build-production-release");

const ROOT = path.join(__dirname, "..");
const VERSION = "5.2.1-test";
const BUILT_AT = "2026-08-17T00:00:00.000Z";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mm-release-"));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyRuntimeClosure(target, omit) {
  for (const relativePath of ALLOWLIST) {
    if (relativePath === omit) continue;
    const destination = path.join(target, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relativePath), destination);
  }
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("deterministic production release artifact", () => {
  let outputOne;
  let outputTwo;

  beforeEach(() => {
    outputOne = tempDir();
    outputTwo = tempDir();
  });

  afterEach(() => {
    removeDir(outputOne);
    removeDir(outputTwo);
  });

  test("builds byte-identical artifacts and matching external hashes", () => {
    const options = { sourceDir: ROOT, version: VERSION, builtAt: BUILT_AT, commit: COMMIT };
    const first = buildRelease({ ...options, outputDir: outputOne });
    const second = buildRelease({ ...options, outputDir: outputTwo });

    expect(fs.readFileSync(first.artifactPath).equals(fs.readFileSync(second.artifactPath))).toBe(
      true
    );
    expect(first.sha256).toBe(second.sha256);
    expect(hashFile(first.artifactPath)).toBe(first.sha256);
    expect(fs.readFileSync(first.hashPath, "utf8")).toContain(first.sha256);
    expect(JSON.parse(fs.readFileSync(first.reportPath, "utf8")).sha256).toBe(first.sha256);
  });

  test("produces a schema-valid capability-based arm64 Trixie manifest", () => {
    const result = buildRelease({
      sourceDir: ROOT,
      outputDir: outputOne,
      version: VERSION,
      builtAt: BUILT_AT,
      commit: COMMIT,
    });
    expect(result.manifest).toMatchObject({
      version: VERSION,
      entry_point: "production/scan-server.js",
      candidate_port: 3003,
      arch: "arm64",
      os_id: "debian-13-trixie-arm64",
      capability_policy: "capability-qualified",
    });
    expect(result.manifest).not.toHaveProperty("pi_model");
    expect(() => validateManifest({ ...result.manifest, candidate_port: 3002 })).toThrow();
    expect(() =>
      validateManifest({ ...result.manifest, os_id: "debian-12-bookworm-arm64" })
    ).toThrow();
  });

  test("contains exactly the explicit runtime dependency closure", () => {
    const result = buildRelease({
      sourceDir: ROOT,
      outputDir: outputOne,
      version: VERSION,
      builtAt: BUILT_AT,
      commit: COMMIT,
    });
    const checked = validateArtifact(fs.readFileSync(result.artifactPath), result.sha256);
    expect(checked.files.map((file) => file.path)).toEqual(ALLOWLIST.slice().sort());
    const joined = checked.files.map((file) => file.path).join("\n");
    expect(joined).not.toMatch(
      /\.env|secrets\.json|config\.json|node_modules|fixtures|\.git|stable-channel/i
    );
  });

  test("fails when a required runtime dependency is missing", () => {
    const source = tempDir();
    try {
      copyRuntimeClosure(source, "bootstrap/lib/secrets-store.js");
      expect(() =>
        buildRelease({
          sourceDir: source,
          outputDir: outputOne,
          version: VERSION,
          builtAt: BUILT_AT,
          commit: COMMIT,
        })
      ).toThrow(/required runtime dependency/);
    } finally {
      removeDir(source);
    }
  });

  test("rejects forbidden and traversal archive paths", () => {
    expect(() =>
      createDeterministicTgz([{ path: "../secrets.json", content: Buffer.from("x") }])
    ).toThrow(/forbidden artifact path/);
    expect(() => createDeterministicTgz([{ path: ".env", content: Buffer.from("x") }])).toThrow(
      /forbidden artifact path/
    );
  });

  test("rejects external hash mismatch and declared inventory mismatch", () => {
    const result = buildRelease({
      sourceDir: ROOT,
      outputDir: outputOne,
      version: VERSION,
      builtAt: BUILT_AT,
      commit: COMMIT,
    });
    const artifact = fs.readFileSync(result.artifactPath);
    expect(() => validateArtifact(artifact, "0".repeat(64))).toThrow(/external SHA-256/);
    const manifest = { ...result.manifest, files: result.manifest.files.slice(1) };
    const bad = createDeterministicTgz([
      { path: "manifest.json", content: Buffer.from(JSON.stringify(manifest)) },
      { path: ALLOWLIST[0], content: fs.readFileSync(path.join(ROOT, ALLOWLIST[0])) },
    ]);
    const badHash = crypto.createHash("sha256").update(bad).digest("hex");
    expect(() => validateArtifact(bad, badHash)).toThrow(/artifact content|inventory/);
  });

  test("does not package test fixture or sensitive marker content", () => {
    const result = buildRelease({
      sourceDir: ROOT,
      outputDir: outputOne,
      version: VERSION,
      builtAt: BUILT_AT,
      commit: COMMIT,
    });
    const archiveText = fs.readFileSync(result.artifactPath).toString("latin1");
    expect(archiveText).not.toContain("fake-patient-barcode");
    expect(archiveText).not.toContain("fake-shared-secret");
    expect(archiveText).not.toContain("test-controller-token");
  });
});
