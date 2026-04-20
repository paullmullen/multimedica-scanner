#!/usr/bin/env bash
set -e

APP_DIR="/home/multimedica_edge/scanner"
SERVICE_NAME="scanner.service"
RUN_USER="multimedica_edge"

echo "==> Installing scanner service"

if [ ! -f "$APP_DIR/scanner.js" ]; then
  echo "ERROR: scanner.js not found"
  exit 1
fi

echo "==> Installing node if needed"
if ! command -v node >/dev/null 2>&1; then
  sudo apt update
  sudo apt install -y nodejs npm
fi

echo "==> Installing dependencies"
cd "$APP_DIR"
if [ -f package.json ]; then
  npm install --omit=dev
fi

echo "==> Writing systemd service"

sudo tee /etc/systemd/system/$SERVICE_NAME > /dev/null <<EOF
[Unit]
Description=Clinic Scanner Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=-$APP_DIR/.env
ExecStart=$(which node) $APP_DIR/scanner.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl restart $SERVICE_NAME

echo "==> Scanner installed"