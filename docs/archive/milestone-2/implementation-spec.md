# Multimedica Scanner Bootstrap — Implementation Specification

**Date:** 2026-08-11  
**Status:** Approved for implementation  
**Repositories inspected:**
- `multimedica-scanner` (scanner Pi runtime)
- `alfarero_clinic` (React/Firebase application)

---

## Table of Contents

1. [Verified Current-State Findings](#1-verified-current-state-findings)
2. [QR Contract: Current vs Proposed](#2-qr-contract-current-vs-proposed)
3. [QR Token Authority and Bootstrap Trust Flow](#3-qr-token-authority-and-bootstrap-trust-flow)
4. [Scanner Routing Protocol](#4-scanner-routing-protocol)
5. [PowerShell Installer Interface](#5-powershell-installer-interface)
6. [Release Activation: Contracts and Algorithm](#6-release-activation-contracts-and-algorithm)
7. [Persistent Filesystem and Configuration](#7-persistent-filesystem-and-configuration)
8. [File Inventory](#8-file-inventory)
9. [Milestone Plan](#9-milestone-plan)
10. [Remaining Product-Owner Decisions](#10-remaining-product-owner-decisions)

---

## 1. Verified Current-State Findings

### 1.1 QR generator code

**Cloud Function generator**

- Repository: `alfarero_clinic`
- File: `functions/generateScannerCloudQr.js`
- Exported handler: `generateScannerCloudQr` (Firebase `onRequest`)
- Handles kinds: `cloud_config` (default), `station_config`, and `wifi_config`
- Authorization: requires `Authorization: Bearer <Firebase ID token>`; the function verifies Firebase Authentication and requires `users/{uid}.permissions.settings`
- Constructs QR strings via `buildQrValue(payload)` → `` `MMCFG:${JSON.stringify(payload)}` ``
- For `cloud_config`: reads server-owned `SCANNER_ENDPOINT_URL`, `SCANNER_SHARED_SECRET`, and `SCANNER_QR_ADMIN_TOKEN`; embeds them into the QR payload
- For `station_config`: takes `location_id`, `room_id`, `station_id`, `device_id` from the POST request body; embeds `SCANNER_QR_ADMIN_TOKEN` as `auth.admin_token`
- For `wifi_config`: validates `ssid`, `password`, and `security` from the POST request; embeds `SCANNER_QR_ADMIN_TOKEN` as `auth.admin_token`

**React component generator**

- Repository: `alfarero_clinic`
- File: `src/pages/settings/sections/ScannerQRGenerator.jsx`
- Handles `show_identity` locally without an `auth` object; it is a non-configuration command
- Calls the Cloud Function for `cloud_config`, `station_config`, and `wifi_config` with a Firebase ID token and renders the returned `qrValue`

### 1.2 QR parser

- Repository: `multimedica-scanner`
- File: `configQr.js` (to be moved to `bootstrap/lib/qr-contract.js`)
- Entry functions: `isConfigQr(scanValue)`, `handleConfigQr(scanValue)`
- `isConfigQr`: returns `true` if `scanValue.startsWith("MMCFG:")`
- `handleConfigQr`: strips prefix, parses JSON, validates version, requires `auth.admin_token` for protected kinds, and dispatches by kind

### 1.3 Token source and exposure

- `SCANNER_QR_ADMIN_TOKEN` is a single fleet-wide secret shared by all Pi devices and the Cloud Function
- The backend stores it as a Secret Manager-bound `SCANNER_QR_ADMIN_TOKEN`; the React application does not receive or contain this value
- The installer transfers the same value as `qr_admin_token` into the Pi secrets store
- The backend caller credential is a Firebase ID token and is separate from the QR bearer credential

### 1.4 Current scanner runtime

- File: `multimedica-scanner/scanner.js`
- On startup: throws `Error("Missing SHARED_SECRET environment variable")` if `SHARED_SECRET` is absent — this is the primary bootstrap blocker
- Scanner input: one process owns the USB scanner via `sudo evtest <device>`; no other process reads it
- `main()` calls `startStatusServer()` then `syncDisplayFromCloud("boot", 3000)` (3-second delay) then `scannerSupervisorLoop()` — the boot sync makes a real HTTPS call to the cloud endpoint
- Scan routing: `isConfigQr()` is checked before any cloud post; config QRs go to `handleConfigScan()`; ordinary scans go to `postScan()` which posts directly to `ENDPOINT_URL` (Firebase Cloud Function, not localhost)
- Status HTTP server: `127.0.0.1:3002` (`GET /api/status`, `GET /api/status/summary`); no `POST /api/scan` endpoint exists today
- `applyWifiConfig({ ssid, password })` always uses `wpa-psk` via nmcli regardless of the `security` field in the QR payload

### 1.5 Current persistence

- `configQr.js` writes all accepted values via `updateEnvFile()` to `/home/multimedica_edge/scanner/.env`
- `wifi_config` does **not** write to `.env`; `handleWifiConfig` returns `result.runtime = { ssid, password }` which `scanner.js` passes directly to `applyWifiConfig()`
- `wifi_config` **drops `payload.security`** silently; it is in the generator output but not read by the parser

### 1.6 Confirmed generator/parser mismatches

| Kind | Mismatch |
|---|---|
| `wifi_config` | Generator emits `payload.security` (e.g., `"wpa-psk"`); parser ignores it; `applyWifiConfig` hardcodes `wpa-psk` |
| All others | No mismatch |

### 1.7 Duplicate `show_identity` handler

`scanner.js` contains two identical `if (result.kind === "show_identity")` blocks in `handleConfigScan()`. One must be removed during refactoring.

---

## 2. QR Contract: Current vs Proposed

### 2.1 Common envelope

All QR kinds use the same outer envelope. This contract is preserved unchanged in v1.

**Current envelope (confirmed in both generator and parser):**

```json
{
  "kind": "<kind>",
  "version": 1,
  "payload": {},
  "auth": {
    "admin_token": "<redacted>"
  }
}
```

**Common validation rules (current, `configQr.js` `handleConfigQr`):**

1. Scan value must begin with `MMCFG:`
2. Remainder must parse as valid JSON
3. `data.kind` must be present and non-empty
4. `data.version` must be present and strictly equal `1`; any other value → `{ ok: false, error: "Unsupported version: N" }`
5. `requireAdminAuth(data)`: `data.auth.admin_token` must exactly equal `process.env.SCANNER_QR_ADMIN_TOKEN`; if the env var is absent → `{ ok: false, error: "Missing SCANNER_QR_ADMIN_TOKEN in environment" }`
6. Unknown `kind` values → `{ ok: false, error: "Unknown config kind: <kind>" }`

**Proposed v1 common rules:** identical to current. Token is read from the persistent secrets file at startup rather than an `.env` file, but `requireAdminAuth` logic does not change.

---

### 2.2 `wifi_config`

**Generator:** `src/pages/settings/sections/ScannerQRGenerator.jsx`, `localPayloadObject` useMemo, browser-side  
**Parser:** `configQr.js` → `handleWifiConfig()`; side effects in `scanner.js` → `handleConfigScan()` → `applyWifiConfig()`

**Literal current QR string (credentials redacted):**

```
MMCFG:{"kind":"wifi_config","version":1,"payload":{"ssid":"ClinicWifi","password":"<wifi-password>","security":"wpa-psk"},"auth":{"admin_token":"<redacted>"}}
```

**Literal decoded JSON:**

```json
{
  "kind": "wifi_config",
  "version": 1,
  "payload": {
    "ssid": "ClinicWifi",
    "password": "<wifi-password>",
    "security": "wpa-psk"
  },
  "auth": {
    "admin_token": "<redacted>"
  }
}
```

| Field | Generator | Parser (current) | Proposed v1 |
|---|---|---|---|
| `payload.ssid` | Required | Required; checked present | Required; must be non-empty string |
| `payload.password` | Required; empty string blocked in UI | Required; checked `!== undefined` only | Required; empty string permitted (open network) |
| `payload.security` | Optional; UI default `"wpa-psk"` | **Silently dropped** | Accept and pass through to `applyWifiConfig`; accepted values: `wpa-psk`, `none` |

**Current validation:** `ssid` present, `password !== undefined`  
**Proposed v1 validation:** `ssid` non-empty string; `password` present; `security` when present must be `"wpa-psk"` or `"none"`

**Persistent storage (proposed):** `ssid` and `security` → `config.json`; `password` → `secrets.json`  
**Side effects:** removes existing nmcli connections with matching SSID; adds new connection; applies security; brings up connection; marks Wi-Fi configured in state  
**Secret handling:** `password` logged as `[REDACTED]`; never written to `config.json`  
**Supported schema versions:** `1`

---

### 2.3 `station_config`

**Generator:** `functions/generateScannerCloudQr.js`, `generateScannerCloudQr`, `kind === "station_config"` branch, Cloud Function  
**Parser:** `configQr.js` → `handleStationConfig()`; side effects in `scanner.js` → `handleConfigScan()`

**Literal current QR string:**

```
MMCFG:{"kind":"station_config","version":1,"payload":{"location_id":"loc1","room_id":"loc1_nursing_room_1","station_id":"nursing","device_id":"scanner_loc1_nursing_01"},"auth":{"admin_token":"<redacted>"}}
```

**Literal decoded JSON:**

```json
{
  "kind": "station_config",
  "version": 1,
  "payload": {
    "location_id": "loc1",
    "room_id": "loc1_nursing_room_1",
    "station_id": "nursing",
    "device_id": "scanner_loc1_nursing_01"
  },
  "auth": {
    "admin_token": "<redacted>"
  }
}
```

**Generator/parser mismatch:** None. Fields are identical.

**Required:** `location_id`, `room_id`, `station_id`, `device_id`  
**Optional:** none  
**Current validation:** each field checked for truthiness individually  
**Proposed v1 validation:** same checks plus pattern `^[A-Za-z0-9_-]+$` on each value  
**Persistent storage:** all four values → `config.json`; no secrets  
**Side effects:** updates runtime variables; triggers display sync after 2500 ms  
**Secret handling:** none  
**Supported schema versions:** `1`

---

### 2.4 `cloud_config`

**Generator:** `functions/generateScannerCloudQr.js`, `generateScannerCloudQr`, default `kind === "cloud_config"` branch, Cloud Function; reads `SCANNER_ENDPOINT_URL`, `SCANNER_SHARED_SECRET`, `SCANNER_QR_ADMIN_TOKEN` from Cloud Function environment  
**Parser:** `configQr.js` → `handleCloudConfig()`; side effects in `scanner.js` → `handleConfigScan()`

**Literal current QR string (credentials redacted):**

```
MMCFG:{"kind":"cloud_config","version":1,"payload":{"endpoint_url":"https://us-central1-alfarero-478ad.cloudfunctions.net/receiveRoomScanEvent","shared_secret":"<shared-secret>"},"auth":{"admin_token":"<redacted>"}}
```

**Literal decoded JSON:**

```json
{
  "kind": "cloud_config",
  "version": 1,
  "payload": {
    "endpoint_url": "https://us-central1-alfarero-478ad.cloudfunctions.net/receiveRoomScanEvent",
    "shared_secret": "<shared-secret>"
  },
  "auth": {
    "admin_token": "<redacted>"
  }
}
```

**Generator/parser mismatch:** None. `SYNC_ENDPOINT_URL` is derived in `scanner.js` by replacing `receiveRoomScanEvent` with `syncStationDisplayState`; neither generator nor parser carries it explicitly.

**Required:** `endpoint_url`, `shared_secret`  
**Optional:** none  
**Current validation:** both fields checked for truthiness  
**Proposed v1 validation:** `endpoint_url` must match `^https://`; `shared_secret` non-empty  
**Persistent storage:** `endpoint_url` → `config.json`; `shared_secret` → `secrets.json`  
**Side effects:** updates runtime `SHARED_SECRET`, `ENDPOINT_URL`, `SYNC_ENDPOINT_URL`; triggers display sync after 2500 ms  
**Secret handling:** `shared_secret` appears in the printed QR and is stored in `secrets.json` only; logged as `[REDACTED]`  
**Supported schema versions:** `1`

---

### 2.5 `show_identity`

**Generator:** `src/pages/settings/sections/ScannerQRGenerator.jsx`, `localPayloadObject` useMemo, `qrType === "show_identity"` branch, browser-side  
**Parser:** `configQr.js` → `handleConfigQr()`, `data.kind === "show_identity"` branch (no kind-specific validator); `scanner.js` → `showIdentityDisplay()`

**Literal current QR string:**

```
MMCFG:{"kind":"show_identity","version":1,"payload":{}}
```

**Literal decoded JSON:**

```json
{
  "kind": "show_identity",
  "version": 1,
  "payload": {},
}
```

**Generator/parser mismatch:** None.

**Required:** `kind`, `version`, and an empty `payload`; no `auth` object is required
**Optional:** `payload` key present but empty; parser does not inspect payload contents  
**Persistent storage:** none; no config mutations  
**Side effects:** display enters identity mode  
**Secret handling:** none  
**Supported schema versions:** `1`

---

### 2.6 Contract test fixtures

The following files must exist in the repository and remain in sync with both the generator and the parser. CI runs `tests/qr-contract.test.js` against every fixture on every push.

**`tests/fixtures/qr_wifi_config.json`**
```json
{
  "qrString": "MMCFG:{\"kind\":\"wifi_config\",\"version\":1,\"payload\":{\"ssid\":\"TestNet\",\"password\":\"test-pass\",\"security\":\"wpa-psk\"},\"auth\":{\"admin_token\":\"test-token\"}}",
  "expectedResult": {
    "ok": true,
    "kind": "wifi_config",
    "applied": { "SSID": "TestNet" },
    "runtime": { "ssid": "TestNet", "password": "test-pass", "security": "wpa-psk" }
  }
}
```

**`tests/fixtures/qr_station_config.json`**
```json
{
  "qrString": "MMCFG:{\"kind\":\"station_config\",\"version\":1,\"payload\":{\"location_id\":\"loc1\",\"room_id\":\"loc1_nursing_room_1\",\"station_id\":\"nursing\",\"device_id\":\"scanner_loc1_nursing_01\"},\"auth\":{\"admin_token\":\"test-token\"}}",
  "expectedResult": {
    "ok": true,
    "kind": "station_config",
    "applied": {
      "LOCATION_ID": "loc1",
      "ROOM_ID": "loc1_nursing_room_1",
      "STATION_ID": "nursing",
      "DEVICE_ID": "scanner_loc1_nursing_01"
    }
  }
}
```

**`tests/fixtures/qr_cloud_config.json`**
```json
{
  "qrString": "MMCFG:{\"kind\":\"cloud_config\",\"version\":1,\"payload\":{\"endpoint_url\":\"https://example.invalid/receiveRoomScanEvent\",\"shared_secret\":\"test-secret\"},\"auth\":{\"admin_token\":\"test-token\"}}",
  "expectedResult": {
    "ok": true,
    "kind": "cloud_config",
    "applied": {
      "ENDPOINT_URL": "https://example.invalid/receiveRoomScanEvent",
      "SHARED_SECRET": "[REDACTED]"
    }
  }
}
```

**`tests/fixtures/qr_show_identity.json`**
```json
{
  "qrString": "MMCFG:{\"kind\":\"show_identity\",\"version\":1,\"payload\":{},\"auth\":{\"admin_token\":\"test-token\"}}",
  "expectedResult": {
    "ok": true,
    "kind": "show_identity",
    "applied": {},
    "runtime": {}
  }
}
```

**`tests/fixtures/qr_invalid_version.json`**
```json
{
  "qrString": "MMCFG:{\"kind\":\"wifi_config\",\"version\":2,\"payload\":{\"ssid\":\"TestNet\",\"password\":\"pass\"},\"auth\":{\"admin_token\":\"test-token\"}}",
  "expectedResult": { "ok": false, "error": "Unsupported version: 2" }
}
```

**`tests/fixtures/qr_invalid_token.json`**
```json
{
  "qrString": "MMCFG:{\"kind\":\"show_identity\",\"version\":1,\"payload\":{},\"auth\":{\"admin_token\":\"wrong-token\"}}",
  "expectedResult": { "ok": false, "error": "Invalid admin token" }
}
```

**`tests/fixtures/qr_missing_kind.json`**
```json
{
  "qrString": "MMCFG:{\"version\":1,\"payload\":{},\"auth\":{\"admin_token\":\"test-token\"}}",
  "expectedResult": { "ok": false, "error": "Invalid config format" }
}
```

**`tests/fixtures/qr_unknown_kind.json`**
```json
{
  "qrString": "MMCFG:{\"kind\":\"unknown_kind\",\"version\":1,\"payload\":{},\"auth\":{\"admin_token\":\"test-token\"}}",
  "expectedResult": { "ok": false, "error": "Unknown config kind: unknown_kind" }
}
```

**`tests/fixtures/qr_malformed_json.json`**
```json
{
  "qrString": "MMCFG:not-valid-json",
  "expectedResult": { "ok": false }
}
```

Contract tests verify that `handleConfigQr` called with `SCANNER_QR_ADMIN_TOKEN=test-token` produces the `expectedResult` for each fixture.

---

## 3. QR Token Authority and Bootstrap Trust Flow

### 3.1 Current token distribution

1. The token is stored in the Cloud Function deployment environment as `SCANNER_QR_ADMIN_TOKEN` (server-side, not public)
2. The same token value is installed on the Pi as `qr_admin_token` in the validated secrets store
3. The Cloud Function embeds the token into every generated QR payload as `auth.admin_token`
4. The Pi reads the token from its validated secrets store at runtime to validate protected QRs
5. The token reaches the Pi through the existing PowerShell installer transfer flow

### 3.2 Proposed v1 trust flow

The token is fleet-wide and preserved unchanged for v1. It must not appear in public artifacts or command-line arguments.

**Windows installer configuration file**

```
Default path: .\multimedica-installer.json
Override:     -InstallerConfig <path>
Format:       JSON (see schema below)
Permissions:  Windows ACL — readable only by the running user account
```

**Installer config schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["qr_admin_token", "shared_secret", "endpoint_url"],
  "additionalProperties": false,
  "properties": {
    "qr_admin_token": { "type": "string", "minLength": 1 },
    "shared_secret":  { "type": "string", "minLength": 1 },
    "endpoint_url":   { "type": "string", "pattern": "^https://" }
  }
}
```

**Example (credentials redacted):**

```json
{
  "qr_admin_token": "<redacted>",
  "shared_secret": "<shared-secret>",
  "endpoint_url": "https://us-central1-alfarero-478ad.cloudfunctions.net/receiveRoomScanEvent"
}
```

**Transfer to Pi:**

1. PowerShell reads `multimedica-installer.json` into in-memory variables at startup
2. It writes a secrets payload to a Windows temp file (`[IO.Path]::GetTempFileName()`) with a strict ACL applied immediately
3. It transfers the temp file to the Pi via `scp` to `/tmp/multimedica-secrets-transfer` (mode `0600`, root-owned, set immediately on arrival)
4. The Pi-side bootstrap installer moves the values atomically into `/var/lib/multimedica-scanner/state/secrets.json` and removes the transfer file
5. PowerShell deletes the Windows temp file with `Remove-Item -Force` after transfer
6. PowerShell never prints or logs secret values; log output substitutes `[REDACTED]`

### 3.3 Token availability during bootstrap

Because the controller reads `SCANNER_QR_ADMIN_TOKEN` from `secrets.json` at startup, QR validation works from the first boot after bootstrap installation, before any production cloud credentials are scanned. This is the bootstrap trust anchor: the installer installs the fleet token, and all QRs are validated against it from that point forward.

---

## 4. Scanner Routing Protocol

### 4.1 Ownership

The controller (`bootstrap/controller.js` → `multimedica-controller.service`) owns the USB barcode scanner for the entire appliance lifetime. No other process reads the scanner device.

### 4.2 Routing logic

1. Controller reads every scan from `sudo evtest <device>`
2. If the scan begins with `MMCFG:`, it is a provisioning QR — handled locally by the controller
3. All other scans are ordinary patient scans — forwarded to the production service via `POST http://127.0.0.1:3002/api/scan`
4. If production is unavailable, the display instructs the user to rescan; scans are not queued

### 4.3 `POST /api/scan` endpoint

The production service (`scanner.js` refactored) exposes this endpoint on the existing `SCANNER_STATUS_PORT` (default 3002) alongside `GET /api/status`.

```
POST http://127.0.0.1:3002/api/scan
Content-Type: application/json
```

No authentication header required; binding is loopback-only.

**Controller timeout:** 10 000 ms. If no response is received within 10 seconds the controller treats the result as `unavailable`.

### 4.4 Request schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": [
    "event_id", "visit_id", "raw_scan_value",
    "room_id", "station_id", "device_id",
    "event_type", "source_type", "device_timestamp_utc"
  ],
  "properties": {
    "event_id":             { "type": "string", "format": "uuid" },
    "visit_id":             { "type": "string" },
    "raw_scan_value":       { "type": "string" },
    "location_id":          { "type": ["string", "null"] },
    "room_id":              { "type": "string" },
    "station_id":           { "type": "string" },
    "device_id":            { "type": "string" },
    "event_type":           { "type": "string", "const": "scan_received" },
    "source_type":          { "type": "string", "const": "PI_SCANNER" },
    "device_timestamp_utc": { "type": "string", "format": "date-time" }
  }
}
```

**Example request:**

```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "visit_id": "VISIT:12345",
  "raw_scan_value": "VISIT:12345",
  "location_id": "loc1",
  "room_id": "loc1_nursing_room_1",
  "station_id": "nursing",
  "device_id": "scanner_loc1_nursing_01",
  "event_type": "scan_received",
  "source_type": "PI_SCANNER",
  "device_timestamp_utc": "2026-08-11T10:00:00.000Z"
}
```

`event_id` is generated by the controller using `crypto.randomUUID()` (already used in the current `buildPayload()` in `scanner.js`).

### 4.5 Response schemas

**Accepted (HTTP 200):**

```json
{
  "ok": true,
  "disposition": "accepted",
  "duplicate": false,
  "reason": null
}
```

**Rejected (HTTP 200; cloud returned error):**

```json
{
  "ok": false,
  "disposition": "rejected",
  "duplicate": false,
  "reason": "HTTP 400 from cloud endpoint"
}
```

**Duplicate (HTTP 200):**

```json
{
  "ok": false,
  "disposition": "duplicate",
  "duplicate": true,
  "reason": "event_id already seen within dedup window"
}
```

**Unavailable (HTTP 503 or connection refused):**

```json
{
  "ok": false,
  "disposition": "unavailable",
  "duplicate": false,
  "reason": "production service not ready"
}
```

### 4.6 Duplicate-processing note

The existing `scanner.js` `buildPayload()` already generates a `crypto.randomUUID()` `event_id` per scan. The downstream Firebase Cloud Function (`receiveRoomScanEvent`) is responsible for visit-level idempotency. The production service's `POST /api/scan` handler forwards scans to the cloud and relays the cloud's response; it does not add a new dedup layer. **Duplicate prevention and patient-visit idempotency are outside the scope of this deployment work and are not redesigned here.**

Follow-up item (does not block implementation): confirm that the `event_id` generated per-scan in the controller is stable enough for the cloud function's existing dedup logic when the controller generates a fresh UUID per forward attempt after a transient failure.

### 4.7 Behavior by production state

| Production state | Controller behavior | User-visible message |
|---|---|---|
| Healthy | Posts to `POST /api/scan`; relays disposition | Normal clinic UI |
| Starting | 10 s timeout → `unavailable` | "Sistema iniciando, vuelva a escanear" |
| Stopped (bootstrap mode) | Immediate `unavailable` | "Sistema en modo configuración" |
| Updating | Immediate `unavailable` | "Actualización en progreso, vuelva a escanear" |
| Rollback in progress | Immediate `unavailable` | "Recuperando sistema, vuelva a escanear" |
| Unhealthy / crashed | 10 s timeout → `unavailable` | "Error del sistema, vuelva a escanear" |

### 4.8 Code migration from current `scanner.js`

| Current location in `scanner.js` | Moves to |
|---|---|
| `isConfigQr()` call | Controller (unchanged, imported from `bootstrap/lib/qr-contract.js`) |
| `handleConfigScan()` | Controller |
| `applyWifiConfig()` | Controller (`bootstrap/lib/wifi-manager.js`) |
| `startScannerListener()` / `evtest` loop | Controller (`bootstrap/lib/scanner-reader.js`) |
| `postScan()` | Production service only (unchanged; posts to cloud) |
| `buildPayload()` | Production service only (unchanged) |
| `startStatusServer()` `GET /api/status` | Both controller and production service expose their own status endpoints |
| New `POST /api/scan` | Production service only (`production/scan-server.js`) |

---

## 5. PowerShell Installer Interface

### 5.1 Parameter set declarations

```powershell
[CmdletBinding(DefaultParameterSetName = "Verify")]
param(
    # --- Mode switches (mutually exclusive) ---
    [Parameter(Mandatory, ParameterSetName = "Install")]
    [switch]$Install,

    [Parameter(Mandatory, ParameterSetName = "Verify")]
    [switch]$Verify,

    [Parameter(Mandatory, ParameterSetName = "Commission")]
    [switch]$Commission,

    [Parameter(Mandatory, ParameterSetName = "Repair")]
    [switch]$Repair,

    [Parameter(Mandatory, ParameterSetName = "InstallRelease")]
    [switch]$InstallRelease,

    [Parameter(Mandatory, ParameterSetName = "RollbackRelease")]
    [switch]$RollbackRelease,

    # --- Required in all modes ---
    [Parameter(Mandatory, ParameterSetName = "Install")]
    [Parameter(Mandatory, ParameterSetName = "Verify")]
    [Parameter(Mandatory, ParameterSetName = "Commission")]
    [Parameter(Mandatory, ParameterSetName = "Repair")]
    [Parameter(Mandatory, ParameterSetName = "InstallRelease")]
    [Parameter(Mandatory, ParameterSetName = "RollbackRelease")]
    [string]$PiHost,

    # --- Required for release modes ---
    [Parameter(Mandatory, ParameterSetName = "InstallRelease")]
    [Parameter(Mandatory, ParameterSetName = "RollbackRelease")]
    [string]$ReleaseVersion,

    # --- Optional in all modes ---
    [Parameter(ParameterSetName = "Install")]
    [Parameter(ParameterSetName = "Verify")]
    [Parameter(ParameterSetName = "Commission")]
    [Parameter(ParameterSetName = "Repair")]
    [Parameter(ParameterSetName = "InstallRelease")]
    [Parameter(ParameterSetName = "RollbackRelease")]
    [int]$PiPort = 22,

    [Parameter(ParameterSetName = "Install")]
    [Parameter(ParameterSetName = "Verify")]
    [Parameter(ParameterSetName = "Commission")]
    [Parameter(ParameterSetName = "Repair")]
    [Parameter(ParameterSetName = "InstallRelease")]
    [Parameter(ParameterSetName = "RollbackRelease")]
    [string]$ResultFile = ".\provisioning-result.json",

    # --- Installer config (carries secrets; not logged) ---
    [Parameter(ParameterSetName = "Install")]
    [Parameter(ParameterSetName = "Commission")]
    [Parameter(ParameterSetName = "Repair")]
    [Parameter(ParameterSetName = "InstallRelease")]
    [string]$InstallerConfig = ".\multimedica-installer.json",

    # --- Optional release override for Commission ---
    [Parameter(ParameterSetName = "Commission")]
    [string]$ReleaseVersion,

    # --- Flags ---
    [Parameter(ParameterSetName = "Install")]
    [switch]$NoReboot,

    [Parameter(ParameterSetName = "Install")]
    [Parameter(ParameterSetName = "Repair")]
    [switch]$Force,

    [Parameter(ParameterSetName = "Commission")]
    [switch]$WaitForQr
)
```

### 5.2 Host-key handling

All SSH invocations use:
```
-o StrictHostKeyChecking=accept-new
```

When a Pi is re-imaged and the host key changes, SSH will refuse with a "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED" error. PowerShell detects this and fails with exit code `1`, printing:

```
ERROR: Host key mismatch for <PiHost>.
The Pi may have been re-imaged. If this is expected, remove the old key:
  ssh-keygen -R <PiHost>
Then rerun the installer.
```

The installer never automatically removes a stored host key.

### 5.3 Hostname collision handling

During `-Install` preflight, PowerShell queries the Pi's current hostname. If the hostname is `raspberrypi` (the Raspberry Pi OS default) or matches another Pi already recorded in the local result log, it prints a warning and prompts for confirmation before continuing unless `-Force` is passed.

### 5.4 Mode: `-Install`

**Purpose:** Install bootstrap layer. Returns with bootstrap acceptance (point A).

**Required parameters:** `-PiHost`  
**Optional parameters:** `-PiPort`, `-InstallerConfig`, `-NoReboot`, `-Force`, `-ResultFile`

**Preflight checks (Windows):**
- PowerShell version ≥ 5.1
- `ssh.exe` and `scp.exe` available
- `-InstallerConfig` file exists and validates against installer config schema
- Bootstrap package present at expected path

**Preflight checks (Pi, no mutations):**
- SSH reachable on specified port
- OS is Raspberry Pi OS Lite 64-bit (checked via `/etc/os-release`)
- CPU model is BCM2711 (Pi 4) (checked via `/proc/cpuinfo`)
- Architecture is `aarch64`
- Available disk space ≥ 8 GB on `/`
- `multimedica_edge` user exists or can be created
- Hostname is unique (warning if default)

**Pi mutations permitted:**
- `apt-get install` of bootstrap package list
- Create `multimedica_edge` user and home directory if absent
- Install systemd service units
- Write `/var/lib/multimedica-scanner/state/secrets.json`
- Write initial `/var/lib/multimedica-scanner/state/config.json`
- Configure tty1 autologin
- Enable and start `multimedica-controller.service` and `multimedica-display.service`

**Reboot behavior:** Reboots once unless `-NoReboot`. Reconnects over SSH after reboot (up to 3 minutes, polling every 15 seconds). Re-queries service health after reconnect.

**Timeout:** 15 minutes total; each remote command 5 minutes.

**Safe rerun:** Preserves existing `secrets.json` unless `-Force`. Skips package installation if already installed.

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Bootstrap acceptance complete (point A) |
| 10 | Bootstrap partially complete (services running but reboot not yet verified or scanner not detected) |
| 20 | Hard failure (preflight rejected, SSH unavailable, install failed) |

**Bootstrap acceptance — point A — all of the following must be true:**
1. Platform preflight checks passed
2. Bootstrap packages installed
3. `multimedica-controller.service` active
4. `multimedica-display.service` active
5. Controller `/api/status` responds
6. Reboot recovery verified (services auto-start after reboot)
7. `scanner_device_detected: true` — USB scanner device found in `/proc/bus/input/devices`
8. `provisioning_qr_parsed` — **reported separately as a manual verification step**; PowerShell prints a prompt:

    ```
    ACTION REQUIRED: Scan any provisioning QR with the scanner device.
    Watching controller status for 120 seconds...
    ```

    If a config QR is parsed within the window: `provisioning_qr_parsed: true`.  
    If the timeout expires: `provisioning_qr_parsed: null` and exit code `10` with message:

    ```
    WARNING: Scanner device detected but no provisioning QR was parsed.
    This may mean the scanner is not working or no QR was scanned.
    Bootstrap is otherwise complete. Re-verify with -Verify after testing.
    ```

---

### 5.5 Mode: `-Verify`

**Purpose:** Read and report current device state. No mutations.

**Required:** `-PiHost`  
**Optional:** `-PiPort`, `-ResultFile`

**Preflight:** SSH reachable.  
**Pi mutations:** None.  
**Reboot:** None.  
**Timeout:** 2 minutes.  
**Safe rerun:** Always safe; read-only.

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | All acceptance criteria for the highest completed phase are met |
| 10 | Partially complete (some criteria met, others pending) |
| 20 | Cannot connect or critical service absent |

---

### 5.6 Mode: `-Commission`

**Purpose:** Verify required QRs accepted, network connected, approved release installed, production healthy, final reboot verified (acceptance point B).

**Required:** `-PiHost`  
**Optional:** `-PiPort`, `-InstallerConfig`, `-ReleaseVersion`, `-WaitForQr`, `-ResultFile`

**`-WaitForQr`:** When set, polls Pi device state every 30 seconds for up to 60 minutes waiting for required configuration to be present. Without this flag, checks current state and exits immediately.

**Preflight:** Bootstrap must be at point A (fails fast if not).  
**Pi mutations:** Triggers release download and installation if network and required configuration are present.  
**Reboot:** Performs final reboot and recovery verification.  
**Timeout:** 90 minutes with `-WaitForQr`; 5 minutes without.

**Device commissioning — point B — all of the following must be true:**
1. All required QRs accepted (`wifi_config`, `station_config`, `cloud_config`)
2. Network connected (confirmed via `nmcli general status`)
3. Stable-channel manifest fetched (or explicit version provided)
4. Release artifact downloaded and SHA-256 verified
5. Candidate started, health check passed, candidate stopped
6. Version directory atomically renamed from staging
7. `current` symlink updated
8. Production service started on normal port
9. Production `GET /api/status` responds healthy
10. `multimedica-production.service` active
11. Final reboot and recovery verified

**Exit codes:** Same as `-Install` (0, 10, 20).

---

### 5.7 Mode: `-Repair`

**Purpose:** Re-run bootstrap installation steps without destroying configuration.

**Required:** `-PiHost`  
**Optional:** `-PiPort`, `-InstallerConfig`, `-Force`, `-ResultFile`

**Pi mutations:** Re-runs bootstrap install steps. Without `-Force`, never overwrites existing valid `secrets.json` or `config.json`.  
**Reboot:** Optional; defaults to no reboot unless services fail to restart.  
**Timeout:** 15 minutes.  
**Safe rerun:** Safe. Preserves configuration.

---

### 5.8 Mode: `-InstallRelease`

**Purpose:** Download, verify, and activate a specific named release version.

**Required:** `-PiHost`, `-ReleaseVersion`  
**Optional:** `-PiPort`, `-InstallerConfig`, `-ResultFile`

**Pi mutations:** Downloads and activates the named release.  
**Reboot:** Production service is restarted; full Pi reboot not required.  
**Timeout:** 30 minutes.

---

### 5.9 Mode: `-RollbackRelease`

**Purpose:** Roll back to a named prior release already installed on the device.

**Required:** `-PiHost`, `-ReleaseVersion`  
**Optional:** `-PiPort`, `-ResultFile`

**Precondition:** The named version directory must exist under `/opt/multimedica-scanner/releases/`.  
**Pi mutations:** Updates `current` symlink; restarts production service.  
**Reboot:** Not required.  
**Timeout:** 10 minutes.

---

### 5.10 Machine-readable result schema

PowerShell writes `provisioning-result.json` (or `-ResultFile` path) at the end of every run.

**JSON Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["mode", "timestamp", "pi_host", "exit_code", "bootstrap_complete", "commissioning_complete"],
  "properties": {
    "mode":                   { "type": "string", "enum": ["Install","Verify","Commission","Repair","InstallRelease","RollbackRelease"] },
    "timestamp":              { "type": "string", "format": "date-time" },
    "pi_host":                { "type": "string" },
    "exit_code":              { "type": "integer" },
    "bootstrap_complete":     { "type": "boolean" },
    "commissioning_complete": { "type": "boolean" },
    "platform_verified":      { "type": ["boolean", "null"] },
    "services_healthy":       { "type": ["boolean", "null"] },
    "reboot_verified":        { "type": ["boolean", "null"] },
    "scanner_device_detected":{ "type": ["boolean", "null"] },
    "provisioning_qr_parsed": { "type": ["boolean", "null"], "description": "null means not tested in this run" },
    "network_connected":      { "type": ["boolean", "null"] },
    "release_installed":      { "type": ["boolean", "null"] },
    "release_version":        { "type": ["string", "null"] },
    "production_healthy":     { "type": ["boolean", "null"] },
    "errors":                 { "type": "array", "items": { "type": "string" } },
    "warnings":               { "type": "array", "items": { "type": "string" } }
  }
}
```

**Example (successful bootstrap install):**

```json
{
  "mode": "Install",
  "timestamp": "2026-08-11T10:00:00Z",
  "pi_host": "scanner01.local",
  "exit_code": 0,
  "bootstrap_complete": true,
  "commissioning_complete": false,
  "platform_verified": true,
  "services_healthy": true,
  "reboot_verified": true,
  "scanner_device_detected": true,
  "provisioning_qr_parsed": true,
  "network_connected": null,
  "release_installed": null,
  "release_version": null,
  "production_healthy": null,
  "errors": [],
  "warnings": []
}
```

---

## 6. Release Activation: Contracts and Algorithm

### 6.1 Stable-channel manifest

**Hosted at (fixed public HTTPS URL):**

```
https://raw.githubusercontent.com/paullmullen/multimedica-scanner/main/release/stable-channel.json
```

Reading this URL does not itself authorize installation. The controller checks it only when an explicit installation action is triggered by PowerShell. Automatic installation of the newest release is disabled in v1.

**Committed path in repository:** `release/stable-channel.json`

**JSON Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["channel","approved_version","artifact_url","sha256","min_bootstrap_version","os_id","arch","pi_model","node_semver","config_schema_version","qr_schema_version","published_at"],
  "properties": {
    "channel":               { "type": "string", "const": "stable" },
    "approved_version":      { "type": "string" },
    "artifact_url":          { "type": "string", "pattern": "^https://" },
    "sha256":                { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "min_bootstrap_version": { "type": "string" },
    "os_id":                 { "type": "string" },
    "arch":                  { "type": "string", "enum": ["arm64"] },
    "pi_model":              { "type": "string", "enum": ["rpi4"] },
    "node_semver":           { "type": "string" },
    "config_schema_version": { "type": "integer", "minimum": 1 },
    "qr_schema_version":     { "type": "integer", "minimum": 1 },
    "published_at":          { "type": "string", "format": "date-time" }
  }
}
```

**Example (version placeholder):**

```json
{
  "channel": "stable",
  "approved_version": "1.0.0",
  "artifact_url": "https://github.com/paullmullen/multimedica-scanner/releases/download/v1.0.0/multimedica-scanner-1.0.0.tgz",
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "min_bootstrap_version": "1.0.0",
  "os_id": "raspios-bookworm-arm64-lite",
  "arch": "arm64",
  "pi_model": "rpi4",
  "node_semver": ">=20.0.0 <21.0.0",
  "config_schema_version": 1,
  "qr_schema_version": 1,
  "published_at": "2026-08-01T00:00:00Z"
}
```

---

### 6.2 Release manifest (embedded in artifact)

The release artifact is a `.tgz` file containing `manifest.json` at its root.

**JSON Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["name","version","sha256","os_id","arch","pi_model","node_semver","config_schema_version","qr_schema_version","min_bootstrap_version","entry_point","health_endpoint","candidate_port","built_at"],
  "properties": {
    "name":                  { "type": "string" },
    "version":               { "type": "string" },
    "sha256":                { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "os_id":                 { "type": "string" },
    "arch":                  { "type": "string", "enum": ["arm64"] },
    "pi_model":              { "type": "string", "enum": ["rpi4"] },
    "node_semver":           { "type": "string" },
    "config_schema_version": { "type": "integer", "minimum": 1 },
    "qr_schema_version":     { "type": "integer", "minimum": 1 },
    "min_bootstrap_version": { "type": "string" },
    "entry_point":           { "type": "string" },
    "health_endpoint":       { "type": "string" },
    "candidate_port":        { "type": "integer" },
    "built_at":              { "type": "string", "format": "date-time" }
  }
}
```

**Example:**

```json
{
  "name": "multimedica-scanner",
  "version": "1.0.0",
  "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "os_id": "raspios-bookworm-arm64-lite",
  "arch": "arm64",
  "pi_model": "rpi4",
  "node_semver": ">=20.0.0 <21.0.0",
  "config_schema_version": 1,
  "qr_schema_version": 1,
  "min_bootstrap_version": "1.0.0",
  "entry_point": "scanner.js",
  "health_endpoint": "http://127.0.0.1:3002/api/status",
  "candidate_port": 3003,
  "built_at": "2026-08-01T00:00:00Z"
}
```

`candidate_port` (3003) is the port the candidate process binds to during isolated validation; the production process binds to 3002.

---

### 6.3 Release transaction record

**Path:** `/var/lib/multimedica-scanner/state/releases/transactions/<txn-id>.json`

**JSON Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["txn_id","started_at","target_version","stage","stages_completed"],
  "properties": {
    "txn_id":            { "type": "string" },
    "started_at":        { "type": "string", "format": "date-time" },
    "target_version":    { "type": "string" },
    "stage":             { "type": "string" },
    "stages_completed":  { "type": "array", "items": { "type": "string" } },
    "artifact_path":     { "type": ["string", "null"] },
    "staging_dir":       { "type": ["string", "null"] },
    "candidate_pid":     { "type": ["integer", "null"] },
    "error":             { "type": ["string", "null"] },
    "completed_at":      { "type": ["string", "null"] }
  }
}
```

**Example:**

```json
{
  "txn_id": "txn-2026-08-11-001",
  "started_at": "2026-08-11T10:00:00Z",
  "target_version": "1.0.0",
  "stage": "complete",
  "stages_completed": [
    "resolving",
    "downloaded",
    "checksum_verified",
    "compatibility_verified",
    "extracted",
    "deps_installed",
    "candidate_started",
    "readiness_passed",
    "health_passed",
    "candidate_stopped",
    "version_dir_renamed",
    "symlink_updated",
    "production_started",
    "production_health_passed",
    "known_good_promoted",
    "complete"
  ],
  "artifact_path": "/var/lib/multimedica-scanner/state/releases/staging/multimedica-scanner-1.0.0.tgz",
  "staging_dir": "/opt/multimedica-scanner/releases/staging/txn-2026-08-11-001",
  "candidate_pid": null,
  "error": null,
  "completed_at": "2026-08-11T10:05:00Z"
}
```

The `stage` field and `stages_completed` array are both written atomically (write-temp, fsync, rename) before each state transition. On recovery after power loss, the controller reads the last transaction record, identifies the current stage, and takes the appropriate recovery action from the table in section 6.5.

---

### 6.4 Installed-version record

**Path:** `/var/lib/multimedica-scanner/state/installed-version.json`

**JSON Schema:**

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["current_version","current_dir","current_symlink"],
  "properties": {
    "current_version":        { "type": ["string","null"] },
    "current_dir":            { "type": ["string","null"] },
    "current_symlink":        { "type": "string" },
    "previous_version":       { "type": ["string","null"] },
    "previous_dir":           { "type": ["string","null"] },
    "last_known_good_version":{ "type": ["string","null"] },
    "last_known_good_dir":    { "type": ["string","null"] },
    "last_activation_at":     { "type": ["string","null"] },
    "last_activation_txn":    { "type": ["string","null"] }
  }
}
```

**Example:**

```json
{
  "current_version": "1.0.0",
  "current_dir": "/opt/multimedica-scanner/releases/1.0.0",
  "current_symlink": "/opt/multimedica-scanner/current",
  "previous_version": null,
  "previous_dir": null,
  "last_known_good_version": "1.0.0",
  "last_known_good_dir": "/opt/multimedica-scanner/releases/1.0.0",
  "last_activation_at": "2026-08-11T10:05:00Z",
  "last_activation_txn": "txn-2026-08-11-001"
}
```

`last_known_good_version` is only updated after the production service passes its post-promotion health check. If promotion health fails and rollback is performed, `last_known_good_version` retains the previous value.

---

### 6.5 Release activation algorithm

#### Stage 1 — Resolve version

Write transaction record with `stage: "resolving"`.

- If `-ReleaseVersion` is provided, use that version directly.
- Otherwise fetch the stable-channel manifest from `https://raw.githubusercontent.com/paullmullen/multimedica-scanner/main/release/stable-channel.json` and use `approved_version`.
- Reading the manifest is informational only; it does not authorize installation. The explicit installation action (PowerShell `-Commission` or `-InstallRelease`) authorizes the install.

#### Stage 2 — Download

Download `artifact_url` to `/var/lib/multimedica-scanner/state/releases/staging/<version>.tgz.tmp` via HTTPS.

Update transaction: `stage: "downloaded"`.

Recovery: if power is lost mid-download, delete the `.tgz.tmp` file and restart from stage 2.

#### Stage 3 — SHA-256 verification

Compute SHA-256 of the `.tgz.tmp` file. Compare to `sha256` from the stable-channel manifest (or the value supplied with the explicit version override).

- Match: rename `.tgz.tmp` → `.tgz`; update transaction `stage: "checksum_verified"`
- Mismatch: delete `.tgz.tmp`; set `stage: "checksum_failed"`; abort; do not touch current release

Recovery: if power is lost after rename, the `.tgz` file is present and checksum can be re-verified before proceeding.

#### Stage 4 — Compatibility check

Extract `manifest.json` from the tarball root (without extracting the rest of the artifact). Verify:

- `pi_model == "rpi4"`
- `arch == "arm64"`
- `os_id` matches the qualified baseline recorded in `bootstrap/lib/platform-check.js`
- Node version satisfies `node_semver`
- Bootstrap version satisfies `min_bootstrap_version`
- `config_schema_version` and `qr_schema_version` are compatible

Failure: set `stage: "compatibility_failed"`; abort; do not touch current release.

Success: update transaction `stage: "compatibility_verified"`.

#### Stage 5 — Extraction

Extract the full artifact into a transaction-specific staging directory:

```
/opt/multimedica-scanner/releases/staging/<txn-id>/
```

This directory is the mutable working area. It is not the immutable version directory yet.

Update transaction: `stage: "extracted"`, `staging_dir: "/opt/multimedica-scanner/releases/staging/<txn-id>"`.

Recovery: delete incomplete staging directory and restart from stage 5.

#### Stage 6 — Dependency installation

```bash
cd /opt/multimedica-scanner/releases/staging/<txn-id>
npm ci --omit=dev
```

`package-lock.json` must be included in the release artifact. `npm ci` is used (not `npm install`) to guarantee a deterministic installation from the lockfile.

Update transaction: `stage: "deps_installed"`.

Recovery: delete staging directory; restart from stage 5.

#### Stage 7 — Candidate startup (isolated)

Start the candidate from the staging directory using a systemd transient unit:

```bash
systemd-run \
  --unit=multimedica-candidate \
  --uid=multimedica_edge \
  --gid=multimedica_edge \
  --working-directory=/opt/multimedica-scanner/releases/staging/<txn-id> \
  --collect \
  --property=Environment="SCANNER_STATUS_PORT=3003" \
  --property=Environment="MULTIMEDICA_CANDIDATE_MODE=1" \
  --property=Environment="MULTIMEDICA_STATE_DIR=/var/lib/multimedica-scanner/state" \
  /usr/bin/node scanner.js
```

**Candidate process supervision:**

| Property | Value |
|---|---|
| User | `multimedica_edge` |
| Group | `multimedica_edge` |
| Invocation | `systemd-run` transient unit `multimedica-candidate.service` |
| PID ownership | Managed by systemd; retrieved via `systemctl show multimedica-candidate.service --property=MainPID` |
| Candidate port | `3003` (`SCANNER_STATUS_PORT=3003`) |
| Config access | Reads `/var/lib/multimedica-scanner/state/config.json` (mode 0640, group multimedica_edge) |
| Secret access | Reads `/var/lib/multimedica-scanner/state/secrets.json` (mode 0600, root-owned); controller helper reads and passes required values as a temp file readable by the candidate |
| Shutdown | Controller sends `systemctl stop multimedica-candidate.service`; systemd sends SIGTERM; 15-second timeout; SIGKILL if needed |
| Validation mode | `MULTIMEDICA_CANDIDATE_MODE=1` suppresses the `syncDisplayFromCloud("boot", ...)` call in `main()`, preventing any real cloud HTTPS requests during isolated validation |
| Real side-effect prohibition | With `MULTIMEDICA_CANDIDATE_MODE=1`, the production service must skip the boot sync and must not post any scans to the cloud. No scan events are routed to the candidate (it is on port 3003; the controller does not forward to it). |

Record `candidate_pid` in transaction record.

Update transaction: `stage: "candidate_started"`.

Recovery: if power is lost, use `systemctl is-active multimedica-candidate` to determine if the candidate is still running; if so, treat as `candidate_started` and proceed to readiness check.

#### Stage 8 — Readiness and health check

Poll `http://127.0.0.1:3003/api/status` with:
- Overall timeout: 30 seconds
- Retry interval: 2 seconds
- Success condition: HTTP 200 response

Failure: stop the candidate; delete staging directory; set `stage: "readiness_failed"`; rollback (section 6.6).

Success: update transaction `stage: "readiness_passed"` then `stage: "health_passed"`.

#### Stage 9 — Stop candidate

```bash
systemctl stop multimedica-candidate.service
```

Wait up to 15 seconds. Update transaction: `stage: "candidate_stopped"`, `candidate_pid: null`.

#### Stage 10 — Rename staging to immutable version directory

```bash
mv /opt/multimedica-scanner/releases/staging/<txn-id> \
   /opt/multimedica-scanner/releases/1.0.0
```

This is an atomic rename within the same filesystem. The staging directory becomes the immutable, final version directory. No mutations to this directory are permitted after this point.

Update transaction: `stage: "version_dir_renamed"`.

Recovery: if the rename was interrupted (power loss during `mv`), the directory may exist at either path. Check both; if the version directory exists, treat the rename as complete.

#### Stage 11 — Atomic symlink update

```bash
ln -sfn /opt/multimedica-scanner/releases/1.0.0 /opt/multimedica-scanner/current.new
mv /opt/multimedica-scanner/current.new /opt/multimedica-scanner/current
```

The `mv` of a symlink is atomic on Linux (single filesystem). Update transaction: `stage: "symlink_updated"`.

Record the previous version directory in `installed-version.json` (temp-write, fsync, rename) before changing the symlink.

Recovery: if `current.new` exists, the rename did not complete; retry it.

#### Stage 12 — Production start

Stop the currently running `multimedica-production.service` (if running from the previous release), then start it from the new `current` symlink:

```bash
systemctl restart multimedica-production.service
```

`multimedica-production.service` uses `WorkingDirectory=/opt/multimedica-scanner/current` and `ExecStart=/usr/bin/node /opt/multimedica-scanner/current/scanner.js`. It binds to `SCANNER_STATUS_PORT=3002`.

Update transaction: `stage: "production_started"`.

#### Stage 13 — Post-promotion health check

Poll `http://127.0.0.1:3002/api/status` with:
- Overall timeout: 30 seconds
- Retry interval: 2 seconds

Failure: rollback (section 6.6).

Success: update transaction `stage: "production_health_passed"`.

#### Stage 14 — Known-good promotion

Update `installed-version.json`:
- `current_version`: new version
- `last_known_good_version`: new version
- `last_known_good_dir`: new version directory
- `previous_version`: old version (retained for rollback)
- `previous_dir`: old version directory (retained for rollback)

Update transaction: `stage: "known_good_promoted"` then `stage: "complete"`, `completed_at: now`.

#### Stage 15 — Cleanup

Remove the artifact `.tgz` file from staging if fully activated. Retain previous version directory for rollback. When a third release is fully promoted, remove the oldest retained release directory.

---

### 6.6 Rollback algorithm

Rollback is triggered by: readiness failure (stage 8), post-promotion health failure (stage 13), or explicit `-RollbackRelease`.

1. Stop `multimedica-production.service` if running
2. If the symlink was already updated: restore it to `previous_dir` using `ln -sfn <previous_dir> /opt/multimedica-scanner/current.new && mv current.new current`
3. Stop and remove `multimedica-candidate.service` if still present
4. Start `multimedica-production.service` from the restored symlink
5. Poll `/api/status` to confirm the previous release is healthy
6. Update `installed-version.json`: restore `current_version` to the previous known-good value; do not update `last_known_good_version`
7. Update transaction: `stage: "rolled_back"`
8. Retain the failed staging directory or version directory for diagnostic inspection; remove it only on the next successful install

---

### 6.7 Interruption recovery table

| Stage at power-on | Transaction stage | Recovery action |
|---|---|---|
| During download | `resolving` or partial `.tgz.tmp` | Delete `.tgz.tmp`; restart download |
| After download, before checksum | `downloaded` | Re-verify checksum; re-download if mismatch |
| During extraction | `checksum_verified` | Delete staging dir; restart from extraction |
| During `npm ci` | `extracted` | Delete staging dir; restart from extraction |
| During candidate start | `deps_installed` | Stop any orphan systemd unit; delete staging dir; restart |
| During readiness wait | `candidate_started` | Check if unit still running; if yes, re-poll; if no, rollback |
| During stop-candidate | `health_passed` | Re-issue `systemctl stop`; proceed to rename |
| During `mv` staging → version | `candidate_stopped` | Check both paths; if version dir exists, treat as complete |
| During symlink `mv` | `version_dir_renamed` | Check for `current.new`; retry `mv` if present |
| During production restart | `symlink_updated` | Re-issue `systemctl restart`; proceed to health check |
| During post-promotion health | `production_started` | Re-poll health; if still failing after timeout, rollback |
| During known-good promotion | `production_health_passed` | Re-write `installed-version.json`; re-mark complete |
| During cleanup | `complete` | Finish cleanup; no version change |

---

## 7. Persistent Filesystem and Configuration

### 7.1 Directory layout

```
/var/lib/multimedica-scanner/
  state/
    config.json                  multimedica_edge:multimedica_edge  0640
    secrets.json                 root:root                          0600
    runtime.json                 multimedica_edge:multimedica_edge  0640
    installed-version.json       multimedica_edge:multimedica_edge  0640
    stable-channel.json          multimedica_edge:multimedica_edge  0644
    releases/
      staging/                   multimedica_edge:multimedica_edge  0750
      transactions/              multimedica_edge:multimedica_edge  0750
    backups/                     multimedica_edge:multimedica_edge  0750

/opt/multimedica-scanner/
  current -> releases/1.0.0      (symlink)
  releases/
    staging/                     multimedica_edge:multimedica_edge  0750
      <txn-id>/                  (mutable during activation)
    1.0.0/                       multimedica_edge:multimedica_edge  0755
      scanner.js
      manifest.json
      package.json
      package-lock.json
      node_modules/
      ...
```

### 7.2 `config.json` schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schema_version", "bootstrap_version", "commissioning_state"],
  "properties": {
    "schema_version":        { "type": "integer", "const": 1 },
    "bootstrap_version":     { "type": "string" },
    "commissioning_state":   {
      "type": "string",
      "enum": [
        "bootstrap_installed",
        "network_configured",
        "identity_configured",
        "cloud_configured",
        "ready_to_download",
        "release_installed",
        "operational"
      ]
    },
    "location_id":           { "type": ["string","null"] },
    "room_id":               { "type": ["string","null"] },
    "station_id":            { "type": ["string","null"] },
    "device_id":             { "type": ["string","null"] },
    "endpoint_url":          { "type": ["string","null"] },
    "wifi_ssid":             { "type": ["string","null"] },
    "wifi_security":         { "type": ["string","null"] },
    "qr_schema_version":     { "type": "integer" },
    "config_schema_version": { "type": "integer" },
    "updated_at":            { "type": "string", "format": "date-time" }
  }
}
```

**Example:**

```json
{
  "schema_version": 1,
  "bootstrap_version": "1.0.0",
  "commissioning_state": "operational",
  "location_id": "loc1",
  "room_id": "loc1_nursing_room_1",
  "station_id": "nursing",
  "device_id": "scanner_loc1_nursing_01",
  "endpoint_url": "https://us-central1-alfarero-478ad.cloudfunctions.net/receiveRoomScanEvent",
  "wifi_ssid": "ClinicWifi",
  "wifi_security": "wpa-psk",
  "qr_schema_version": 1,
  "config_schema_version": 1,
  "updated_at": "2026-08-11T10:00:00Z"
}
```

### 7.3 `secrets.json` schema

`secrets.json` is owned by `root:root`, mode `0600`. The controller reads it via a controlled helper that holds no reference to the raw values beyond what is needed at startup. Values are never written to stdout or journald.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schema_version", "qr_admin_token"],
  "properties": {
    "schema_version":  { "type": "integer", "const": 1 },
    "qr_admin_token":  { "type": "string", "minLength": 1 },
    "shared_secret":   { "type": ["string","null"] },
    "wifi_password":   { "type": ["string","null"] },
    "updated_at":      { "type": "string", "format": "date-time" }
  }
}
```

**Example (credentials redacted):**

```json
{
  "schema_version": 1,
  "qr_admin_token": "<redacted>",
  "shared_secret": "<shared-secret>",
  "wifi_password": "<wifi-password>",
  "updated_at": "2026-08-11T10:00:00Z"
}
```

### 7.4 Atomic write method

Applied to `config.json`, `secrets.json`, `installed-version.json`, and all transaction records:

1. Write new content to `<file>.tmp` in the same directory
2. `fsync` the file descriptor
3. `rename("<file>.tmp", "<file>")` — atomic within the same filesystem on Linux
4. Before step 1, copy the current file to `backups/<filename>-<ISO-timestamp>`
5. Retain the five most recent backups per file; delete older ones

### 7.5 Migration from existing `.env`

On first controller startup after bootstrap installation:

1. Check for legacy `/home/multimedica_edge/scanner/.env`
2. If present: parse known keys (`ENDPOINT_URL`, `SHARED_SECRET`, `SCANNER_QR_ADMIN_TOKEN`, `LOCATION_ID`, `ROOM_ID`, `STATION_ID`, `DEVICE_ID`)
3. Write non-secret keys into `config.json` (if those fields are not already populated)
4. Write secret keys into `secrets.json` (if those fields are not already populated)
5. Rename legacy file to `/home/multimedica_edge/scanner/.env.migrated-<timestamp>`
6. Do not treat the legacy file as authoritative after migration

---

### 7.6 Commissioning-result schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["timestamp", "overall", "checks"],
  "properties": {
    "timestamp": { "type": "string", "format": "date-time" },
    "overall":   { "type": "string", "enum": ["PASS","FAIL","WARNING"] },
    "checks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "result"],
        "properties": {
          "name":        { "type": "string" },
          "result":      { "type": "string", "enum": ["PASS","FAIL","WARNING","NOT_APPLICABLE"] },
          "detail":      { "type": ["string","null"] },
          "remediation": { "type": ["string","null"] }
        }
      }
    }
  }
}
```

---

## 8. File Inventory

### 8.1 Existing files — disposition

| File | Disposition | Notes |
|---|---|---|
| `configQr.js` | Replaced (moved) | Replaced by `bootstrap/lib/qr-contract.js`; `.env` writes removed; `security` field pass-through added |
| `scanner.js` | Refactored | Split: scanner input and QR handling move to controller; `POST /api/scan` added to production side; hard `SHARED_SECRET` throw removed; `MULTIMEDICA_CANDIDATE_MODE` check added to skip boot sync |
| `kiosk-display/server.js` | Refactored | Bootstrap-mode status routes added; commissioning state surfaced; reads from `config.json` |
| `kiosk-display/public/index.html` | Refactored | Bootstrap, config-required, and degraded screen states added |
| `kiosk-display/public/app.js` | Refactored | Bootstrap mode, config-required mode, operational mode handled |
| `kiosk-display/public/styles.css` | Refactored | Styles for bootstrap and degraded screens added |
| `kiosk-display/package.json` | Unchanged | |
| `kiosk/start-kiosk.sh` | Refactored | Hard-coded `/usr/lib/chromium/chromium` replaced with `command -v chromium \|\| command -v chromium-browser` |
| `kiosk/openbox-autostart` | Unchanged | |
| `provision-scanner.ps1` | Replaced | Replaced by parameter-set installer with all six modes; Git-based flow removed; default hardcoded hostname removed |
| `provision/install-scanner.sh` | Retired | Replaced by `bootstrap/install-bootstrap.sh` |
| `provision/install-kiosk.sh` | Retired | Absorbed into `bootstrap/install-bootstrap.sh` |
| `provision/systemd/multimedica-scanner.service` | Retired | Replaced by new service units |
| `provision/systemd/kiosk-display.service` | Retired | Replaced by new service units |
| `install-device.sh` | Retired | Duplicate of `install-scanner.sh` |
| `package.json` | Refactored | Updated when `scanner.js` is split |
| `package-lock.json` | Refactored | Updated when dependencies change |
| `README.md` | Refactored | Updated to reflect new workflow |
| `docs/installation.md` | Replaced | Rewritten for new workflow |
| `docs/quickstart.md` | Replaced | Rewritten |
| `docs/deployment.md` | Replaced | Describes release artifact model |
| `docs/troubleshooting.md` | Refactored | Updated |
| `docs/qr-configuration.md` | Refactored | Full contract with literal examples |
| `docs/architecture.md` | Refactored | Updated for two-layer model |
| `docs/configuration.md` | Refactored | Updated for config/secrets store |
| `docs/observability.md` | Refactored | Updated for journald-only model |
| `docs/kiosk-api.md` | Unchanged | |
| `enclosure_design/` | Unchanged | |

### 8.2 New files — exact proposed repository paths

**Bootstrap shared library**

```
bootstrap/lib/qr-contract.js
bootstrap/lib/state-store.js
bootstrap/lib/config-store.js
bootstrap/lib/secrets-store.js
bootstrap/lib/wifi-manager.js
bootstrap/lib/platform-check.js
```

**Controller entry point and modules**

```
bootstrap/controller.js
bootstrap/lib/scanner-reader.js
bootstrap/lib/commissioning.js
bootstrap/lib/release-manager.js
bootstrap/lib/display-client.js
bootstrap/lib/health.js
bootstrap/lib/support-bundle.js
```

**Production scan-routing module**

```
production/scan-server.js
```

**Bootstrap installer script**

```
bootstrap/install-bootstrap.sh
```

**systemd service units**

```
bootstrap/systemd/multimedica-controller.service
bootstrap/systemd/multimedica-display.service
bootstrap/systemd/multimedica-production.service
```

**PowerShell entry point and helpers**

```
provision-scanner.ps1
provision/powershell/Invoke-BootstrapInstall.ps1
provision/powershell/Invoke-Commissioning.ps1
provision/powershell/Invoke-ReleaseActivation.ps1
provision/powershell/Get-DeviceState.ps1
provision/powershell/New-InstallerConfig.ps1
```

**Schemas (JSON Schema draft-07)**

```
schemas/config.schema.json
schemas/secrets.schema.json
schemas/qr-envelope.schema.json
schemas/qr-wifi-payload.schema.json
schemas/qr-station-payload.schema.json
schemas/qr-cloud-payload.schema.json
schemas/stable-channel-manifest.schema.json
schemas/release-manifest.schema.json
schemas/release-transaction.schema.json
schemas/installed-version.schema.json
schemas/commissioning-result.schema.json
schemas/scan-request.schema.json
schemas/scan-response.schema.json
schemas/installer-config.schema.json
schemas/provisioning-result.schema.json
```

**Contract test fixtures**

```
tests/fixtures/qr_wifi_config.json
tests/fixtures/qr_station_config.json
tests/fixtures/qr_cloud_config.json
tests/fixtures/qr_show_identity.json
tests/fixtures/qr_invalid_version.json
tests/fixtures/qr_invalid_token.json
tests/fixtures/qr_missing_kind.json
tests/fixtures/qr_unknown_kind.json
tests/fixtures/qr_malformed_json.json
```

**Tests**

```
tests/qr-contract.test.js
tests/state-store.test.js
tests/release-manager.test.js
tests/commissioning.test.js
tests/scan-routing.test.js
```

**Release channel**

```
release/stable-channel.json
```

**Documentation**

```
docs/implementation-spec.md
docs/bootstrap-architecture.md
docs/commissioning.md
docs/release-policy.md
docs/installer-config.md
```

---

## 9. Milestone Plan

### Milestone 1 — Shared QR/config/state modules and CI tests

**Code scope:**
- `bootstrap/lib/qr-contract.js` — refactored from `configQr.js`; `security` field pass-through added; `.env` writes removed; persistence delegated to config/secrets stores
- `bootstrap/lib/config-store.js` — atomic read/write/backup for `config.json`
- `bootstrap/lib/secrets-store.js` — atomic read/write/backup for `secrets.json`; root-permission helper
- `bootstrap/lib/state-store.js` — atomic read/write for `runtime.json` and `installed-version.json`
- `bootstrap/lib/platform-check.js` — platform constants (Pi model, OS ID, arch, Node semver); filled with placeholder values until Milestone 3 hardware qualification
- All `schemas/*.schema.json` files
- All `tests/fixtures/qr_*.json` files
- `tests/qr-contract.test.js`
- `tests/state-store.test.js`

**Automated tests:**
- All nine QR fixtures parsed and validated against expected results
- Valid fixtures accepted; invalid fixtures rejected with correct error messages
- `config-store.js` atomic write verified (temp-write, rename, backup)
- `secrets-store.js` atomic write verified
- Migration from legacy `.env` file produces correct `config.json` and `secrets.json`
- Schema validation rejects known-bad inputs using `ajv` or equivalent

**Physical hardware tests:** None in this milestone.

**Acceptance criteria:**
- All QR contract tests pass in CI on every push
- `configQr.js` root file is removed; `bootstrap/lib/qr-contract.js` is the only QR parser
- Migration from a real legacy `.env` file (created manually for testing) produces correct output
- `SCANNER_QR_ADMIN_TOKEN` is never read from a process environment variable in any test; it comes from `secrets-store.js`

**Documentation updated:**
- `docs/qr-configuration.md` — full contract with literal JSON examples (this specification section 2)

**Deferred:** Controller, services, PowerShell, release activation

---

### Milestone 2 — Minimal controller, display, services, and PowerShell bootstrap installer

**Code scope:**
- `bootstrap/controller.js` — scanner ownership, QR routing, display coordination; starts without `SHARED_SECRET`
- `bootstrap/lib/scanner-reader.js` — `evtest` wrapper, key-to-character map (from `scanner.js`)
- `bootstrap/lib/display-client.js` — HTTP client to kiosk display API
- `bootstrap/lib/health.js` — health state model
- `bootstrap/lib/wifi-manager.js` — `applyWifiConfig` (from `scanner.js`); reads `security` field
- `bootstrap/lib/commissioning.js` — bootstrap-phase checks only (platform, services, scanner detection)
- `bootstrap/systemd/multimedica-controller.service`
- `bootstrap/systemd/multimedica-display.service`
- `bootstrap/systemd/multimedica-production.service` (stub; not yet started by controller)
- `bootstrap/install-bootstrap.sh` — installs packages, users, services; replaces `provision/install-scanner.sh`
- `provision-scanner.ps1` — `-Install`, `-Verify`, `-Repair` modes only; `-Commission`, `-InstallRelease`, `-RollbackRelease` deferred
- `provision/powershell/Invoke-BootstrapInstall.ps1`
- `provision/powershell/Get-DeviceState.ps1`
- `provision/powershell/New-InstallerConfig.ps1`
- `kiosk/start-kiosk.sh` — Chromium path fix
- `kiosk-display/server.js` — bootstrap mode routes
- `kiosk-display/public/` — bootstrap and config-required screens

**Automated tests:**
- `tests/scan-routing.test.js` — controller routes config QRs correctly; ordinary scans return `unavailable` when production is stopped
- PowerShell `-Verify` against mocked SSH responses (unit test for result schema)

**Physical hardware tests:**
- Fresh Pi 4 bootstrap install via PowerShell `-Install` over Ethernet
- All four QR kinds scanned and applied in arbitrary order
- Reboot recovery to bootstrap mode
- Scanner device detection and provisioning QR parsing both reported separately in result

**Acceptance criteria:**
- Bootstrap installation complete (acceptance point A) is reached and reported
- PowerShell exits `0` with correct `provisioning-result.json` including distinct `scanner_device_detected` and `provisioning_qr_parsed` fields
- Controller starts without `SHARED_SECRET` or cloud config
- QR token validation uses `secrets.json`, not any `.env` file
- Local display shows configuration-required state

**Documentation updated:**
- `docs/bootstrap-architecture.md`
- `docs/installer-config.md`
- `README.md` (installer section)

**Deferred:** Release activation, production scan routing, commissioning report

---

### Milestone 3 — Clean-Pi bootstrap qualification and OS-image selection

**Code scope:**
- `bootstrap/lib/platform-check.js` — update with verified constants from qualification (exact `os_id`, `node_version`, Chromium package name, confirmed package list)
- `bootstrap/install-bootstrap.sh` — update package list and version pins from qualification results
- `provision-scanner.ps1` preflight checks — update OS/arch/model validation against qualified baseline
- `schemas/stable-channel-manifest.schema.json` — update `os_id` enum to qualified value

**Physical hardware tests:**
- Full bootstrap install on two factory-fresh Pi 4 units (different memory sizes if available)
- Record exact Raspberry Pi OS Lite 64-bit image: version string, build date, and SHA-256
- Record the Node.js version installed by the qualified package set
- Record exact Chromium executable path on the qualified image
- Record the full `apt-get install` package list and verify no package is absent
- Run complete Milestone 2 hardware test on the freshly qualified image

**Acceptance criteria:**
- A single exact OS image is chosen and all details are committed to `docs/bootstrap-architecture.md` and `bootstrap/lib/platform-check.js`
- Bootstrap install passes on that exact image without manual intervention
- All Milestone 2 acceptance criteria still pass on the qualified image

**Documentation updated:**
- `docs/bootstrap-architecture.md` — platform contract section completed with exact values (image version, date, SHA-256, Node version, Chromium path, package list)

**Deferred:** Nothing; this milestone is a qualification gate for Milestones 4 and 5

---

### Milestone 4 — Production scan routing

**Code scope:**
- `production/scan-server.js` — adds `POST /api/scan` alongside existing `GET /api/status`; forwards to cloud; returns `accepted`, `rejected`, `duplicate`, or `unavailable`
- `scanner.js` — refactored: hard `SHARED_SECRET` throw removed; `MULTIMEDICA_CANDIDATE_MODE=1` check added to skip `syncDisplayFromCloud("boot", ...)` call; controller scan loop removed (it lives in `bootstrap/lib/scanner-reader.js`); reads config from `config-store.js` and `secrets-store.js`
- `tests/scan-routing.test.js` — extended: all four response dispositions, timeout behavior, controller behavior during all production states

**Automated tests:**
- `accepted`, `rejected`, `duplicate`, `unavailable` dispositions
- Controller 10-second timeout
- Controller behavior when production is stopped, starting, healthy

**Physical hardware tests:**
- Normal patient scan round-trip to Firebase Cloud Function
- Scanner disconnect and reconnect handled by controller without losing ownership

**Acceptance criteria:**
- Controller never posts directly to cloud; all ordinary scans go via `POST /api/scan`
- `unavailable` shown correctly on display with rescan instruction
- `scanner.js` starts successfully with empty `SHARED_SECRET` (bootstrap mode)

**Documentation updated:**
- `docs/architecture.md` — scan routing section

**Deferred:** Release activation, commissioning report

---

### Milestone 5 — Release activation and rollback

**Code scope:**
- `bootstrap/lib/release-manager.js` — full activation algorithm (stages 1–15), rollback, interruption recovery
- `release/stable-channel.json` — initial content for v1.0.0
- `provision-scanner.ps1` — `-Commission`, `-InstallRelease`, `-RollbackRelease` modes added
- `provision/powershell/Invoke-ReleaseActivation.ps1`
- `provision/powershell/Invoke-Commissioning.ps1`
- `tests/release-manager.test.js`

**Automated tests:**
- Good release downloaded, verified, extracted, candidate validated, renamed, promoted, known-good recorded
- SHA-256 mismatch → artifact discarded, current release unchanged
- Candidate startup failure → rollback, previous release active
- Post-promotion health failure → rollback
- Interrupted activation at each transaction stage → correct recovery per table in section 6.7
- Explicit version override used instead of stable-channel
- `-RollbackRelease` to an existing version directory

**Physical hardware tests:**
- Release download from public GitHub Release artifact over real HTTPS
- Candidate started on port 3003; production started on port 3002
- Reboot recovery after promotion
- Rollback to previous known-good release
- Power-cut simulation at candidate startup stage; verify recovery

**Acceptance criteria:**
- Commissioning complete (acceptance point B) is reached and reported
- PowerShell `-Commission` exits `0` with correct `provisioning-result.json`
- No release is activated without passing post-promotion health checks
- Known-good version is only recorded after post-promotion health passes
- Rollback restores previous release and does not destroy config

**Documentation updated:**
- `docs/release-policy.md`
- `docs/deployment.md`

**Deferred:** Full commissioning report, support bundle

---

### Milestone 6 — Commissioning, verification, and support bundle

**Code scope:**
- `bootstrap/lib/commissioning.js` — full check suite (platform, services, scanner, network, cloud, release, kiosk)
- `bootstrap/lib/support-bundle.js` — collects `journalctl` output, `config.json`, `installed-version.json`; redacts all keys present in `secrets.json` from all bundle contents
- `tests/commissioning.test.js`
- `provision-scanner.ps1` — commissioning summary output

**Automated tests:**
- Machine-readable commissioning result validates against `schemas/commissioning-result.schema.json`
- Support bundle verified to contain no raw value of `qr_admin_token`, `shared_secret`, or `wifi_password`
- Each commissioning check produces correct `PASS`, `FAIL`, `WARNING`, or `NOT_APPLICABLE` output

**Physical hardware tests:**
- Full commissioning run on a commissioned device
- Support bundle collection and manual inspection for secret leakage

**Acceptance criteria:**
- All commissioning checks emit correct semantics
- Support bundle contains no secret values
- PowerShell commissioning summary matches Pi-side result

**Documentation updated:**
- `docs/commissioning.md`
- `docs/troubleshooting.md`

**Deferred:** Field-trial feedback

---

### Milestone 7 — Independent installer trial and final documentation

**Code scope:**
- Minor fixes only, based on field-trial findings
- No new features

**Physical hardware tests:**
- Complete end-to-end install by a person who was not involved in development, following only the written documentation
- All seven milestone acceptance criteria verified as a continuous sequence on a factory-fresh Pi 4

**Acceptance criteria:**
- Installer trial passes without developer intervention
- No step in the written instructions refers to a file, command, or behavior that does not exist in the repository

**Documentation updated:**
- `docs/installation.md` — final rewrite based on tested workflow
- `docs/quickstart.md` — final rewrite
- `README.md` — complete update

**Deferred:** Per-device enrollment/signing (post-v1 hardening milestone)

---

## 10. Remaining Product-Owner Decisions

The following cannot be resolved from repository evidence alone and require explicit product-owner input before the relevant milestone begins.

1. **QR administrator token authority (must resolve before Milestone 2 hardware acceptance).**
  `SCANNER_QR_ADMIN_TOKEN` is backend-owned and must be supplied to the Cloud Function through its Secret Manager binding. The exact same value must be installed as `qr_admin_token` in the Pi secrets store. The React application is not an authority for this value and must not contain it.

2. **Exact OS image (must resolve before Milestone 3 closes).**  
   The exact Raspberry Pi OS Lite 64-bit image version, release date, download URL, and SHA-256 are hardware-qualification outputs. The implementation must not proceed to Milestone 5 until these values are committed to `docs/bootstrap-architecture.md` and `bootstrap/lib/platform-check.js`.

3. **`stable-channel.json` update authorization (must resolve before Milestone 5).**  
   Confirm that committing a new `release/stable-channel.json` to the `main` branch is the approved method for publishing a new stable release. If a separate protected branch or tag is preferred, `bootstrap/lib/release-manager.js` must use the corresponding raw URL.

4. **`multimedica-installer.json` delivery to field installers (must resolve before Milestone 7).**  
   Define how the installer configuration file (containing `qr_admin_token`, `shared_secret`, and `endpoint_url`) is securely delivered to Windows workstations used by clinic field installers, and what the rotation procedure is if the fleet token is ever changed.
