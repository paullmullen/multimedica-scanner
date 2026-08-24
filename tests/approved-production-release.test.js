"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const {
  approveProductionRelease,
  prepareApprovedRelease,
  sha256File,
} = require("../release/approve-production-release");

const ROOT = path.join(__dirname, "..");

function fixture(version = "1.2.3") {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-approved-release-"));
  const outputDir = path.join(rootDir, "release-output");
  fs.mkdirSync(outputDir, { recursive: true });
  const artifact = `multimedica-production-${version}.tgz`;
  const bytes = Buffer.from("fake production artifact for contract testing");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(outputDir, artifact), bytes);
  fs.writeFileSync(path.join(outputDir, `${artifact}.sha256`), `${sha256}  ${artifact}\n`);
  fs.writeFileSync(
    path.join(outputDir, `multimedica-production-${version}.build.json`),
    `${JSON.stringify({ version, commit: "test-commit" }, null, 2)}\n`
  );
  return { rootDir, outputDir, artifact, sha256, version };
}

afterEach(() => {
  jest.restoreAllMocks();
});

test("publishes a schema-valid pointer only after all release files agree", () => {
  const value = fixture();
  const approvedAt = "2026-08-22T12:00:00.000Z";
  const result = approveProductionRelease({
    rootDir: value.rootDir,
    version: value.version,
    approvedAt,
  });
  const pointer = JSON.parse(fs.readFileSync(result.outputPath, "utf8"));
  const schema = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "schemas", "approved-production-release.schema.json"))
  );
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  expect(ajv.validate(schema, pointer)).toBe(true);
  expect(pointer).toEqual({
    schema_version: 1,
    version: value.version,
    artifact: value.artifact,
    sha256: value.sha256,
    build_metadata: `multimedica-production-${value.version}.build.json`,
    approved_at: approvedAt,
  });
  fs.rmSync(value.rootDir, { recursive: true, force: true });
});

test("rejects a missing artifact, checksum mismatch, malformed version, and build mismatch", () => {
  const missing = fixture();
  fs.unlinkSync(path.join(missing.outputDir, missing.artifact));
  expect(() => prepareApprovedRelease({ rootDir: missing.rootDir, version: missing.version })).toThrow(
    "production artifact is missing"
  );
  fs.rmSync(missing.rootDir, { recursive: true, force: true });

  const checksum = fixture();
  fs.writeFileSync(path.join(checksum.outputDir, `${checksum.artifact}.sha256`), `${"0".repeat(64)}  ${checksum.artifact}\n`);
  expect(() => prepareApprovedRelease({ rootDir: checksum.rootDir, version: checksum.version })).toThrow(
    "does not match sidecar"
  );
  fs.rmSync(checksum.rootDir, { recursive: true, force: true });

  const malformed = fixture();
  expect(() => prepareApprovedRelease({ rootDir: malformed.rootDir, version: "latest" })).toThrow(
    "numeric semantic versioning"
  );
  fs.rmSync(malformed.rootDir, { recursive: true, force: true });

  const build = fixture();
  fs.writeFileSync(
    path.join(build.outputDir, `multimedica-production-${build.version}.build.json`),
    JSON.stringify({ version: "9.9.9" })
  );
  expect(() => prepareApprovedRelease({ rootDir: build.rootDir, version: build.version })).toThrow(
    "build metadata version does not match"
  );
  fs.rmSync(build.rootDir, { recursive: true, force: true });
});

test("repository pointer references a complete, hash-matched approved release", () => {
  const pointerPath = path.join(ROOT, "release-output", "approved-production-release.json");
  expect(fs.existsSync(pointerPath)).toBe(true);
  const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  const schema = JSON.parse(
    fs.readFileSync(path.join(ROOT, "schemas", "approved-production-release.schema.json"), "utf8")
  );
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  expect(ajv.validate(schema, pointer)).toBe(true);

  const outputDir = path.join(ROOT, "release-output");
  const artifactPath = path.join(outputDir, pointer.artifact);
  const checksumPath = `${artifactPath}.sha256`;
  const buildPath = path.join(outputDir, pointer.build_metadata);
  expect(fs.existsSync(artifactPath)).toBe(true);
  expect(fs.existsSync(checksumPath)).toBe(true);
  expect(fs.existsSync(buildPath)).toBe(true);
  expect(sha256File(artifactPath)).toBe(pointer.sha256);
  expect(fs.readFileSync(checksumPath, "utf8").trim().split(/\s+/)[0]).toBe(pointer.sha256);
  expect(pointer.artifact).toBe(`multimedica-production-${pointer.version}.tgz`);
  expect(pointer.build_metadata).toBe(
    `multimedica-production-${pointer.version}.build.json`
  );
});
