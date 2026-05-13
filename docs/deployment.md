# Deployment Guide

Purpose:

Document deployment/update workflows.

---

# GitHub Workflow

Recommended:

```text
feature branch
→ test Pi
→ production merge
→ production deployment
```

---

# Pull-On-Boot Updates

Document:

- GitHub repo
- branch tracking
- startup pulls
- failure handling

---

# Safe Deployment Procedure

1. Deploy to test Pi
2. Validate scanner
3. Validate kiosk
4. Validate polling
5. Merge to production

---

# Rollback Procedure

Document:

- reverting commits
- redeploying known-good version
- validating recovery
