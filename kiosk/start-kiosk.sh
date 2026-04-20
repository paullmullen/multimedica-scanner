#!/bin/bash
set -e

xset s off
xset -dpms
xset s noblank

unclutter &
openbox-session &

rm -rf /home/multimedica_edge/kiosk-profile
mkdir -p /home/multimedica_edge/kiosk-profile

exec chromium \
  --user-data-dir=/home/multimedica_edge/kiosk-profile \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --disable-features=Translate \
  --disable-restore-session-state \
  --app=http://127.0.0.1:3000