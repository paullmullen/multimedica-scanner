# Observability Guide

Purpose:

Document health/status endpoints and diagnostics.

---

# Status Endpoints

## /status

Detailed health payload.

## /status/summary

Compact operational summary.

---

# Health Concepts

Document:

- stale
- degraded
- offline
- polling state
- cloud sync

---

# Example Commands

```bash
curl http://127.0.0.1:3002/status | jq
```

---

# Future Goals

- fleet dashboard
- remote diagnostics
- centralized monitoring
