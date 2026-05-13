# QR Configuration

Purpose:

Document QR-based appliance configuration workflows.

---

# Supported QR Types

- station_config
- wifi_config
- cloud_config

---

# QR Payload Structure

```json
{
  "kind": "station_config",
  "version": 1,
  "payload": {},
  "auth": {}
}
```

---

# Validation Rules

- MMCFG prefix required
- admin token required
- version validation

---

# Workflow

```text
scan QR
→ validate
→ persist
→ reload
→ overlay confirmation
```
