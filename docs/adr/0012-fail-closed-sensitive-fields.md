# ADR 0012: Fail-closed sensitive fields, database validators and guard tests

- **Status:** Accepted (build step 0.8, 2026-09-27; completed 2026-10-03 with the validator rule, the refused write options and the `$out` result). Amends [ADR 0005](0005-field-level-encryption.md) and narrows [ADR 0010](0010-manual-verification-before-automated-tests.md).
- **Date:** 2026-09-27

## Context

[ADR 0005](0005-field-level-encryption.md) uses explicit encryption, so the code must make sure no sensitive field is ever stored in plain text. Step 0.8 first tried to guard every Mongoose shape and write path at write time. That proved leaky: arrays of plain values, Maps, discriminators, `strict: false`, `$rename`, upserts, update pipelines, `bulkWrite`, `replaceOne`, `$merge`/`$out` and raw driver calls each needed their own handling, and a missed path stores plain text silently.

None of the planned sensitive data (bank accounts, government IDs, salary, 201 files, payroll history, dependents' IDs) needs the unusual shapes. And a check by hand, as [ADR 0010](0010-manual-verification-before-automated-tests.md) has every step use, can't cover this many write paths.

## Decision

Three layers, each failing closed:

1. **Few shapes, checked when the schema is defined.** A `sensitiveField()` may only be a single-value field on a document or nested subdocument, or a field inside an array of subdocuments. Anything else throws when the schema or model is defined, and so does a schema with sensitive fields that has the option `strict: false` (or whose nested schemas do). Risky writes are refused. The exact list is in [Sensitive data](../../SECURITY.md#sensitive-data).
2. **A database validator behind the guard.** Every collection with sensitive paths gets a `$jsonSchema` validator with `validationLevel: "strict"` and `validationAction: "error"`. A plain value is rejected by MongoDB itself, whatever path the write took. The validator is generated from the schema's sensitive paths and covers only those paths:
   - **The leaf rule.** Each sensitive path is `{ encrypt: {} }`, which MongoDB accepts only for BSON binary subtype 6, the encrypted value in ADR 0005's format. It works on Community at every placement the validator uses (checked in step 0.8; see [ADR 0005](0005-field-level-encryption.md)), so the plain `bsonType: "binData"` fallback isn't needed.
   - **`null` is refused, absent is allowed.** A sensitive field either holds ciphertext or is left out. No sensitive path is `required` in the validator (the schema's own `required` still applies in Mongoose). To clear a value, `$unset` it. The guard and `sensitiveField()`'s setter refuse `null` too.
   - **Container types are pinned.** Each object on the way to a sensitive path (a nested object or a subdocument) must be an object or `null`, and each array of subdocuments an array (or `null`) whose items are objects. Otherwise a value could be stored in a shape the validator doesn't look into, such as an object where the array belongs. A `null` container holds nothing, so it is allowed.
   - **What the validator's error holds.** MongoDB's `DocumentValidationFailure` (code 121) message names no value, but its `errInfo` details include the rejected value. Never log or send that error's details.
3. **Write options that skip a layer are refused.** On a model with sensitive fields, the guard refuses `strict: false` (a query option, a `bulkWrite` option or operation, or a document created with it) and `bypassDocumentValidation` (in query and `bulkWrite` options, and on the model's aggregates). An aggregate of any model is refused too when it sets `bypassDocumentValidation` and its `$out` or `$merge` writes to a collection with sensitive fields. Mongoose 9's `insertMany` hook can't see its options, so the option can't be refused there; the inserted documents are still checked. `save` and `create` never pass the option to MongoDB.
4. **Committed tests for the guard and the validator.** These are the project's first automated tests (see [Sensitive-data guard tests](../TESTING.md#sensitive-data-guard-tests)).

**`$out` and `$merge`.** Checked in step 0.8 (and by the guard tests): when `$out` replaces a collection that has the validator, the new collection keeps the validator, and both `$out` and `$merge` validate every document they write, so a plain value fails with code 121 and nothing is written. Only `bypassDocumentValidation` skips that check, which is why it is refused (point 3). No separate `$out` guard is needed.

**When the validator is installed.** With the model's indexes, in the same readiness step (`connectDb()` builds every registered model's indexes before services write; see `packages/db/src/indexes.ts`). The step creates the collection with the validator, or updates it with `collMod` when the generated validator differs, so running it again changes nothing. A write to a model whose validator isn't in place yet waits or fails exactly as it does for a missing index. `pnpm seed:admin` connects the same way, so it installs the validators on a new database too. This was chosen over a separate migration command because there isn't one yet, and because the index step already runs before any write and is already idempotent.

## Consequences

- A sensitive field that needs another shape (for example a list of plain values) needs a spec change first, and usually a subdocument instead.
- The validator checks the type (binary subtype 6), not the bytes. `sensitiveField()`, the guard and `decryptSensitive` check the header, and decryption checks the tag.
- Writes that bypass Mongoose still can't store plain text, but they get a MongoDB `DocumentValidationFailure` (code 121) instead of the guard's error. The raw driver can still pass `bypassDocumentValidation`; module code never uses the raw driver (reviews check it).
- **Known limits, accepted.** Besides the raw driver, two Mongoose paths skip the guard. Fixing them would mean wrapping Mongoose's own methods, so they are accepted and closed by rule instead:
  - **`middleware: false`.** Mongoose 9's per-call option `middleware: false` (or `middleware: { pre: false }`, which skips only the pre hooks) skips every user hook, the guard included. It works on query writes, `insertMany`, `bulkWrite`, `save` and aggregates.
  - **`connection.bulkWrite`.** `mongoose.connection.bulkWrite([{ model, name, … }])` casts each operation but never runs the model's `bulkWrite` hooks.
  - **With `bypassDocumentValidation`**, these paths store plain text: for example an update pipeline with `middleware: false`, a lean `insertMany` with `middleware: false`, or a `$merge` aggregate with `.option({ middleware: false })`.
  - **Without it**, a plain value in a pipeline fails at the validator (code 121). But a plain value or `null` in a plain update or an insert goes through `sensitiveField()`'s setter, which turns it into an empty encrypted placeholder. The validator accepts that (it checks the subtype, not the bytes), so the write succeeds and the value is lost silently. `null` isn't refused on these paths.
  - **Mitigation.** Code never passes these options or calls `connection.bulkWrite`. ESLint (`eslint.config.mjs`) bans `middleware` and `bypassDocumentValidation` as object keys, and `bulkWrite` called on something named `connection`, `conn` or `db`, in `apps/`, `packages/` and `scripts/`. A computed key, an options object built elsewhere, or a connection under another name isn't caught, so reviews check those too. The guard tests pin today's behaviour as "known limitation" tests, so a later fix shows up as a failing test to flip.
- Changing a sensitive schema changes its validator on the next start. Existing plain-text data: not applicable, because no sensitive data is stored before production. Were any ever found, those documents couldn't be updated until encrypted (the validator is `strict`), and a one-off migration would encrypt them.
- `pnpm test` now runs, and must pass, for the guard suite. It uses Vitest and a throwaway `mongodb-memory-server` replica set. MongoDB publishes no Windows on Arm build, so on that platform the suite downloads and runs the x64 build under emulation (see [TESTING.md](../TESTING.md#sensitive-data-guard-tests)). Everything else is still checked by hand as [ADR 0010](0010-manual-verification-before-automated-tests.md) says.

## Where the rules live

[Sensitive data](../../SECURITY.md#sensitive-data), [TESTING.md](../TESTING.md#sensitive-data-guard-tests), [build step 0.8](../BUILD_PLAN.md#phase-0-foundation)
