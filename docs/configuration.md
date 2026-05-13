# Configuration Guide

Purpose:

Document operational constants and subsystem configuration philosophy.

---

# Configuration Philosophy

Each subsystem owns its own runtime policy.

Avoid unnecessary shared config.

---

# Config Objects

| File | Config Object |
|---|---|
| scanner.js | SCANNER_CONFIG |
| app.js | DISPLAY_CONFIG |
| server.js | DISPLAY_SERVER_CONFIG |

---

# Configuration Evolution

```text
magic number
→ named constant
→ grouped config
→ shared policy only if necessary
```

---

# Environment Variables

Document all runtime variables.
