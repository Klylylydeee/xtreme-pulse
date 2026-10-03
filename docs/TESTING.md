# Testing

How changes are checked. The short version: **few automated tests** (see [ADR 0010](adr/0010-manual-verification-before-automated-tests.md)): only the [sensitive-data guard tests](#sensitive-data-guard-tests) and the [audit, notification and reveal tests](#audit-notification-and-reveal-tests). Every build step is checked with typecheck, lint and a browser check, and every phase ends with a review and a hands-on phase check.

## What happens today

| Check | When | How |
|---|---|---|
| Typecheck and lint | After every build step | `pnpm typecheck` and `pnpm lint` must pass |
| Automated tests | After every build step | `pnpm test` must pass (see [Sensitive-data guard tests](#sensitive-data-guard-tests) and [Audit, notification and reveal tests](#audit-notification-and-reveal-tests)) |
| Browser check | After every build step | Open the step's screens in light and dark appearance and at phone width (see [Checking a screen](DESIGN_SYSTEM.md#checking-a-screen)) |
| "Done when" | After every build step | Each step in the [build plan](BUILD_PLAN.md) ends with a concrete "Done when" line. That line is the step's acceptance test |
| Phase review | End of every phase | A review sub-agent checks the whole phase against the docs, using the [security review checklist](../SECURITY.md#review-checklist) |
| Phase check | End of every phase | The hands-on walkthrough listed under each phase in the build plan |
| Whole-app review | Build step 7.8 | Review sub-agents check every module in parallel |

Development aids: `/dev/ui` shows every token and component, and `/dev/health` checks MongoDB (with a transaction), Redis, the worker, storage and encryption. Both are development-only.

`pnpm test` runs the committed automated tests: the sensitive-data guard suite and, from build step 1.3, the audit log, notification and sensitive reveal suites.

## Sensitive-data guard tests

The guard that keeps sensitive fields encrypted was the first area with committed automated tests ([ADR 0012](adr/0012-fail-closed-sensitive-fields.md)). A missed write path stores plain text silently, so a hand check isn't enough. The only other tested area is the [audit log, notifications and sensitive reveal](#audit-notification-and-reveal-tests). Other areas have no automated tests until this doc says so.

- **Scope.** The `sensitiveField()` guard and the `$jsonSchema` validator described in [Sensitive data](../SECURITY.md#sensitive-data). Nothing else.
- **Where.** Next to the code they test, as `*.test.ts`: the guard's tests in `packages/core/src/server/encryption/`, and the validator's beside the code that builds and installs it.
- **What `pnpm test` runs.** Every `*.test.ts` in the workspace, once, without watch mode. It must pass after every build step.
- **Framework.** Vitest (`vitest.config.ts` at the repo root). It suits the ESM, TypeScript setup (`"type": "module"`) with no extra build step. Files run one at a time, each in its own process.
- **Database.** A real MongoDB replica set that the suite starts and throws away: `mongodb-memory-server` in replica-set mode (one member), started by `vitest.global-setup.ts`. Each test file gets its own database, named `xtreme-pulse-test-…`, and a random throwaway `FIELD_ENCRYPTION_LOCAL_KEY`; the database is dropped after the file. The tests never load `.env.local`, never use the development database (`xtreme-pulse`), and never use real employee data.
  - **First run.** The first `pnpm test` downloads a MongoDB binary (the version `mongodb-memory-server` pins, 8.2 today; about 75 MB, cached in `~/.cache/mongodb-binaries` for later runs), so it needs internet access and takes longer. pnpm skips `mongodb-memory-server`'s own install script on purpose (`allowBuilds` in `pnpm-workspace.yaml`); the download happens in the test setup instead.
  - **Windows on Arm.** MongoDB publishes no Windows on Arm build, so there the setup uses the x64 build, which Windows runs under emulation. Set `MONGOMS_ARCH` or `MONGOMS_SYSTEM_BINARY` (the path of a `mongod` to use) to override this.
  - **Using another server.** Set `PULSE_TEST_MONGODB_URI` to a replica set connection string to skip `mongodb-memory-server`. It must name a database starting with `xtreme-pulse-test-`, or the suite refuses to start; each file then uses its own database with that name as a prefix, and drops it afterwards.
- **What it covers.**
  - Schema shapes refused when defined: a sensitive field in an array of plain values (at any depth), in a Map, on any discriminator, or in a schema with `strict: false`; and the supported shapes compile.
  - Writes the guard refuses: `strict: false`, `bypassDocumentValidation`, `null`, `$rename` into or out of a sensitive path or its parent, an upsert with a sensitive path in its filter, and plain values in `$setOnInsert`, `bulkWrite`, `replaceOne`, `findOneAndReplace`, update pipelines, lean `insertMany` and `save` without validation. Each refusal throws the expected error, whose message never contains the plaintext, and writes nothing.
  - Arrays of sensitive subdocuments: `$push` and `$addToSet` with encrypted values pass and with plain values fail; `$pull` and `$pop` pass.
  - Writes only the validator stops: raw calls through `Model.collection` (insert, `bulkWrite`, `replaceOne`, `findOneAndReplace`, update pipelines), `$merge` and `$out`. Each must fail with plain text (code 121) and succeed with encrypted values, and `$out` must leave the validator in place.
  - Every accepted write is read back raw and stored as binary subtype 6.
  - The validator is installed on every collection with sensitive paths, and installing it again changes nothing, also when another process creates the collection first.
  - Known limits ([ADR 0012](adr/0012-fail-closed-sensitive-fields.md#consequences)): tests named "known limitation" pin what happens today with `middleware: false` and `connection.bulkWrite`, which skip the guard. They store plain text with `bypassDocumentValidation`, and otherwise fail at the validator (update pipelines) or store an empty placeholder in place of a plain value or `null`. When a fix closes a gap, its test fails: change it to expect a refusal.

## Audit, notification and reveal tests

Added in build step 1.3. A broken audit log fails silently: a change without its entry, an entry that can be edited, or a password or sensitive value written into an entry all look fine on screen. So these rules have automated tests too. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only).

- **Where.** Next to the code they test, as `*.test.ts`: in `packages/core/src/server/audit/`, `notifications/`, `sensitive/` and `auth/`.
- **What they cover.**
  - **Audit log ([Audit log](modules/core.md#audit-log)).** An entry can be inserted. Every other write is refused and changes nothing: `updateOne`, `updateMany`, `findOneAndUpdate`, `replaceOne`, `deleteOne`, `deleteMany`, a `bulkWrite` with anything but inserts, `save()` on a loaded entry, and `$out`. Snapshot redaction: password-like keys, encrypted values, `Buffer` and `Binary` values, sensitive schema paths (top level, nested, in a subdocument and in an array of subdocuments) and `select: false` fields never reach an entry. On an update, a sensitive field whose stored value changed (or is new) is marked as changed in `after`, an unchanged one is not, and neither the value nor its ciphertext reaches the snapshot or the stored entry.
  - **Password change.** Exactly one `passwordChange` entry per change. The stored entry contains neither password nor either hash. When the audit insert fails, the password is unchanged.
  - **Sensitive reveal ([Sensitive data](../SECURITY.md#sensitive-data)).** A role × subject matrix of who may reveal what. An unregistered owner type or field is refused. The `reveal` entry names the field and holds neither the value nor its last 4 characters. When the audit write fails, no value is returned.
  - **Notifications ([Notifications](modules/core.md#notifications)).** Marking read ignores other users' notifications. The unread count is right. An external or `//` link is refused. Only `readAt` can change on a stored notification.

## Hand calculations

The riskiest code computes money, time and deadlines. Until automated tests exist, check these by hand against a worked example and keep the example in the step's notes:

- A payroll line for one Overtime-timesheet and one Standard-timesheet employee, from the seeded rates (build step 2.9)
- Billing milestones that sum exactly to the contract value, with the remainder on the last one (step 4.3)
- SLA due times across business hours, weekends and holidays (step 6.4)
- Holy Week dates from the Easter computation (step 1.10)

## When automated tests arrive (proposed)

Apart from the [sensitive-data guard tests](#sensitive-data-guard-tests) and the [audit, notification and reveal tests](#audit-notification-and-reveal-tests), none of this is in use yet. It's a plan for when tests are added, in priority order:

1. **Unit tests for pure computations**, with Vitest: money rounding, pay computation, DTR, leave and offset balances, 13th month, milestone split, SLA business-hours math, employee and document numbers, Holy Week dates.
2. **Service tests against a real MongoDB replica set**, for example `mongodb-memory-server` in replica-set mode: transactions, balanced journal entries, stock movements and derived on-hand, duplicate receipts, the approvals engine.
3. **Access-control tests**: a matrix of module (Engage, Ops, …) × access level (None, Read, Write, Owner) × action, run against `requireModuleAccess` and the [exceptions](../SECURITY.md#exceptions-to-module-access), plus record-level visibility (deal team, project team, project costs).
4. **End-to-end tests** with Playwright for the phone flows: timesheet, leave, delivery receipt signing, site report, service report.

Tests go next to the code they test (`*.test.ts`). Test data comes from the seed loaders plus small, named fixtures. Never use real employee data.

## Rates and law

Seeded rates and tables must be checked against official issuances before the first real payroll and before go-live. That duty is in [Keeping rates current](COMPLIANCE.md#keeping-rates-current), not here.
