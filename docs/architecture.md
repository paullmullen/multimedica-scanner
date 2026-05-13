# Architecture Guide

Purpose:

Technical deep dive into scanner/display architecture.

---

# System Architecture

```text
Scanner
  ↓
scanner.js
  ↓
Cloud Functions
  ↓
Firestore
  ↓
Kiosk Display
```

---

# Scanner Lifecycle

```text
Scan barcode
→ local scanner runtime
→ cloud ingest
→ workflow engine
→ response payload
→ display update
→ polling reconciliation
```

---

# Cloud Authority Model

The cloud is authoritative.

The Pi acts as:

- local cache
- display appliance
- event producer

---

# Polling Philosophy

Polling exists to:

- correct drift
- synchronize manual changes
- recover from transient failures

---

# Operational States

Document:

- available
- patient_waiting
- in_process
- clinic_closed
- offline
- degraded

---

# QR Configuration Workflow

```text
Scan QR
→ validate token
→ persist config
→ update env
→ restart/reload
→ overlay confirmation
```

---

# Observability Model

Document:

- status endpoints
- stale thresholds
- health state logic
- future dashboard goals
