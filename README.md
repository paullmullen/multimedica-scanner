# Multimedica Scanner & Kiosk Display System

Raspberry Pi–based barcode scanner and kiosk display appliance for the Multimedica clinic workflow system.

This project provides a lightweight operational appliance that connects:

- barcode scanning
- local kiosk display
- Firebase Cloud Functions
- Firestore operational state
- clinic workflow orchestration

The platform is designed to make station-level patient flow:

- visible
- resilient
- recoverable
- operationally simple
- field-deployable
- maintainable by someone other than the original developer

---

# System Overview

Each scanner appliance consists of:

- Raspberry Pi
- USB barcode scanner
- HDMI-attached kiosk display
- local Node.js scanner runtime
- local kiosk display service

The scanner appliance:

1. Accepts barcode scan events
2. Sends events to cloud functions
3. Receives authoritative workflow state from the cloud
4. Updates the local kiosk display
5. Maintains synchronization with cloud state
6. Supports field configuration via QR codes

The architecture is intentionally cloud-light:

- the Pi is mostly self-contained
- the cloud responds to requests
- the Pi maintains local operational state and diagnostics
- the display continues to have meaningful local state during transient cloud/network failures

---

# Core Features

## Barcode Workflow Processing

- USB barcode scanner support
- Keyboard-wedge scanner compatibility (replaces a keyboard)
- Scan-in / scan-out workflow handling
- Cloud-authoritative workflow transitions
- Retry-safe idempotent event handling

---

## Real-Time Kiosk Display

- HDMI-attached room display
- Chromium kiosk mode
- Portrait-oriented operational UI
- Real-time room/station status
- Patient workflow visibility
- Operational overlays and alerts

---

## QR-Based Configuration

Supported QR configuration payloads:

- station configuration
- WiFi configuration
- cloud endpoint configuration

Features:

- admin token validation
- persistent local configuration
- overlay confirmation feedback
- field provisioning without keyboard access

---

## Cloud Synchronization

- adaptive polling
- startup reconciliation
- drift correction
- clinic-open / clinic-closed operational logic
- authoritative cloud-state recovery

---

## Operational Resilience

- boot-time synchronization
- automatic service restart
- local display-state persistence
- stale-state detection
- health/status endpoints
- GitHub pull-on-boot update support

---

# High-Level Architecture

```text
USB Barcode Scanner
        ↓
Raspberry Pi Scanner Service
        ↓
Firebase Cloud Functions
        ↓
Clinic Workflow / Firestore
        ↓
Adaptive Polling / Cloud Sync
        ↓
Local Kiosk Display Service
        ↓
HDMI Display
```

---

# Runtime Components

| Component                     | Purpose                                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `scanner.js`                  | Main scanner runtime. Reads barcode input, processes QR configuration codes, communicates with the cloud, and updates the local display. |
| `kiosk-display/server.js`     | Local Express server for the kiosk display and display state API.                                                                        |
| `kiosk-display/public/app.js` | Browser UI rendered on the Pi display.                                                                                                   |
| `displayState.js`             | Local display-state defaults, merge behavior, and persistence helpers.                                                                   |
| `scannerCloudFunctions`       | Firebase Cloud Functions used by the scanner/display subsystem.                                                                          |
| `provision-scanner.ps1`       | Windows-side provisioning script used to deploy scanner files to the Pi.                                                                 |

---

# Repository Structure

```text
multimedica-scanner/
│
├── scanner.js
├── package.json
├── provisioning/
├── kiosk-display/
├── display/
├── docs/
├── scripts/
├── services/
└── README.md
```

---

# Documentation

The README is intended to act as the front door to the project.

Detailed operational and architectural documentation lives under `/docs`.

## Documentation Structure

```text
/docs
  quickstart.md
  installation.md
  troubleshooting.md
  architecture.md
  kiosk-api.md
  observability.md
  qr-configuration.md
  configuration.md
  deployment.md
```

---

## [Quick Start](docs/quickstart.md)

Fast-path deployment guide:

```text
/docs/quickstart.md
```

Covers:

- imaging SD card
- provisioning Raspberry Pi
- installing services
- validating scanner operation
- QR configuration

---

## [Installation Guide](docs/installation.md)

Complete installer/operator manual:

```text
/docs/installation.md
```

Covers:

- hardware requirements
- environment variables
- service installation
- scanner testing
- kiosk validation
- recovery procedures
- deployment workflows

---

## [Troubleshooting Guide](docs/troubleshooting.md)

Operational diagnostics and SOPs:

```text
/docs/troubleshooting.md
```

Covers:

- scanner failures
- kiosk failures
- polling issues
- WiFi issues
- QR configuration problems
- cloud synchronization issues

---

## [Architecture Guide](docs/architecture.md)

Technical deep dive:

```text
/docs/architecture.md
```

Covers:

