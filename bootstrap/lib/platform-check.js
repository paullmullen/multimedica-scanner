"use strict";

/**
 * Platform Check Constants — Multimedica Scanner Bootstrap Layer
 *
 * Defines the supported hardware and OS baseline for v1.
 *
 * Values marked [TO BE CONFIRMED] are placeholders. They will be replaced
 * with exact values during Milestone 3 clean-hardware qualification. Until
 * that milestone closes, these constants must not be treated as authoritative
 * validation constraints in production installer code.
 *
 * The platform checks performed before any Pi modification are:
 *   1. /proc/cpuinfo Hardware field matches PI_MODEL_PATTERN (Pi 4 = BCM2711)
 *   2. uname -m returns 'aarch64'
 *   3. /etc/os-release ID and VERSION_CODENAME match OS_ID
 *   4. Free disk space on / >= MIN_ROOT_BYTES
 *   5. node --version satisfies NODE_SEMVER
 */

const PLATFORM = Object.freeze({
  // Raspberry Pi 4 (BCM2711 SoC)
  pi_model_pattern: /BCM2711/,
  arch: "aarch64",

  // [TO BE CONFIRMED in Milestone 3] — exact Raspberry Pi OS Lite 64-bit image
  os_id: "raspios-bookworm-arm64-lite",

  // [TO BE CONFIRMED in Milestone 3] — Node version installed by qualified package set
  node_semver: ">=20.0.0 <21.0.0",

  // [TO BE CONFIRMED in Milestone 3] — Chromium executable path on qualified image
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
