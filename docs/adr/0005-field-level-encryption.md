# ADR 0005: Field-level encryption for sensitive data

- **Status:** Accepted (build step 0.8, 2026-09-27; `encrypt` keyword result added 2026-10-03). Amended by [ADR 0012](0012-fail-closed-sensitive-fields.md): supported field shapes and a database validator.
- **Date:** 2026-09-24 (original spec)

## Context

Salary, government IDs, bank accounts, payslips and other sensitive fields must be encrypted at rest (see [Sensitive data](../../SECURITY.md#sensitive-data)). MongoDB offers Client-Side Field Level Encryption and Queryable Encryption.

**Note on encryption:** MongoDB's automatic field-level encryption needs MongoDB Enterprise or Atlas. On MongoDB Community, the app uses explicit encryption instead. Step 0.8 settles which one.

## Decision

**Explicit encryption, on MongoDB Community.** Development runs MongoDB 8 Community Edition, installed locally, and production is planned on Community too, so automatic encryption isn't available. Each service encrypts a sensitive value before saving it and decrypts it only where the full value is needed.

- **Format.** Values use MongoDB's own Client-Side Field Level Encryption format: BSON binary subtype 6, algorithm `AEAD_AES_256_CBC_HMAC_SHA_512-Random` (AES-256-CBC with an HMAC-SHA-512 tag, a random IV per value). A changed byte, or the wrong key, is detected and refused.
- **Implementation.** MongoDB's `mongodb-client-encryption` package is a native add-on with no prebuilt binary for every platform the team develops on (Windows on ARM needs a C/C++ toolchain to build it). So `@pulse/core/server` implements the same format with Node's built-in `crypto`, and it was checked both ways against MongoDB's own `ClientEncryption`. Switching to MongoDB's library later, or to automatic encryption on Enterprise or Atlas, needs no re-encryption.
- **Key vault.** Data keys live in the `encryptionKeys` collection of the app's own database, in MongoDB's key vault format, each wrapped by the master key (MongoDB's `local` key provider). One data key, named `sensitiveFields`, encrypts every field today. The vault is backed up with the database.
- **Master key.** `FIELD_ENCRYPTION_LOCAL_KEY` holds 96 random bytes, base64-encoded. It lives only in `.env.local` locally and in the server environment in production, never in the database or the repo. A copy is kept offline, outside the server (see [Secrets](../../SECURITY.md#secrets) and [DEPLOYMENT.md](../DEPLOYMENT.md#still-to-decide)).
- **The database checks the format too.** MongoDB's `$jsonSchema` `encrypt` keyword works on Community: checked by hand in step 0.8 on 8.3.11 Community, and by the guard tests on the 8.2 build they run. With `{ encrypt: {} }` on a path, MongoDB accepts only BSON binary subtype 6 there and rejects other binary subtypes, strings, numbers and `null`. It works at every placement the validator needs: a top-level field, a field in nested `properties`, and a field under an array's `items`. It can't be combined with `bsonType` (MongoDB refuses the validator with code 9), and it doesn't encrypt or check the bytes, only the type. So every sensitive-field validator uses `encrypt` (see [ADR 0012](0012-fail-closed-sensitive-fields.md)).
- **Showing values.** Screens get only the last 4 characters. The full value is fetched only when the user presses Reveal (the masked field component), through `revealSensitive`, which Phase 1 access-checks and audit-logs.

## Consequences

- Encrypted fields can't be read without the master key, so the key needs a safe copy (see [Encryption key lost or changed](../RUNBOOK.md#encryption-key-lost-or-changed)).
- With explicit encryption, the code encrypts and decrypts each sensitive field itself, so reviews must check that no sensitive field is stored in plain text.
- Masked display and audited reveal work the same either way.
- Explicit encryption can't search on an encrypted field. No sensitive field needs that today; a later need would use deterministic encryption or a separate hash, decided then.
- Changing the master key means re-wrapping the data keys (not re-encrypting every field), and it must be planned (see [Runbook](../RUNBOOK.md#encryption-key-lost-or-changed)).

## Where the rules live

[Sensitive data](../../SECURITY.md#sensitive-data), [Secrets](../../SECURITY.md#secrets)
