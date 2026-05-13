# Kiosk Display API

Purpose:

Document local display APIs and testing workflows.

---

# GET /api/display

Example:

```bash
curl http://127.0.0.1:3001/api/display | jq
```

---

# POST /api/display

Used for:

- testing
- overlays
- provisioning validation
- troubleshooting

Example:

```bash
curl -X POST http://127.0.0.1:3001/api/display \\
  -H "Content-Type: application/json" \\
  -d '{
    "mode": "available",
    "station": {
      "label": "NUR"
    }
  }'
```

---

# Overlay Examples

## Success Overlay

## Error Overlay

## Warning Overlay

---

# Display State Structure

Document payload schema.
