# Multimedica Scanner Documentation

This directory contains the active technical and operational documentation for the Multimedica Raspberry Pi scanner appliance.

## Start here

| Document | Audience | Purpose |
|---|---|---|
| [Installation Guide](installation.md) | Installer | Build, commission, release, and validate a scanner from a clean Pi image |
| [Installation Theory of Operation](SCANNER-INSTALLATION-THEORY-OF-OPERATION.md) | Developer and technical owner | Understand the architecture, safety contracts, promotion, rollback, and recovery model |
| [Architecture Guide](architecture.md) | Developer | Understand scanner routing, cloud authority, display state, and local APIs |
| [Bootstrap Architecture](bootstrap-architecture.md) | Developer and qualification owner | Understand the qualified platform and Raspberry Pi image baseline |
| [QR Configuration](qr-configuration.md) | Developer and administrator | **Pending refresh:** use current schemas and tests as the low-level authority |
| [Troubleshooting](troubleshooting.md) | Installer and support owner | **Pending refresh:** begin diagnosis with the supported read-only `-Verify` mode |

## Document roles

The installation guide is the authoritative operator procedure. It should contain only supported commands and observable acceptance criteria.

The theory-of-operation document explains why the procedure and deployment controls exist. It is not a substitute for the operator procedure.

The architecture documents describe implementation boundaries and qualification evidence. Source code, schemas, and automated tests remain authoritative when a low-level contract changes.

## Historical material

Milestone planning, verification reports, implementation proposals, and superseded acceptance procedures are retained under:

```text
docs/archive/
```

Archived files are historical records. Do not use them as current installation instructions.

## Documentation maintenance

When the deployment workflow changes:

1. update the implementation and tests;
2. validate the change on qualified hardware;
3. update `installation.md` with the supported operator action;
4. update the theory or architecture documents if responsibilities or safety boundaries changed;
5. move superseded procedures to the archive rather than leaving conflicting active guidance.
