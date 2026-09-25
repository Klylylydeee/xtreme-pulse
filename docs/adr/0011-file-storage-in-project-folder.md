# ADR 0011: Files stored in a folder with the app

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

The original spec stored uploaded and generated files in S3-compatible storage: MinIO locally, and a private bucket with short-lived signed URLs in production. Xtreme Pulse is internal, self-hosted and used by one company, so a separate storage service adds another thing to run, secure and back up.

## Decision

Store every uploaded and generated file in a `storage/` folder with the app, by default at the repo root (`FILE_STORAGE_DIR`). The folder is outside `public/` and git-ignored. Files are saved under generated names through one storage service, and open only through a Route Handler that checks the viewer's access to the owning record. That access check replaces signed URLs.

## Consequences

- No MinIO or S3 to run. The local Docker stack is MongoDB and Redis only, and the four `S3_*` variables are replaced by `FILE_STORAGE_DIR`.
- Deploys must leave `storage/` in place, and backups must include it with the database and the encryption key.
- Files sit on one server's disk, so running several app servers would need a shared drive or a move to object storage. Because modules use only the storage service, that move stays contained.
- Sensitive files (medical certificates, 201 files, payslips) are on that disk, so the server's disk encryption and file permissions matter (see [DEPLOYMENT.md](../DEPLOYMENT.md#still-to-decide)).

## Where the rules live

[File storage](../ARCHITECTURE.md#file-storage), [Sensitive data](../../SECURITY.md#sensitive-data)
