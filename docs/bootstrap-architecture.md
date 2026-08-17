# Multimedica Scanner Bootstrap Architecture

## Platform contract

The bootstrap is capability-gated rather than permanently tied to one Raspberry
Pi revision. Raspberry Pi 4 Model B is the physically qualified Milestone 3
baseline. A later Raspberry Pi may proceed when the hard requirements below
pass, but must be reported as compatible and not yet physically qualified until
the hardware acceptance procedure is completed on that model.

### Hard requirements

- Hardware identifies itself as a Raspberry Pi through the device-tree model.
- Architecture is `aarch64` (`arm64` in Debian package metadata).
- Operating system reports `ID=debian`, major `VERSION_ID=13`, and
  `VERSION_CODENAME=trixie`.
- At least 8 GiB is free on the root filesystem before installation.
- Node.js major version 20 is available at `/usr/bin/node` after prerequisite
  installation.
- Chromium is available through the `chromium` package. The qualified path is
  `/usr/lib/chromium/chromium`; supported fallback paths remain available for
  package-layout compatibility.
- Xorg/xinit, `xset`, `unclutter`, `evtest`, `rsync`, `curl`, `sudo`, npm,
  OpenSSH, and NetworkManager capabilities required by provisioning are
  present or installable from the configured repositories.

Kernel, Chromium patch level, Raspberry Pi board revision, SD-card capacity,
and OS image build date are recorded evidence rather than permanent rejection
criteria. Security updates must remain possible.

## Qualified image baseline

| Field | Qualified value |
| --- | --- |
| Edition | Raspberry Pi OS Lite, 64-bit |
| Image family | `raspios_lite_arm64` |
| Build date | 2026-06-18 |
| Filename | `2026-06-18-raspios-trixie-arm64-lite.img.xz` |
| SHA-256 | `acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3` |
| pi-gen commit | `ca8aeed0ae300c2a89f55ce9617d5f96a27e99e5` |
| pi-gen stage | `stage2` |
| OS observed | Debian 13.5 Trixie |
| Qualified hardware | Raspberry Pi 4 Model B Rev 1.5 |

Download URL:

`https://downloads.raspberrypi.com/raspios_lite_arm64/images/raspios_lite_arm64-2026-06-19/2026-06-18-raspios-trixie-arm64-lite.img.xz`

The downloaded compressed image must be verified against the SHA-256 above
before imaging. The checksum identifies the source image; an installed and
subsequently updated SD card is not expected to retain that whole-image hash.

## Qualification observations

The first clean-hardware qualification produced the following post-install
baseline:

| Component | Observed value |
| --- | --- |
| Kernel | `6.18.34+rpt-rpi-v8` |
| Node.js | `20.19.2` |
| npm | `9.2.0` |
| Chromium | `151.0.7922.108` |
| Chromium package | `1:151.0.7922.108-1~deb13u1+rpt1` |
| Display | HDMI-1, portrait `480x800` |
| Scanner USB ID | `9901:0301` |
| Scanner input name | `BF SCAN SCAN KEYBOARD` |
| Scanner handler during test | `/dev/input/event0` (dynamically discovered) |

The event number is not stable and must never be hard-coded. Chromium, kernel,
and package patch versions may advance through normal security updates as long
as the capability checks and acceptance tests continue to pass.

## Hardware qualification status

One Raspberry Pi 4B has completed bootstrap installation and the Milestone 2
commissioning sequence on the qualified image. Final Milestone 3 acceptance
still requires the project-defined independent clean installation on a second
factory-fresh Pi 4 and confirmation of the exact display model, assembly,
cabling, power arrangement, and cold-boot behavior.
