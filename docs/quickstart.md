# Quick Start

Purpose:

Get a new Multimedica scanner appliance operational as quickly as possible.

Target audience:

- installer
- developer
- technical operator

Estimated deployment time:

30–45 minutes.

---

# Hardware Checklist

Required:

- Raspberry Pi 3B+ or Pi 4
- 16GB+ microSD card
- USB barcode scanner
- HDMI display
- WiFi or Ethernet access
- Power supply

Recommended:

- Waveshare 4.3 HDMI LCD
- BF SCAN USB barcode scanner

---

# 1. Flash Raspberry Pi OS

Use Raspberry Pi Imager.

Recommended settings:

- Raspberry Pi OS Lite
- Enable SSH
- Configure WiFi
- Set hostname
- Create user

---

# 2. Boot the Pi

Verify:

```bash
ping raspberrypi.local
```

SSH into the Pi:

```bash
ssh multimedica_edge@raspberrypi.local
```

---

# 3. Clone Repository

```bash
cd /opt
sudo git clone <repo-url> multimedica-scanner
```

---

# 4. Run Provisioning Script

From Windows:

```powershell
.\provision-scanner.ps1
```

---

# 5. Validate Services

```bash
sudo systemctl status multimedica-scanner.service
sudo systemctl status kiosk-display.service
```

---

# 6. Validate Kiosk Display

```bash
curl http://127.0.0.1:3001/api/display | jq
```

---

# 7. Configure Scanner via QR

Scan:

- WiFi QR
- cloud_config QR
- station_config QR

---

# 8. Test Patient Workflow

Scan a patient barcode.

Verify:

- display updates
- cloud response succeeds
- logs show successful transition

---

# Troubleshooting

See:

- troubleshooting.md
- observability.md
