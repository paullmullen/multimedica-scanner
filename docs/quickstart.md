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
- Use password authentication
- No Raspberry Pi Connect
- Set hostname
- Create user

---

# 2. Boot the Pi

Verify:

```bash
ping multimedicascanner1.local
```

SSH into the Pi:

```bash
ssh multimedica_edge@multimedicascanner1.local
```

---

# 3. Clone Repository

```bash
cd /opt
sudo git clone <repo-url> multimedica-scanner
```

---

# 4. Run Provisioning Script

You may need to create an SSH key to avoid typing the password over and over in the script below.  To do this run these two commands in the windows powershell.
```powershell
ssh-keygen -t ed25519
type $HOME\.ssh\id_ed25519.pub | ssh multimedica_edge@multimedicascanner1.local "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

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

# 7. [Configure Scanner via QR](qr-configuration.md)

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
