if [[ -z "$DISPLAY" && -z "$SSH_CONNECTION" && "$(tty)" == "/dev/tty1" ]]; then
  echo "Starting kiosk at $(date)" >> /home/multimedica_edge/kiosk.log
  startx /opt/multimedica-scanner/kiosk/start-kiosk.sh -- >> /home/multimedica_edge/kiosk.log 2>&1
fi