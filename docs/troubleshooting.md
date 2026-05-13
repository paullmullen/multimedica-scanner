# Troubleshooting Guide

Purpose:

Operational diagnostics and recovery SOPs.

---

# Scanner Not Scanning

## Symptoms

- scans ignored
- no cloud events

## Diagnostics

```bash
evtest
```

## Likely Causes

- incorrect scanner device name
- USB disconnect
- scanner service down

## Recovery

- reconnect scanner
- update env variable
- restart service

---

# Kiosk Display Blank

## Diagnostics

```bash
systemctl status kiosk-display.service
```

```bash
curl http://127.0.0.1:3001/api/display
```

---

# Cloud Unauthorized

Verify:

- SHARED_SECRET
- endpoint URL
- cloud function access

---

# Wrong Station Displayed

Verify:

- STATION_ID
- ROOM_ID
- station_config QR

---

# Polling Not Updating Display

Verify:

- polling enabled
- cloud response
- station identity

---

# Useful Commands

```bash
journalctl -u multimedica-scanner.service -f
```

```bash
journalctl -u kiosk-display.service -f
```

```bash
curl http://127.0.0.1:3002/status | jq
```
