#!/bin/bash

LOG_FILE="/home/multimedica_edge/kiosk-browser.log"

echo "==== Kiosk start $(date) ====" >> $LOG_FILE

# Wait for X
sleep 2

# Disable screen blanking
xset s off
xset -dpms
xset s noblank

# Optional: hide cursor
unclutter -idle 0.5 -root &

# Launch Chromium with logging
/usr/lib/chromium/chromium \
  --user-data-dir=/home/multimedica_edge/kiosk-profile \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --disable-features=Translate \
  --disable-restore-session-state \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --disable-gpu \
  --disable-gpu-compositing \
  --disable-gpu-rasterization \
  --disable-software-rasterizer \
  --enable-logging=stderr \
  --v=1 \
  --app=http://127.0.0.1:3001 \
  >> $LOG_FILE 2>&1