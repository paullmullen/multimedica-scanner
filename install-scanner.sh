#!/usr/bin/env bash
set -e

APP_NAME="scanner"
APP_DIR="/home/multimedica_edge/scanner"
SERVICE_NAME="scanner.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
RUN_USER="multimedica_edge"
RUN_GROUP="multimedica_edge"

echo "==> Installing ${APP_NAME} service"

if [ ! -d "${APP_DIR}" ]; then
  echo "ERROR: ${APP_DIR} does not exist"
  echo "Clone or copy your repo there first."
  exit 1
fi

if [ ! -f "${APP_DIR}/scanner.js" ]; then
  echo "ERROR: ${APP_DIR}/scanner.js not found"
  exit 1
fi

echo "==> Setting ownership"
sudo chown -R "${RUN_USER}:${RUN_GROUP}" "${APP_DIR}"

echo "==> Detecting node path"
NODE_PATH="$(which node)"
if [ -z "${NODE_PATH}" ]; then
  echo "ERROR: node not found in PATH"
  exit 1
fi
echo "Node path: ${NODE_PATH}"

if [ -f "${APP_DIR}/package.json" ] && [ -s "${APP_DIR}/package.json" ]; then
  echo "==> Installing npm dependencies"
  cd "${APP_DIR}"
  npm install --omit=dev
else
  echo "==> Skipping npm install (no package.json or file is empty)"
fi

echo "==> Writing systemd service file"
sudo tee "${SERVICE_PATH}" > /dev/null <<EOF
[Unit]
Description=Clinic Scanner Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
ExecStart=${NODE_PATH} ${APP_DIR}/scanner.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
KillSignal=SIGINT
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

echo "==> Reloading systemd"
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo "==> Service status"
sudo systemctl --no-pager --full status "${SERVICE_NAME}" || true