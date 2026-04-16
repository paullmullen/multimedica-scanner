# Scanner Deployment SOP

## Purpose

Provision a Raspberry Pi barcode scanner so that it:

- boots without human interaction
- connects to Wi-Fi
- runs `scanner.js` as a `systemd` service
- auto-detects the scanner input device
- sends scan events to the cloud
- can be updated remotely from a development machine

---

## Prerequisites

Before starting:

- Raspberry Pi with Raspberry Pi OS installed
- Barcode scanner connected via USB
- SSH enabled on the Pi
- Node.js installed
- Network available
- Deployment machine (Windows) with:
  - PowerShell
  - deploy-to-pi.ps1
- Scanner project files ready
- Shared secret available

---

## 1. Base System Setup

On the Pi:

sudo apt update
sudo apt install -y network-manager evtest nodejs npm

Verify:

node -v
npm -v
which evtest

---

## 2. Network Setup

sudo systemctl enable NetworkManager
sudo systemctl start NetworkManager

nmcli dev wifi list
nmcli dev wifi connect "SSID" password "PASSWORD"

Verify:

ping -c 3 google.com

---

## 3. Create Scanner Directory

mkdir -p /home/multimedica_edge/scanner

---

## 4. Deploy Code from Windows

From your development machine:

.\deploy-to-pi.ps1

---

## 5. Create .env Configuration

nano /home/multimedica_edge/scanner/.env

SHARED_SECRET=your_real_secret_here
ROOM_ID=reg_room_1
STATION_ID=reg
DEVICE_ID=scanner_pi_01
SCANNER_DEVICE_NAME=BF SCAN SCAN KEYBOARD
ENDPOINT_URL=https://us-central1-alfarero-478ad.cloudfunctions.net/receiveRoomScanEvent

---

## 6. Install Scanner Service

cd /home/multimedica_edge/scanner
chmod +x install-scanner.sh
./install-scanner.sh

Verify:

sudo systemctl status scanner.service

---

## 7. Confirm Scanner Detection

grep -E 'Name=|Handlers=' /proc/bus/input/devices

Check logs:

journalctl -u scanner.service -n 30 --no-pager

---

## 8. End-to-End Test

journalctl -u scanner.service -f

Scan a barcode.

Expected:

SCAN: ...
POST STATUS: 200

---

## 9. Reboot Test (REQUIRED)

sudo reboot

After reboot:

sudo systemctl status scanner.service
journalctl -u scanner.service -n 30 --no-pager

---

## 10. Update Workflow

.\deploy-to-pi.ps1

---

## 11. Troubleshooting

Service not found:
ls -l /etc/systemd/system/scanner.service

Logs:
journalctl -u scanner.service -n 50 --no-pager

Scanner devices:
grep -E 'Name=|Handlers=' /proc/bus/input/devices

---

## 12. Deployment Record

Track:

- hostname
- location
- ROOM_ID
- STATION_ID
- DEVICE_ID
- deployment date

---

## 13. Acceptance Criteria

Deployment is complete only if:

- service is enabled
- survives reboot
- detects scanner
- successfully posts to backend

---

## 14. Known Improvements

- SSH key setup
- passwordless sudo
- barcode-based config
- heartbeat logging
- stable device path