- scanner lifecycle
- polling contract
- operational state model
- synchronization philosophy
- QR payload structure
- observability model

---

# [Quick Start Commands](docs/quickstart.md)

Install local dependencies:

```bash
npm install
```

Deploy to the Raspberry Pi:


Use this if deploying to an already configured Pi
```powershell
.\provision-scanner.ps1
```
Use this if deploying to a brand new  Pi (It will take MUCH longer)
```powershell
.\provision-scanner.ps1 -InstallBasePackages
```

Check scanner service status on the Pi:

```bash
sudo systemctl status multimedica-scanner.service
```

Follow scanner logs:

```bash
journalctl -u multimedica-scanner.service -f
```

Read the current kiosk display state:

```bash
curl http://127.0.0.1:3001/api/display | jq
```

Read scanner health summary:

```bash
curl http://127.0.0.1:3002/status/summary | jq
```

---

# Hardware Requirements

## Minimum Supported Hardware

| Component    | Requirement                        |
| ------------ | ---------------------------------- |
| Raspberry Pi | Pi 3B+ or Pi 4                     |
| SD Card      | 16GB+ Class 10                     |
| Display      | HDMI-compatible display            |
| Scanner      | USB keyboard-wedge barcode scanner |
| Network      | WiFi or Ethernet                   |

---

## Known Working Hardware

| Component    | Known Working Example       |
| ------------ | --------------------------- |
| Raspberry Pi | Raspberry Pi 4B             |
| Scanner      | BF SCAN USB barcode scanner |
| Display      | Waveshare 4.3 HDMI LCD      |
| Printer      | Epson TM-m30III             |

---

# Operational Concepts

## Room

A physical clinical room.

Examples:

- Exam Room 1
- Nursing Station
- Registration Desk

---

## Station

A workflow step or operational function.

Examples:

- REG
- NUR
- DOC
- LAB
- PHA

---

## Operational Modes

Examples:

- available
- patient_waiting
- in_process
- clinic_closed
- offline
- degraded

---

## Cloud Authority

The cloud system is considered the authoritative operational state.

The Raspberry Pi acts as:

- local operational cache
- display appliance
- scan event producer

Polling and synchronization exist to maintain consistency.

---

# Scanner Lifecycle

```text
Barcode Scan
    ↓
scanner.js
    ↓
Cloud Function
    ↓
Workflow Engine
    ↓
Response Payload
    ↓
Local Display Update
    ↓
Adaptive Polling Reconciliation
```

---

# systemd Services

The scanner appliance is normally supervised by systemd.

| Service                       | Purpose                              |
| ----------------------------- | ------------------------------------ |
| `multimedica-scanner.service` | Runs the barcode scanner runtime.    |
| `kiosk-display.service`       | Runs the local kiosk display server. |

Useful commands:

```bash
sudo systemctl status multimedica-scanner.service
sudo systemctl status kiosk-display.service
```

Display Logs
```bash
journalctl -u multimedica-scanner.service -f
journalctl -u kiosk-display.service -f
```

---

# Local APIs

The appliance exposes local APIs for development, diagnostics, and troubleshooting.

| API                       | Default Port | Purpose                                           |
| ------------------------- | -----------: | ------------------------------------------------- |
| Kiosk Display API         |       `3001` | Read or manually update the display state.        |
| Scanner Observability API |       `3002` | Inspect scanner/device health and runtime status. |

---

## Common Commands

```bash
curl http://127.0.0.1:3001/api/display | jq
curl http://127.0.0.1:3002/status | jq
curl http://127.0.0.1:3002/status/summary | jq
```

Manual display POSTs are useful for:

- UI testing
- provisioning validation
- troubleshooting kiosk behavior
- validating overlays, colors, and layouts

Detailed API examples should live under:

```text
/docs/kiosk-api.md
```

---

# Common Display Status Codes

| Status Code       | Meaning                                     |
| ----------------- | ------------------------------------------- |
| `available`       | Station available                           |
| `in_process`      | Patient currently being seen                |
| `patient_waiting` | Another patient is waiting (Room is empty)  |
| `clinic_closed`   | Clinic closed                               |
| `offline`         | Cloud or device offline                     |
| `degraded`        | Partial operational failure                 |
| `error`           | Error state                                 |

---

# Common Overlay Types

| Overlay Type | Meaning                       |
| ------------ | ----------------------------- |
| `success`    | Positive confirmation         |
| `warning`    | Non-critical issue            |
| `error`      | Failure or disconnected state |
| `info`       | Informational message         |

---

# Configuration Philosophy

The scanner/display appliance uses localized configuration objects within each subsystem rather than a single global configuration file.

Each runtime surface owns its own operational policy:

