# Milestone 2 Security Requirements

## SCANNER_QR_ADMIN_TOKEN — Pre-Commissioning Actions Required

The following actions must be completed before any real-device commissioning run.
They are not part of Milestone 1 (shared modules and CI tests) and must not be
deferred beyond the start of Milestone 2 hardware installation.

---

### 1. Resolve the token character-encoding ambiguity

Two candidate values exist in the `alfarero_clinic` repository:

| Identifier | Source | Byte length | Notes |
|---|---|---|---|
| `<redacted-ascii-candidate>` | `alfarero_clinic/.env` `REACT_APP_SCANNER_QR_ADMIN_TOKEN` | 36 bytes | US-ASCII |
| `<redacted-unicode-candidate>` | `alfarero_clinic/edge_device_secret_token.txt` | 38 bytes (UTF-8) | Contains multi-byte characters |

These are distinct byte sequences. A Pi provisioned with one value will reject
every QR generated with the other.

**Action:** Query the deployed Cloud Function environment directly to confirm
which byte sequence is live. Record the confirmed value as the authoritative
token in the internal installer configuration store. Destroy or archive both
candidate reference files once the authoritative value is confirmed.

### 2. Rotate the token before commissioning

The current `SCANNER_QR_ADMIN_TOKEN` value is exposed in the compiled React
browser bundle (via `REACT_APP_SCANNER_QR_ADMIN_TOKEN`). Anyone who inspects
the production build can extract it.

**Action:** Before deploying bootstrap to a real device:

1. Generate a new, strong random token value.
2. Deploy the new value to the Cloud Function environment.
3. Rebuild and redeploy the React application with the new value in its build-time
   environment.
4. Supply the new value to the internal PowerShell installer configuration file
   (`multimedica-installer.json`).

The `qr-contract.js` parser uses strict byte-for-byte comparison (`===`).
All three components (Cloud Function, React build, Pi secrets store) must carry
the same exact value after rotation.

### 3. Token handling rules (opaque exact-value treatment)

The token is an opaque byte sequence. No component may:

- `trim()` the token
- Normalise Unicode (NFC, NFD, or other forms)
- Case-fold the token
- Remove accents, diacritics, or combining characters
- Re-encode from one character set to another

The token value stored in `secrets.json`, the value embedded in QR payloads by
the Cloud Function, and the value used by the React component to call the Cloud
Function must all be the same byte sequence. Verify this after rotation by
scanning a test QR and confirming the Pi controller accepts it.

### 4. Remove plaintext token references from tracked files

After confirming the authoritative rotated value:

- Remove `alfarero_clinic/edge_device_secret_token.txt` from the `alfarero_clinic`
  repository, or replace its content with a clear notice that the file has been
  superseded.
- Ensure `REACT_APP_SCANNER_QR_ADMIN_TOKEN` is not committed to the `alfarero_clinic`
  repository in any `.env`, `.env.production`, or other environment file. Use
  a secrets management system or CI environment variable instead.
- Confirm that `SCANNER_QR_ADMIN_TOKEN` does not appear in any source file, log,
  or build artifact that is publicly accessible.

### 5. Authoritative secret store

After rotation, the deployed Cloud Function environment variable is the
authoritative source. The `multimedica-installer.json` on each Windows workstation
used for field installation must be updated with the rotated value. Access to this
file must be limited to authorised installers.

Per-device enrollment and signed per-device QR tokens are deferred to a later
hardening milestone; v1 uses a shared fleet token.

---

## Consequence of non-compliance

If commissioning proceeds without rotation:

- Any person with access to the production React bundle can generate valid
  provisioning QRs for any Multimedica scanner.
- A scanner reconfigured this way would accept silently, with no audit trail.

Rotation before first real-device commissioning is a hard prerequisite.
