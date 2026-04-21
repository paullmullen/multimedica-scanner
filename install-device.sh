#!/usr/bin/env bash
set -e

APP_DIR="/home/multimedica_edge/scanner"

echo "=== Multimedica Device Install ==="

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: $APP_DIR not found"
  echo "Deploy repo to Pi first"
  exit 1
fi

echo "Step 1: Installing scanner..."
bash provision/install-scanner.sh

echo "Step 2: Installing kiosk..."
bash provision/install-kiosk.sh

echo "Step 3: Reloading systemd..."
sudo systemctl daemon-reload

echo "Step 4: Enabling services..."
sudo systemctl enable scanner.service

echo "=== Install complete ==="
echo "Reboot recommended"