| Subsystem                     | Config Object           |
| ----------------------------- | ----------------------- |
| `scanner.js`                  | `SCANNER_CONFIG`        |
| `kiosk-display/server.js`     | `DISPLAY_SERVER_CONFIG` |
| `kiosk-display/public/app.js` | `DISPLAY_CONFIG`        |
| `displayState.js`             | `DISPLAY_STATE_CONFIG`  |
| `boot.html`                   | `BOOT_CONFIG`           |

This design is intentional and prioritizes:

- appliance reliability
- startup resilience
- subsystem isolation
- simplified debugging

Configuration centralization should follow this progression:

```text
magic number
→ named constant
→ grouped config object
→ optional shared policy later, only if truly cross-subsystem
```

Do not create shared configuration files unless:

- the same operational policy must be coordinated across multiple runtimes
- the maintenance benefit outweighs subsystem-isolation risk

Additional configuration guidance should eventually move to:

```text
/docs/configuration.md
```

---

# Provisioning Overview

Typical deployment workflow:

```text
1. Flash Raspberry Pi OS
2. Boot Pi
3. Configure network
4. Clone repository
5. Run provisioning script
6. Install services
7. Configure environment
8. Reboot
9. Validate kiosk
10. Scan QR configuration codes
11. Test patient workflow
```

---

# Environment Variables

Example:

```env
ROOM_ID=room_1
STATION_ID=NUR
DEVICE_ID=pi_nur_01
ENDPOINT_URL=https://example.cloudfunctions.net
SHARED_SECRET=replace_me
SCANNER_DEVICE_NAME=BF SCAN SCAN KEYBOARD
SCANNER_QR_ADMIN_TOKEN=replace_me
```

Full documentation:

```text
/docs/installation.md
```

---

# Logging & Diagnostics

## Scanner Logs

```bash
journalctl -u multimedica-scanner.service -f
```

---

## Kiosk Display Logs

```bash
journalctl -u kiosk-display.service -f
```

---

## Display State Inspection

```bash
curl http://127.0.0.1:3001/api/display | jq
```

---

## Status Inspection

```bash
curl http://127.0.0.1:3002/status | jq
```

---

# Update Workflow

The platform supports GitHub-based update workflows.

Typical flow:

```text
feature branch
    ↓
test deployment
    ↓
production merge
    ↓
Pi update/pull
    ↓
service restart
```

Future enhancements may include:

- fleet management
- centralized updates
- remote diagnostics
- OTA deployment orchestration

---
## Git-Backed Production Deployment

The scanner appliance is deployed as a Git-backed runtime checkout.

The Raspberry Pi tracks a designated Git branch:

```text
production
```

The Pi is considered an operational appliance, not a development environment.

Local runtime code on the Pi should never become authoritative.

---

### Branch Strategy

Recommended workflow:

| Branch       | Purpose                            |
| ------------ | ---------------------------------- |
| `main`       | Active development branch          |
| `production` | Stable appliance deployment branch |

Typical promotion flow:

```bash
git checkout production
git merge --ff-only main
git push origin production
```

This creates a clean linear production history while keeping the deployed fleet deterministic.

---

### Provisioning Behavior

During provisioning:

1. The Pi fetches the configured Git branch from GitHub
2. The local checkout is reset to match the remote branch exactly
3. Untracked files are removed
4. Runtime services are restarted

The Pi converges toward the authoritative GitHub deployment state.

---

### Graceful GitHub Failure Handling

If GitHub cannot be reached during reprovisioning or boot-time synchronization:

- the existing local runtime code remains active
- provisioning continues using the currently installed version
- scanner/display services continue operating normally

This behavior is intentional and prioritizes clinic operational continuity over strict update enforcement.

First-time installation still requires GitHub access because no local runtime exists yet.

---

### Appliance Philosophy

The deployment model intentionally favors:

- operational resilience
- deterministic deployments
- field recoverability
- simple rollback behavior
- minimized configuration drift

The appliance should always be reproducible from:

```text
GitHub production branch
+
persistent local .env configuration
```

rather than relying on local manual edits.

# Refactor Policy

Scanner/display refactors should follow these rules:

1. Preserve runtime behavior.
2. Preserve environment variable names unless a migration path is explicit.
3. Avoid unrelated refactors.
4. Prefer small, safe edits.
5. Maintain appliance reliability as the top priority.
6. Validate behavior on the Pi after deployment.

The current architecture intentionally favors reliability over maximal abstraction.

---

# Design Philosophy

The scanner platform is intentionally designed as:

- appliance-oriented
- operationally resilient
- field-deployable
- minimally interactive
- recoverable after failure
- maintainable by non-authors

The goal is for a technically competent operator to:

- deploy
- maintain
- troubleshoot
- replace
- recover

scanner hardware without relying on tribal knowledge.

---

# Future Roadmap

Planned future capabilities:

- multi-room orchestration
- remote fleet dashboards
- centralized device management
- richer offline handling
- advanced analytics
- printer reliability improvements
- automated provisioning

---

# License

Internal operational software.

Additional licensing and deployment guidance TBD.

