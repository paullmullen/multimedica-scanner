"use strict";

const { EventEmitter } = require("events");

function fakeEvtest() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("scanner-reader reconnect ownership", () => {
  let originalPlatform;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    jest.useRealTimers();
    jest.dontMock("fs");
    jest.dontMock("child_process");
  });

  test("disconnect and error schedule one replacement reader", () => {
    const children = [];
    jest.doMock("fs", () => ({
      existsSync: () => true,
      readFileSync: () => 'N: Name="BF SCAN SCAN KEYBOARD"\nH: Handlers=kbd event7\n',
    }));
    jest.doMock("child_process", () => ({
      spawn: jest.fn(() => {
        const child = fakeEvtest();
        children.push(child);
        return child;
      }),
    }));

    const reader = require("../bootstrap/lib/scanner-reader");
    reader.start(() => {});
    expect(children).toHaveLength(1);

    children[0].emit("close", 1);
    children[0].emit("error", new Error("already closed"));
    jest.advanceTimersByTime(5_000);

    expect(children).toHaveLength(2);
  });
});
