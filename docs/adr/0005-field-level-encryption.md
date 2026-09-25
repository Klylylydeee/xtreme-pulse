# ADR 0005: Field-level encryption for sensitive data

- **Status:** Proposed. Build step 0.8 settles it: fill in the decision and mark it Accepted.
- **Date:** 2026-09-24 (original spec)

## Context

Salary, government IDs, bank accounts, payslips and other sensitive fields must be encrypted at rest (see [Sensitive data](../../SECURITY.md#sensitive-data)). MongoDB offers Client-Side Field Level Encryption and Queryable Encryption.

**Note on encryption:** MongoDB's automatic field-level encryption needs MongoDB Enterprise or Atlas. On MongoDB Community, the app uses explicit encryption instead. Step 0.8 settles which one.

## Decision

_To be recorded in step 0.8:_ automatic or explicit encryption, the MongoDB edition it depends on, where the key vault lives, and how `FIELD_ENCRYPTION_LOCAL_KEY` is stored and backed up.

## Consequences

- Encrypted fields can't be read without the master key, so the key needs a safe copy (see [Encryption key lost or changed](../RUNBOOK.md#encryption-key-lost-or-changed)).
- With explicit encryption, the code encrypts and decrypts each sensitive field itself, so reviews must check that no sensitive field is stored in plain text.
- Masked display and audited reveal work the same either way.

## Where the rules live

[Sensitive data](../../SECURITY.md#sensitive-data), [Secrets](../../SECURITY.md#secrets)
