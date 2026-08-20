"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ASSETS, validateBundle, waitForDisplayReady, installDisplayBundle, parseArgs } = require("../bootstrap/display-update");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-display-update-"));
  const source = path.join(root, "bundle");
  const target = path.join(root, "public");
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "old.txt"), "known-good");
  const files = ASSETS.map((name) => {
    const content = name === "full_logo.png" ? Buffer.from([1, 2, 3, 4]) : Buffer.from(`new-${name}`);
    fs.writeFileSync(path.join(source, name), content);
    return {
      name,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      size: content.length,
    };
  });
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ version: 1, files }));
  const launcherTarget = path.join(root, "start-kiosk.sh");
  fs.writeFileSync(launcherTarget, "old-launcher");
  return { root, source, target, launcherTarget };
}

afterEach(() => jest.restoreAllMocks());

test("waits for the restarted display server within a bounded retry window", async () => {
  const sleep = jest.fn();
  const probe = jest.fn()
    .mockRejectedValueOnce(new Error("not listening"))
    .mockRejectedValueOnce(new Error("not listening"))
    .mockResolvedValue(undefined);
  await expect(waitForDisplayReady(probe, { attempts: 3, delayMs: 1, sleep })).resolves.toBeUndefined();
  expect(probe).toHaveBeenCalledTimes(3);
  expect(sleep).toHaveBeenCalledTimes(2);
});

test("fails after the bounded display readiness window", async () => {
  const probe = jest.fn().mockRejectedValue(new Error("still unavailable"));
  await expect(waitForDisplayReady(probe, { attempts: 2, delayMs: 1, sleep: jest.fn() }))
    .rejects.toThrow("still unavailable");
  expect(probe).toHaveBeenCalledTimes(2);
});

test("validates the exact display allowlist and hashes", () => {
  const value = fixture();
  try {
    expect(validateBundle(value.source).files.map((item) => item.name).sort()).toEqual([...ASSETS].sort());
    fs.appendFileSync(path.join(value.source, "app.js"), "tampered");
    expect(() => validateBundle(value.source)).toThrow("integrity");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("atomically installs a healthy display bundle", async () => {
  const value = fixture();
  const savedState = { runtime: { kind: "room" } };
  const services = { restart: jest.fn(), verify: jest.fn(), capture: jest.fn(() => savedState), restore: jest.fn() };
  try {
    await expect(installDisplayBundle(value.source, { target: value.target, launcherTarget: value.launcherTarget, services }))
      .resolves.toEqual({ ok: true, rolledBack: false });
    expect(fs.existsSync(path.join(value.target, "old.txt"))).toBe(false);
    for (const name of ASSETS.filter((name) => name !== "start-kiosk.sh"))
      expect(fs.existsSync(path.join(value.target, name))).toBe(true);
    expect(services.restart).toHaveBeenCalledTimes(1);
    expect(services.verify).toHaveBeenCalledTimes(1);
    expect(services.restore).toHaveBeenCalledWith(savedState);
    expect(fs.readFileSync(value.launcherTarget, "utf8")).toBe("new-start-kiosk.sh");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("restores the previous directory when post-install verification fails", async () => {
  const value = fixture();
  let verifyCount = 0;
  const services = {
    restart: jest.fn(),
    capture: jest.fn(() => ({ runtime: { kind: "room" } })),
    restore: jest.fn(),
    verify: jest.fn(async () => {
      verifyCount += 1;
      if (verifyCount === 1) throw new Error("unhealthy");
    }),
  };
  try {
    await expect(installDisplayBundle(value.source, { target: value.target, launcherTarget: value.launcherTarget, services }))
      .rejects.toThrow("display update failed");
    expect(fs.readFileSync(path.join(value.target, "old.txt"), "utf8")).toBe("known-good");
    expect(services.restart).toHaveBeenCalledTimes(2);
    expect(services.verify).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(value.launcherTarget, "utf8")).toBe("old-launcher");
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("accepts only one absolute source argument", () => {
  expect(parseArgs(["--source", path.resolve("bundle")])).toBe(path.resolve("bundle"));
  expect(() => parseArgs(["--source", "relative"])).toThrow("invalid");
  expect(() => parseArgs(["--source", "/tmp/a", "extra"])).toThrow("invalid");
});
