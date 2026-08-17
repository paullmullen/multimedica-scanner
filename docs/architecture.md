# Architecture Guide

Purpose:

Technical deep dive into scanner/display architecture.

---

# System Architecture

```text
Scanner
  ↓
bootstrap/lib/scanner-reader.js (evtest; controller-owned)
  ↓
bootstrap/controller.js
  ├─ MMCFG configuration QR → bootstrap QR contract and state stores
  └─ ordinary patient scan → POST 127.0.0.1:3002/api/scan
                              ↓
                         production/scan-server.js
                              ↓
                         Firebase Cloud Function
  ↓
Firestore
  ↓
Kiosk Display
```

---

# Scanner Lifecycle

```text
Scan barcode
→ controller-owned scanner reader
→ configuration QR or local production API routing
→ cloud ingest (production service only)
→ workflow engine
→ response payload
→ display update
→ polling reconciliation
```

---

# Cloud Authority Model

The cloud is authoritative.

The Pi acts as:

- local cache
- display appliance
- event producer

---

# Polling Philosophy

Polling exists to:

- correct drift
- synchronize manual changes
- recover from transient failures

---

# Operational States

Document:

- available
- patient_waiting
- in_process
- clinic_closed
- offline
- degraded

---

# QR Configuration Workflow

```text
Scan QR
→ validate token
→ persist config
→ update config.json/secrets.json
→ commissioning display update

---

# Production Scan Routing

The bootstrap controller is the only process that reads `/dev/input/eventN`
through `evtest`. Configuration QR scans (`MMCFG:`) remain in the controller.
Ordinary patient scans never go directly from the controller to Firebase.

The controller sends ordinary scans to the loopback-only production API:

```text
POST http://127.0.0.1:3002/api/scan
```

The controller creates the scan event identifier and waits up to 10 seconds.
It treats connection failure, timeout, malformed responses, and an unavailable
production service as `unavailable` and instructs the operator to rescan.

`production/scan-server.js` reads non-secret configuration through
`bootstrap/lib/config-store.js`, reads `shared_secret` through
`bootstrap/lib/secrets-store.js`, and is the only local service that forwards
ordinary patient scans to the configured Firebase endpoint. It returns one of
`accepted`, `rejected`, `duplicate`, or `unavailable`.

The production service has no scanner reader and no QR parser. Scanner reader
disconnect/reconnect is handled only by `bootstrap/lib/scanner-reader.js`.

## Local Ports

| Service | Bind address | Port | Implemented endpoints |
|---|---|---:|---|
| Bootstrap controller | `127.0.0.1` | 3000 | `GET /api/status` |
| Bootstrap display | `0.0.0.0` | 3001 | `GET /api/health`, `GET /api/state`, `POST /api/state` |
| Production scan API | `127.0.0.1` | 3002 | `GET /api/status`, `POST /api/scan` |

`multimedica-production.service` remains disabled until later release activation
work. Milestone 4 defines the routing boundary but does not implement Milestone
5 promotion, stable-channel download, or rollback.

## Temporary Hardware Validation

Milestone 4 hardware routing validation uses a distinct PowerShell mode, not
`-Verify` and not a release activation path:

```powershell
.\provision-scanner.ps1 `
  -ValidateProductionCandidate `
  -PiHost <pi-user>@<pi-host> `
  -ResultFile .\provisioning-result.json
```

The mode requires completed Wi-Fi, Station, and Cloud configuration. It refuses
to touch an already active `multimedica-production.service`. It stages the
current workspace production candidate under a unique `/tmp` directory, starts
`production/scan-server.js` temporarily on loopback port 3002, confirms
`GET /api/status`, and prompts the operator to perform a real patient-barcode
round trip, an intentional stopped/unavailable scan, and scanner
disconnect/reconnect validation.

Before and after the reconnect check, the mode verifies that exactly one
`evtest` process exists for `multimedica_edge` and that it is a direct child of
`multimedica-controller.service`. The candidate process is stopped and its
temporary files are removed in `finally`; configuration and secrets remain in
the validated state stores. The result records only safe status fields and a
non-secret warning that the candidate was not enabled or promoted.

---

# Observability Model

Document:

- status endpoints
- stale thresholds
- health state logic
- future dashboard goals
