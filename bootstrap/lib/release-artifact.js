"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const FORMAT_VERSION = 1;
const RELEASE_NAME = "multimedica-production";
const ALLOWLIST = Object.freeze([
  "bootstrap/lib/config-store.js",
  "bootstrap/lib/secrets-store.js",
  "bootstrap/lib/state-store.js",
  "package-lock.json",
  "package.json",
  "production/scan-server.js",
  "schemas/config.schema.json",
  "schemas/secrets.schema.json",
]);
const FORBIDDEN_SEGMENTS =
  /(^|\/)(\.env[^/]*|secrets\.json|config\.json|multimedica-installer\.json|provisioning-result\.json|node_modules|\.git|release\/stable-channel\.json|logs?)(\/|$)/i;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value), null, 2) + "\n";
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  return value;
}

function assertSafePath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("artifact path must be a nonempty relative path");
  }
  const normalized = relativePath.replace(/\\/g, "/");
  if (
    normalized.includes("..") ||
    normalized.startsWith("/") ||
    FORBIDDEN_SEGMENTS.test(normalized)
  ) {
    throw new Error(`forbidden artifact path: ${relativePath}`);
  }
  return normalized;
}

function readAllowedFiles(sourceDir) {
  return ALLOWLIST.map((relativePath) => {
    const safePath = assertSafePath(relativePath);
    const fullPath = path.join(sourceDir, safePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`required runtime dependency is absent: ${safePath}`);
    }
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`required runtime dependency is not a regular file: ${safePath}`);
    }
    const content = fs.readFileSync(fullPath);
    return { path: safePath, content, size: content.length, sha256: sha256(content) };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function createManifest(version, files, options) {
  const inventory = files.map(({ path: filePath, sha256: hash, size }) => ({
    path: filePath,
    sha256: hash,
    size,
  }));
  return {
    name: RELEASE_NAME,
    version,
    os_id: "debian-13-trixie-arm64",
    arch: "arm64",
    capability_policy: "capability-qualified",
    node_semver: ">=20.0.0 <21.0.0",
    config_schema_version: 1,
    qr_schema_version: 1,
    min_bootstrap_version: "1.0.0",
    entry_point: "production/scan-server.js",
    health_endpoint: "http://127.0.0.1:3002/api/status",
    candidate_port: 3003,
    built_at: options.builtAt,
    artifact_format_version: FORMAT_VERSION,
    content_sha256: sha256(stableJson(inventory)),
    source_commit: options.commit || null,
    files: inventory,
  };
}

function writeOctal(buffer, offset, length, value) {
  const text =
    Number(value)
      .toString(8)
      .padStart(length - 1, "0") + "\0";
  buffer.write(text.slice(-length), offset, length, "ascii");
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeOctal(header, 148, 8, checksum);
  return header;
}

function createDeterministicTgz(entries) {
  const blocks = [];
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    const safePath = assertSafePath(entry.path);
    blocks.push(tarHeader(safePath, entry.content.length), entry.content);
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { mtime: 0 });
}

function readTgz(tgz) {
  const tar = zlib.gunzipSync(tgz);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const type = String.fromCharCode(header[156] || 48);
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeText || "0", 8);
    if (type !== "0") throw new Error(`unsupported tar entry type: ${type}`);
    const contentOffset = offset + 512;
    entries.push({
      path: assertSafePath(name),
      content: tar.subarray(contentOffset, contentOffset + size),
    });
    offset = contentOffset + size + ((512 - (size % 512)) % 512);
  }
  return entries;
}

function validateArtifact(tgz, expectedExternalHash) {
  const actualHash = sha256(tgz);
  if (expectedExternalHash && actualHash !== expectedExternalHash) {
    throw new Error("external SHA-256 does not match artifact");
  }
  const entries = readTgz(tgz);
  const paths = entries.map((entry) => entry.path).sort();
  const expectedPaths = ["manifest.json", ...ALLOWLIST].sort();
  if (JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
    throw new Error("artifact content does not match declared allowlist");
  }
  const manifestEntry = entries.find((entry) => entry.path === "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.content.toString("utf8"));
  } catch {
    throw new Error("manifest is invalid JSON");
  }
  validateManifest(manifest);
  const payloadEntries = entries.filter((entry) => entry.path !== "manifest.json");
  const inventory = payloadEntries.map((entry) => ({
    path: entry.path,
    sha256: sha256(entry.content),
    size: entry.content.length,
  }));
  if (sha256(stableJson(inventory)) !== manifest.content_sha256)
    throw new Error("artifact inventory hash mismatch");
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.files))
    throw new Error("artifact inventory does not match manifest");
  return { manifest, files: inventory, entries: payloadEntries, sha256: actualHash };
}

function validateManifest(manifest) {
  const schemaPath = path.join(__dirname, "..", "..", "schemas", "release-manifest.schema.json");
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, "utf8")));
  if (!validate(manifest)) throw new Error("manifest validation failed");
  if (!manifest || !SEMVER.test(manifest.version))
    throw new Error("manifest version is not semantic");
  if (manifest.entry_point !== "production/scan-server.js")
    throw new Error("manifest entrypoint is invalid");
  if (manifest.candidate_port !== 3003) throw new Error("manifest candidate port must be 3003");
  if (manifest.arch !== "arm64" || manifest.os_id !== "debian-13-trixie-arm64")
    throw new Error("manifest platform compatibility is invalid");
  if (manifest.capability_policy !== "capability-qualified")
    throw new Error("manifest capability policy is invalid");
  if (!Array.isArray(manifest.files)) throw new Error("manifest inventory is missing");
}

module.exports = {
  ALLOWLIST,
  FORMAT_VERSION,
  RELEASE_NAME,
  SEMVER,
  sha256,
  stableJson,
  canonicalize,
  assertSafePath,
  readAllowedFiles,
  createManifest,
  writeOctal,
  tarHeader,
  createDeterministicTgz,
  readTgz,
  validateArtifact,
  validateManifest,
};
