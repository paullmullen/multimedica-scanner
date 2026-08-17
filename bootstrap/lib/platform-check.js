"use strict";

/**
 * Platform Check Constants — Multimedica Scanner Bootstrap Layer
 *
 * Defines the supported platform capabilities and the hardware/image baseline
 * physically qualified during Milestone 3.
 *
 * The platform checks performed before any Pi modification are:
 *   1. Device-tree model identifies Raspberry Pi hardware
 *   2. uname -m returns 'aarch64'
 *   3. /etc/os-release matches Debian 13 / Trixie
 *   4. Free disk space on / >= MIN_ROOT_BYTES
 *   5. node --version satisfies NODE_SEMVER
 */

const PLATFORM = Object.freeze({
  // Capability gate: later Raspberry Pi models are not structurally blocked.
  // Models outside qualified_pi_model_patterns require qualification evidence
  // but may proceed when the capability checks pass.
  raspberry_pi_model_pattern: /^Raspberry Pi\b/i,
  qualified_pi_model_patterns: Object.freeze([
    /^Raspberry Pi 4 Model B\b/i,
  ]),
  pi_model_pattern: /^Raspberry Pi\b/i,
  arch: "aarch64",

  os_id: "debian",
  os_version_id: "13",
  os_codename: "trixie",

  qualified_image: Object.freeze({
    family: "raspios_lite_arm64",
    build_date: "2026-06-18",
    filename: "2026-06-18-raspios-trixie-arm64-lite.img.xz",
    sha256: "acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3",
    pi_gen_commit: "ca8aeed0ae300c2a89f55ce9617d5f96a27e99e5",
    stage: "stage2",
  }),

  node_semver: ">=20.0.0 <21.0.0",

  chromium_package: "chromium",
  qualified_chromium_path: "/usr/lib/chromium/chromium",
  chromium_candidates: Object.freeze([
    "/usr/lib/chromium/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]),

  // Minimum free space required on / before bootstrap installation
  min_root_bytes: 8 * 1024 * 1024 * 1024, // 8 GiB

  // Provisioning user
  app_user: "multimedica_edge",
  app_group: "multimedica_edge",

  // Bootstrap version (updated when bootstrap is released)
  bootstrap_version: "1.0.0",
});

module.exports = { PLATFORM };
