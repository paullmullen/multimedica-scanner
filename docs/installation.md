# Installation Guide

Purpose:

Complete installer/operator manual for deploying a scanner appliance.

---

# System Overview

The scanner appliance consists of:

- Raspberry Pi
- barcode scanner
- kiosk display
- local Node.js services
- Firebase Cloud Functions integration

---

# Hardware Requirements

## Minimum

| Component | Requirement |
|---|---|
| Pi | Pi 3B+ or Pi 4 |
| SD card | 16GB+ |
| Scanner | USB keyboard-wedge |
| Display | HDMI |

---

# SD Card Imaging

Use Raspberry Pi Imager.

Recommended:

- Raspberry Pi OS Lite
- SSH enabled
- WiFi preconfigured
- hostname assigned

---

# OS Preparation

Install required packages:

```bash
sudo apt update
sudo apt upgrade -y
```

Install:

- git
- nodejs
- npm
- chromium
- openbox
- xserver
- network-manager

---

# Repository Setup

Canonical location:

```text
/opt/multimedica-scanner
```

Clone:

```bash
git clone <repo>
```

---

# Environment Variables

Document:

- ROOM_ID
- STATION_ID
- DEVICE_ID
- SHARED_SECRET
- ENDPOINT_URL
- SCANNER_QR_ADMIN_TOKEN

---

# Provisioning Workflow

Document:

- provision-scanner.ps1
- file deployment
- service installation
- kiosk setup
- reboot behavior

---

# systemd Services

Document:

- multimedica-scanner.service
- kiosk-display.service
- kiosk-browser.service

Include:

```bash
systemctl status
journalctl
```

---

# Scanner Validation

Use:

```bash
evtest
```

Verify scanner events.

---

# Kiosk Validation

Validate:

```bash
curl http://127.0.0.1:3001/api/display
```

---

# Recovery Procedures

## Soft Recovery

- restart services
- rescan configuration QR

## Hard Recovery

- reimage SD card
- redeploy repository
- restore configuration

---

# Related Documentation

- architecture.md
- deployment.md
- troubleshooting.md
