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

# Discover Chromium executable (path differs between Raspberry Pi OS versions)
CHROMIUM_BIN=""
for _candidate in chromium chromium-browser /usr/lib/chromium/chromium /usr/bin/chromium /usr/bin/chromium-browser; do
  if command -v "$_candidate" >/dev/null 2>&1; then
    CHROMIUM_BIN="$_candidate"
    break
  fi
done
if [ -z "$CHROMIUM_BIN" ]; then
  echo "ERROR: Chromium not found. Install chromium or chromium-browser." >&2
  exit 1
fi
echo "Using Chromium: $CHROMIUM_BIN" >> $LOG_FILE

# Launch Chromium with logging
"$CHROMIUM_BIN" \
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
  --app=http://127.0.0.1:3001/boot.html\
  >> $LOG_FILE 2>&1