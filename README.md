# Multimedica Scanner

Raspberry Pi-based barcode scanner and kiosk display appliance for the Multimedica clinic workflow system.

This project provides a small edge appliance that connects barcode scanning, local kiosk display, Firebase Cloud Functions, and the clinic workflow engine. The goal is to make station-level patient flow visible, resilient, and easy to operate in a clinic environment.

---

## Key Capabilities

- Barcode scan ingestion
- Patient/station workflow transitions
- Local kiosk status display
- Configuration QR workflows
- Cloud synchronization
- Adaptive polling
- Local observability and diagnostics
- Appliance-style recovery behavior after reboot or network interruption

---

## System Overview

Each scanner appliance consists of:

- Raspberry Pi
- USB barcode scanner
- HDMI-attached kiosk display
- Local Node.js scanner service
- Local kiosk display service

The scanner communicates with Firebase Cloud Functions and maintains a synchronized local room/station display.

The architecture is intentionally cloud-light:

- the Pi is mostly self-contained
- the cloud responds to requests
- the Pi maintains local operational state and diagnostics
- the display continues to have meaningful local state during transient cloud/network issues

---

## High-Level Architecture

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

## Runtime Components

| Component | Purpose |
| --- | --- |
| `scanner.js` | Main scanner runtime. Reads barcode input, processes QR configuration codes, communicates with the cloud, and updates the local display. |
| `kiosk-display/server.js` | Local Express server for the kiosk display and display state API. |
| `kiosk-display/public/app.js` | Browser UI rendered on the Pi display. |
| `displayState.js` | Local display-state defaults, merge behavior, and persistence helpers. |
| `scannerCloudFunctions` | Firebase Cloud Functions used by the scanner/display subsystem. |
| `provision-scanner.ps1` | Windows-side provisioning script used to deploy scanner files to the Pi. |

---

## Quick Start

Install local dependencies:

```bash
npm install
```

Deploy to the Raspberry Pi:

```powershell
.\provision-scanner.ps1
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
curl http://127.0.0.1:3002/api/status/summary | jq
```

---

## systemd Services

The scanner appliance is normally supervised by systemd.

| Service | Purpose |
| --- | --- |
| `multimedica-scanner.service` | Runs the barcode scanner runtime. |
| `kiosk-display.service` | Runs the local kiosk display server. |

Useful commands:

```bash
sudo systemctl status multimedica-scanner.service
sudo systemctl status kiosk-display.service
```

```bash
journalctl -u multimedica-scanner.service -f
journalctl -u kiosk-display.service -f
```

---

## Local APIs

The appliance exposes local APIs for development, diagnostics, and troubleshooting.

| API | Default Port | Purpose |
| --- | ---: | --- |
| Kiosk Display API | `3001` | Read or manually update the display state. |
| Scanner Observability API | `3002` | Inspect scanner/device health and runtime status. |

Common commands:

```bash
curl http://127.0.0.1:3001/api/display | jq
curl http://127.0.0.1:3002/api/status | jq
curl http://127.0.0.1:3002/api/status/summary | jq
```

Manual display POSTs are useful for:

- UI testing
- provisioning validation
- troubleshooting kiosk behavior
- validating overlays, colors, and layouts

For detailed display API examples, see the kiosk/display API documentation once the `/docs` structure is added.

---

## Common Display Status Codes

| Status Code | Meaning |
| --- | --- |
| `available` | Station available |
| `in_process` | Patient currently being seen |
| `patient_waiting` | Another patient is waiting |
| `closed` | Clinic closed |
| `offline` | Cloud or device offline |
| `error` | Error state |

---

## Common Overlay Types

| Overlay Type | Meaning |
| --- | --- |
| `success` | Positive confirmation |
| `warning` | Non-critical issue |
| `error` | Failure or disconnected state |
| `info` | Informational message |

---

## Configuration Philosophy

The scanner/display appliance uses localized configuration objects within each subsystem rather than a single global configuration file.

Each runtime surface owns its own operational policy:

| Subsystem | Config Object |
| --- | --- |
| `scanner.js` | `SCANNER_CONFIG` |
| `kiosk-display/server.js` | `DISPLAY_SERVER_CONFIG` |
| `kiosk-display/public/app.js` | `DISPLAY_CONFIG` |
| `displayState.js` | `DISPLAY_STATE_CONFIG` |
| `boot.html` | `BOOT_CONFIG` |

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

Do not create shared configuration files unless the same operational policy must be coordinated across multiple runtimes and the maintenance benefit outweighs subsystem isolation risk.

---

## Documentation Roadmap

The README is intended to be the front door to the project. More detailed operational documentation should live under `/docs` as the project matures.

Recommended documentation structure:

```text
/docs
  quickstart.md
  installation.md
  provisioning.md
  operations.md
  troubleshooting.md
  architecture.md
  kiosk-api.md
  observability.md
  qr-configuration.md
  configuration.md
```

Suggested document purposes:

| Document | Purpose |
| --- | --- |
| `quickstart.md` | Minimal path to get a scanner running. |
| `installation.md` | Full Pi setup for a new installer. |
| `provisioning.md` | Provisioning script behavior and update process. |
| `operations.md` | Day-to-day support and validation commands. |
| `troubleshooting.md` | Diagnostic SOPs and recovery steps. |
| `architecture.md` | System design, data flow, and cloud/Pi responsibilities. |
| `kiosk-api.md` | Display API examples and overlay testing commands. |
| `observability.md` | Local health endpoints and diagnostic fields. |
| `qr-configuration.md` | Station, WiFi, and cloud configuration QR workflows. |
| `configuration.md` | Operational constants and subsystem configuration policy. |

---

## Current Documentation Priorities

Near-term documentation work:

1. Build an installation manual for someone other than the original developer to configure and install a scanner/Pi.
2. Recheck and document GitHub startup software-update behavior.
3. Split detailed API examples out of this README and into `/docs/kiosk-api.md`.
4. Split observability details into `/docs/observability.md`.
5. Split operational constants and configuration philosophy into `/docs/configuration.md`.
6. Add troubleshooting SOPs for common Pi, scanner, WiFi, cloud, and kiosk failures.

---

## Refactor Policy

Scanner/display refactors should follow these rules:

1. Preserve runtime behavior.
2. Preserve environment variable names unless a migration path is explicit.
3. Avoid unrelated refactors.
4. Prefer small, safe edits.
5. Maintain appliance reliability as the top priority.
6. Validate behavior on the Pi after deployment.

The current architecture intentionally favors reliability over maximal abstraction.

