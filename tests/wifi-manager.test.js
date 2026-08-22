"use strict";

const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { _runHelper, HELPER } = require("../bootstrap/lib/wifi-manager");

function fakeSpawn({ exitCode = 0 } = {}) {
  const calls = [];
  const spawnImpl = jest.fn((command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn();
    let input = "";
    child.stdin.on("data", (chunk) => (input += chunk.toString()));
    child.stdin.on("finish", () => {
      calls.push({ command, args, options, input });
      process.nextTick(() => child.emit("close", exitCode));
    });
    return child;
  });
  return { spawnImpl, calls };
}

describe("Wi-Fi privilege boundary", () => {
  test("sends credentials only through stdin to the fixed helper", async () => {
    const fake = fakeSpawn();
    const payload = { ssid: "Clinic", password: "private-pass", security: "wpa-psk" };
    await _runHelper(payload, { spawnImpl: fake.spawnImpl, timeoutMs: 1000 });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      command: "sudo",
      args: ["-n", HELPER],
      options: { stdio: ["pipe", "ignore", "pipe"] },
    });
    expect(JSON.parse(fake.calls[0].input)).toEqual(payload);
    expect(JSON.stringify(fake.calls[0].args)).not.toContain("private-pass");
    expect(JSON.stringify(fake.calls[0].options)).not.toContain("private-pass");
  });

  test("returns a generic failure without helper output or credentials", async () => {
    const fake = fakeSpawn({ exitCode: 9 });
    await expect(
      _runHelper(
        { ssid: "Clinic", password: "never-disclose", security: "wpa-psk" },
        { spawnImpl: fake.spawnImpl, timeoutMs: 1000 }
      )
    ).rejects.toThrow("Wi-Fi configuration failed");
  });

  test("returns only the helper's fixed safe stage code", async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn();
    child.stdin.on("finish", () => {
      child.stderr.write(
        "WIFI_APPLY_FAILED:credential-activation:secrets-required:rollback-restored\n"
      );
      process.nextTick(() => child.emit("close", 1));
    });
    await expect(
      _runHelper(
        { ssid: "Clinic", password: "never-disclose", security: "wpa-psk" },
        { spawnImpl: () => child, timeoutMs: 1000 }
      )
    ).rejects.toThrow(
      "WIFI_APPLY_FAILED:credential-activation:secrets-required:rollback-restored"
    );
  });

  test("kills a helper that exceeds the activation timeout", async () => {
    jest.useFakeTimers();
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn();
    const promise = _runHelper(
      { ssid: "Clinic", password: "private-pass", security: "wpa-psk" },
      { spawnImpl: () => child, timeoutMs: 50 }
    );
    jest.advanceTimersByTime(50);
    await expect(promise).rejects.toThrow("Wi-Fi configuration timed out");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    jest.useRealTimers();
  });
});
