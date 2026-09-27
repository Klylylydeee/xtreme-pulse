# ADR 0012: Fail-closed sensitive fields, database validators and guard tests

- **Status:** Accepted (build step 0.8, 2026-09-27). Amends [ADR 0005](0005-field-level-encryption.md) and narrows [ADR 0010](0010-manual-verification-before-automated-tests.md).
- **Date:** 2026-09-27

## Context

[ADR 0005](0005-field-level-encryption.md) uses explicit encryption, so the code must make sure no sensitive field is ever stored in plain text. Step 0.8 first tried to guard every Mongoose shape and write path at write time. That proved leaky: arrays of plain values, Maps, discriminators, `strict: false`, `$rename`, upserts, update pipelines, `bulkWrite`, `replaceOne`, `$merge`/`$out` and raw driver calls each needed their own handling, and a missed path stores plain text silently.

None of the planned sensitive data (bank accounts, government IDs, salary, 201 files, payroll history, dependents' IDs) needs the unusual shapes. And a check by hand, as [ADR 0010](0010-manual-verification-before-automated-tests.md) has every step use, can't cover this many write paths.

## Decision

Three layers, each failing closed:

1. **Few shapes, checked when the schema is defined.** A `sensitiveField()` may only be a single-value field on a document or nested subdocument, or a field inside an array of subdocuments. Anything else throws when the schema or model is defined. Risky writes are refused. The exact list is in [Sensitive data](../../SECURITY.md#sensitive-data).
2. **A database validator behind the guard.** Every collection with sensitive paths gets a `$jsonSchema` validator with `validationAction: "error"`. Each sensitive path, when present, must be BSON binary (`bsonType: "binData"`), the type of the encrypted value in ADR 0005's format (binary subtype 6). A plain string or number is rejected by MongoDB itself, whatever path the write took. The validator is generated from the schema's sensitive paths (nested subdocuments through `properties`, arrays of subdocuments through `items`) and covers only those paths.
3. **Committed tests for the guard and the validator.** These are the project's first automated tests (see [Sensitive-data guard tests](../TESTING.md#sensitive-data-guard-tests)).

**When the validator is installed.** With the model's indexes, in the same readiness step (`connectDb()` builds every registered model's indexes before services write; see `packages/db/src/indexes.ts`). The step creates the collection with the validator, or updates it with `collMod` when the generated validator differs, so running it again changes nothing. A write to a model whose validator isn't in place yet waits or fails exactly as it does for a missing index. `pnpm seed:admin` connects the same way, so it installs the validators on a new database too. This was chosen over a separate migration command because there isn't one yet, and because the index step already runs before any write and is already idempotent.

## Consequences

- A sensitive field that needs another shape (for example a list of plain values) needs a spec change first, and usually a subdocument instead.
- The validator only checks that the value is binary. It can't tell subtype 6 from other binary subtypes; `sensitiveField()` and `decryptSensitive` check the subtype and header. Whether MongoDB's `encrypt` keyword can pin subtype 6 on Community is checked in step 0.8; if it can, the validator uses it.
- Writes that bypass Mongoose still can't store plain text, but they get a MongoDB `DocumentValidationFailure` (code 121) instead of the guard's error.
- Changing a sensitive schema changes its validator on the next start. Existing plain-text data, if any ever existed, would block updates to those documents until encrypted.
- `pnpm test` now runs, and must pass, for the guard suite. Everything else is still checked by hand as [ADR 0010](0010-manual-verification-before-automated-tests.md) says.

## Where the rules live

[Sensitive data](../../SECURITY.md#sensitive-data), [TESTING.md](../TESTING.md#sensitive-data-guard-tests), [build step 0.8](../BUILD_PLAN.md#phase-0-foundation)
