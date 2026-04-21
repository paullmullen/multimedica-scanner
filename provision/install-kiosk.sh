#!/usr/bin/env bash
set -e

APP_DIR="/home/multimedica_edge/scanner"
USER="multimedica_edge"

echo "==> Installing kiosk packages"

sudo apt update
sudo apt install -y --no-install-recommends \
  xserver-xorg \
  x11-xserver-utils \
  xinit \
  openbox \
  chromium \
  unclutter \
  xserver-xorg-legacy

echo "==> Configuring X wrapper"

sudo tee /etc/X11/Xwrapper.config > /dev/null <<EOF
allowed_users=anybody
needs_root_rights=yes
EOF

echo "==> Installing Openbox config"

mkdir -p /home/$USER/.config/openbox

cat > /home/$USER/.config/openbox/autostart <<EOF
xset s off
xset -dpms
xset s noblank
unclutter &
EOF

echo "==> Installing kiosk launcher"

chmod +x $APP_DIR/kiosk/start-kiosk.sh

echo "==> Installing kiosk service"

sudo tee /etc/systemd/system/kiosk.service > /dev/null <<EOF
[Unit]
Description=Scanner Display Kiosk
After=network.target

[Service]
User=$USER
Environment=XAUTHORITY=/home/$USER/.Xauthority
Environment=DISPLAY=:0
ExecStart=/usr/bin/startx $APP_DIR/kiosk/start-kiosk.sh --
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

echo "==> Kiosk installed"