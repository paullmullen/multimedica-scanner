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
.\deploy-to-pi.ps1
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
