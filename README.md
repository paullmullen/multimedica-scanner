# Multimedica Scanner

Raspberry Pi-based barcode scanner and kiosk display appliance for the Multimedica clinic workflow system.

This project provides:

- Barcode scan ingestion
- Patient/station workflow transitions
- Local kiosk status display
- Configuration QR workflows
- Cloud synchronization
- Adaptive polling
- Local observability and diagnostics

---

# System Overview

Each scanner appliance consists of:

- Raspberry Pi
- USB barcode scanner
- HDMI-attached kiosk display
- Local Node.js scanner service
- Local kiosk display service

The scanner communicates with cloud functions hosted in Firebase and maintains a synchronized local room/station display.

The architecture is intentionally cloud-light:
- the Pi is mostly self-contained
- the cloud responds to requests
- the Pi maintains local operational state and diagnostics

---

# Local Observability API

The scanner exposes a local diagnostic API.

Default port:

```txt
3002
```

## Full Status Endpoint

```bash
curl http://127.0.0.1:3002/api/status | jq
```

## Summary Status Endpoint

```bash
curl http://127.0.0.1:3002/api/status/summary | jq
```

---

# Deployment

## Install Dependencies

```bash
npm install
```

## Deploy to Pi

```powershell
.\provision-scanner.ps1
```

---

# systemd Services

## Scanner Service

```bash
sudo systemctl status multimedica-scanner.service
```

Logs:

```bash
journalctl -u multimedica-scanner.service -f
```



# Kiosk Display Debug / Testing API

The kiosk display service exposes a local HTTP API that can be used to manually change the display state for testing, debugging, and UI development.

Default endpoint:

```bash
http://127.0.0.1:3001/api/display
```

You can POST JSON payloads to this endpoint using `curl`.

---

# Basic Status Display

## Vacant / Available

```bash
curl -X POST http://127.0.0.1:3001/api/display \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "vacant",
    "room": {
      "label": "ROOM 1"
    },
    "station": {
      "label": "NUR"
    },
    "status": {
      "code": "available",
      "label": "Available"
    }
  }'
```

---

## Patient In Process

```bash
curl -X POST http://127.0.0.1:3001/api/display \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "occupied",
    "room": {
      "label": "ROOM 1"
    },
    "station": {
      "label": "DOC"
    },
    "patient": {
      "name": "Maria Lopez"
    },
    "status": {
      "code": "in_process",
      "label": "In Process"
    },
    "timing": {
      "started_at": "2026-05-11T10:30:00Z"
    }
  }'
```

---

## Patient Waiting

```bash
curl -X POST http://127.0.0.1:3001/api/display \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "waiting",
    "room": {
      "label": "ROOM 2"
    },
    "station": {
      "label": "LAB"
    },
    "status": {
      "code": "patient_waiting",
      "label": "Patient Waiting"
    }
  }'
```

---

## Clinic Closed

```bash
curl -X POST http://127.0.0.1:3001/api/display \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "closed",
    "room": {
      "label": "ROOM 1"
    },
    "station": {
      "label": "PHA"
    },
    "status": {
      "code": "closed",
      "label": "Clinic Closed"
    }
  }'
```

---

# Overlay Testing

Overlays temporarily appear on top of the current display state.

---

## Success Overlay

```bash
curl -X POST http://127.0.0.1:3001/api/display \
  -H "Content-Type: application/json" \
  -d '{
    "overlay": {
      "type": "success",
      "title": "Configuration Updated",
      "message": "Station assigned successfully"
    }
  }'
```

---

## Warning Overlay

```bash
curl -X POST http://127.0.0.1:3001/api/display \
  -H "Content-Type: application/json" \
  -d '{
    "overlay": {
      "type": "warning",
      "title": "WiFi Weak",
      "message": "Signal strength is low"
    }
  }'
```

---

## Error Overlay

```bash
curl -X POST http://127.0.0.1:3001/api/display \
  -H "Content-Type: application/json" \
  -d '{
    "overlay": {
      "type": "error",
      "title": "Cloud Offline",
      "message": "Unable to contact server"
    }
  }'
```

---

# Station Configuration Testing

This is useful for verifying station badge updates and persistence behavior.

```bash
curl -X POST http://127.0.0.1:3001/api/display \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "vacant",
    "room": {
      "label": "ROOM 3"
    },
    "station": {
      "label": "REG"
    },
    "status": {
      "code": "available",
      "label": "Ready"
    }
  }'
```

---

# Read Current Display State

You can inspect the currently active display payload with:

```bash
curl http://127.0.0.1:3001/api/display | jq
```

Without `jq`:

```bash
curl http://127.0.0.1:3001/api/display
```

---

# Common Status Codes

| Status Code       | Meaning                      |
| ----------------- | ---------------------------- |
| `available`       | Station available            |
| `in_process`      | Patient currently being seen |
| `patient_waiting` | Another patient waiting      |
| `closed`          | Clinic closed                |
| `offline`         | Cloud or device offline      |
| `error`           | Error state                  |

---

# Common Overlay Types

| Overlay Type | Meaning                       |
| ------------ | ----------------------------- |
| `success`    | Positive confirmation         |
| `warning`    | Non-critical issue            |
| `error`      | Failure or disconnected state |
| `info`       | Informational message         |

---

# Notes

- These APIs are intended primarily for local debugging and kiosk development.
- Production state updates normally come from:
  - scanner events
  - cloud synchronization
  - adaptive polling
- Manual POSTs are useful for:
  - UI testing
  - provisioning validation
  - troubleshooting kiosk behavior
  - validating overlays/colors/layouts
