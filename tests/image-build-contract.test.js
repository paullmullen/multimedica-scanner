"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

describe("golden image contract", () => {
  const prep = fs.readFileSync(path.join(root, "image/prepare-golden-image.sh"), "utf8");
  const firstboot = fs.readFileSync(path.join(root, "image/multimedica-image-firstboot"), "utf8");
  const unit = fs.readFileSync(
    path.join(root, "image/multimedica-image-firstboot.service"),
    "utf8"
  );

  test("retains only the QR authorization token from scanner secrets", () => {
    expect(prep).toContain("qr_admin_token: secrets.qr_admin_token");
    expect(prep).not.toMatch(/wifi_password:\s*secrets\./);
    expect(prep).not.toMatch(/shared_secret:\s*secrets\./);
  });

  test("resets clinic configuration to bootstrap installed", () => {
    expect(prep).toContain("commissioning_state: 'bootstrap_installed'");
    expect(prep).toContain("system-connections");
  });

  test("requires an activated production release before capture", () => {
    expect(prep).toContain('[[ -L "$CURRENT_LINK" ]]');
  });

  test("performs cloned identity housekeeping automatically", () => {
    expect(firstboot).toContain("systemd-machine-id-setup");
    expect(firstboot).toContain("ssh-keygen -A");
    expect(firstboot).toContain('hostname="multimedica-${suffix}"');
    expect(firstboot).toContain('rm -f "$MARKER"');
    expect(unit).toContain("ConditionPathExists=/var/lib/multimedica-scanner/image/first-boot-required");
  });
});
