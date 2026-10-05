# Testing

How changes are checked. The short version: **few automated tests** (see [ADR 0010](adr/0010-manual-verification-before-automated-tests.md)): only the [sensitive-data guard tests](#sensitive-data-guard-tests), the [audit, notification and reveal tests](#audit-notification-and-reveal-tests), the [Core administration tests](#core-administration-tests) and the [user account tests](#user-account-tests). Every build step is checked with typecheck, lint and a browser check, and every phase ends with a review and a hands-on phase check.

## What happens today

| Check | When | How |
|---|---|---|
| Typecheck and lint | After every build step | `pnpm typecheck` and `pnpm lint` must pass |
| Automated tests | After every build step | `pnpm test` must pass (see [Sensitive-data guard tests](#sensitive-data-guard-tests), [Audit, notification and reveal tests](#audit-notification-and-reveal-tests), [Core administration tests](#core-administration-tests) and [User account tests](#user-account-tests)) |
| Browser check | After every build step | Open the step's screens in light and dark appearance and at phone width (see [Checking a screen](DESIGN_SYSTEM.md#checking-a-screen)) |
| "Done when" | After every build step | Each step in the [build plan](BUILD_PLAN.md) ends with a concrete "Done when" line. That line is the step's acceptance test |
| Phase review | End of every phase | A review sub-agent checks the whole phase against the docs, using the [security review checklist](../SECURITY.md#review-checklist) |
| Phase check | End of every phase | The hands-on walkthrough listed under each phase in the build plan |
| Whole-app review | Build step 7.8 | Review sub-agents check every module in parallel |

Development aids: `/dev/ui` shows every token and component, and `/dev/health` checks MongoDB (with a transaction), Redis, the worker, storage and encryption. Both are development-only.

`pnpm test` runs the committed automated tests: the sensitive-data guard suite; from build step 1.3, the audit log, notification and sensitive reveal suites; from build step 1.4, the departments, positions, company settings, company details reminder, allowed email domains, upload settings and company logo route suites; and from build step 1.5, the employee number, reporting line, user, user account schema, employee model, session and temporary password suites.

## Sensitive-data guard tests

The guard that keeps sensitive fields encrypted was the first area with committed automated tests ([ADR 0012](adr/0012-fail-closed-sensitive-fields.md)). A missed write path stores plain text silently, so a hand check isn't enough. The only other tested areas are the [audit log, notifications and sensitive reveal](#audit-notification-and-reveal-tests), [Core administration](#core-administration-tests) and [user accounts](#user-account-tests). Other areas have no automated tests until this doc says so.

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

## Core administration tests

Added in build step 1.4. Departments, positions and company settings decide who holds the HR, Accounting and Board roles, who can sign in, and what every document prints, and their rules (retire safeguards, domain safeguards, the once-a-day reminder) are easy to break without anything showing on screen. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only).

- **Where.** Next to the code they test, as `*.test.ts`: in `packages/core/src/server/departments/`, `positions/`, `company-settings/`, `allowed-email-domains/` and `files/`, and `apps/web/app/company-logo/route.test.ts` for the logo route.
- **What they cover.**
  - **Departments and positions ([Managing departments and positions](modules/core.md#managing-departments-and-positions)).** Only HR and the System Administrator can add, edit, retire or restore; anyone else is refused and nothing changes. Each change writes exactly one audit entry of the right type and action in the same transaction (`delete` with `after` null for a retire, `restore` for a restore), and a failed audit write leaves the record unchanged. A department with live positions or active employees, and a position held by active employees, can't be retired; `HR`, `ACCT` and `BOD` follow the same rules as any other department. A department code is never reused, retired departments included, and can't be changed. A position can't be added to a retired department, and its department can't be changed. Position names are unique within a department ignoring case, retired positions included, and the unique index itself refuses `driver` next to `Driver`. Adding or restoring a position while the department is being retired in an overlapping transaction never leaves a live position in a retired department. The department head must be an employee whose account resolves to active.
  - **Company settings ([Company settings page](modules/core.md#company-settings-page)).** Only the System Administrator can change the details or the logo, each with its audit entry. The pending list includes every placeholder detail and the logo while `logoFileId` is null, and is empty once all are filled in. The logo accepts PNG, JPEG and WebP only. The `/company-logo` lookup serves only the file set as the logo.
  - **The company details reminder.** It notifies active HR users and System Administrators only, with the right link for each, sends nothing when no detail is pending, and a second run on the same Manila day sends nothing more.
  - **Allowed email domains.** Only the System Administrator can add or remove one. Re-adding a removed domain restores that record (audit `restore`). Removing the last remaining domain, or the acting System Administrator's own domain, is refused, also when two removals run at the same time. A removed domain no longer passes the sign-in domain check.
  - **Upload settings.** Only the System Administrator can change them. A change adds a version effective from today in Manila with its audit entry, in one transaction; a second change on the same Manila day is refused and changes nothing.

## User account tests

Added in build step 1.5. User accounts decide who can sign in, which number a person carries for life, and who approves their requests. A reused employee number, a reporting cycle, a session that outlives a reset or a temporary password in an audit entry all look fine on screen. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only).

- **Where.** Next to the code they test, as `*.test.ts` in `packages/core`: `employee-numbers.test.ts`, `reporting-lines.test.ts`, `users.test.ts`, `user-accounts.test.ts` (in `src/`), `employees/model.test.ts`, `session-user.test.ts` and `temporary-password.test.ts`.
- **What they cover.**
  - **Employee numbers (`employee-numbers.test.ts`, [Employee number](modules/core.md#employee-number-company-id)).** Generated numbers follow the per-year counter, and concurrent creates never share one. An aborted create leaves no gap. After 2027-99, generating another 2027 number fails with the "have run out" message and writes nothing. An entered number must match `YYYY-NN`, have the date hired's Manila year and be unused; it raises the counter, a lower free number is accepted without lowering it, and generation never fills gaps.
  - **Reporting lines (`reporting-lines.test.ts`, [Reporting lines](modules/core.md#reporting-lines)).** Empty is accepted. Self, more than 10, repeats, a missing supervisor, the system account and an inactive supervisor are refused. Direct and longer cycles are refused, also when two overlapping edits would only form one together.
  - **Users (`users.test.ts`, [Managing user accounts](modules/core.md#managing-user-accounts)).** Only HR and the System Administrator can create and edit; anyone else is refused and nothing changes. New users aren't System Administrators. HR can't change a System Administrator's email (a posted one is ignored, so a stale form doesn't refuse HR's other edits) or employment status, nobody edits their own row, and HR never sees the system account. Create writes the user, the employee and two `create` entries in one transaction, and a failed audit write leaves nothing. Email domain and duplicate checks, the date hired range and the within-year edit rule. A department or position retired at the same time never ends up with an active employee, and an email domain removed while a create or email change is in flight refuses it and writes nothing. Terminated is refused; the separation date rules; a reversal clears the date. A change that would leave no active System Administrator is refused, also when two System Administrators separate each other at once (exactly one succeeds), and a System Administrator separated before their own change runs is refused.
  - **User account schemas (`user-accounts.test.ts`, [Managing user accounts](modules/core.md#managing-user-accounts)).** The create, edit and status-change schemas: email and name normalizing, the date hired range (1990-01-01 to today + 365 days in Manila), the employee number modes, and the separation date rules.
  - **Employee model (`employees/model.test.ts`, [Account status](../SECURITY.md#account-status)).** `separationDate` defaults to null, is required for a separated status (Resigned, Terminated, Retired) and null otherwise, is on or after the date hired, and is 00:00 Manila on its day.
  - **Sessions (`session-user.test.ts`, [Account status](../SECURITY.md#account-status)).** A session that signed in before `sessionsValidFrom` is refused. A user set to Resigned as of today resolves as deactivated on the next request. Changing one's own password keeps other sessions.
  - **Temporary passwords (`temporary-password.test.ts`, [Sign-in and passwords](../SECURITY.md#sign-in-and-passwords)).** A generated password has 16 Crockford base32 characters in the `XXXX-XXXX-XXXX-XXXX` form, meets the password rule and never equals the email. A reset sets `mustChangePassword` and `sessionsValidFrom` and writes one `passwordReset` entry, and no entry holds the temporary password or a hash. Resetting one's own password is refused, and a System Administrator's password is reset only by a different System Administrator.

## Hand calculations

The riskiest code computes money, time and deadlines. Until automated tests exist, check these by hand against a worked example and keep the example in the step's notes:

- A payroll line for one Overtime-timesheet and one Standard-timesheet employee, from the seeded rates (build step 2.9)
- Billing milestones that sum exactly to the contract value, with the remainder on the last one (step 4.3)
- SLA due times across business hours, weekends and holidays (step 6.4)
- Holy Week dates from the Easter computation (step 1.10)

## When automated tests arrive (proposed)

Apart from the [sensitive-data guard tests](#sensitive-data-guard-tests), the [audit, notification and reveal tests](#audit-notification-and-reveal-tests), the [Core administration tests](#core-administration-tests) and the [user account tests](#user-account-tests), none of this is in use yet. It's a plan for when tests are added, in priority order:

1. **Unit tests for pure computations**, with Vitest: money rounding, pay computation, DTR, leave and offset balances, 13th month, milestone split, SLA business-hours math, employee and document numbers, Holy Week dates.
2. **Service tests against a real MongoDB replica set**, for example `mongodb-memory-server` in replica-set mode: transactions, balanced journal entries, stock movements and derived on-hand, duplicate receipts, the approvals engine.
3. **Access-control tests**: a matrix of module (Engage, Ops, …) × access level (None, Read, Write, Owner) × action, run against `requireModuleAccess` and the [exceptions](../SECURITY.md#exceptions-to-module-access), plus record-level visibility (deal team, project team, project costs).
4. **End-to-end tests** with Playwright for the phone flows: timesheet, leave, delivery receipt signing, site report, service report.

Tests go next to the code they test (`*.test.ts`). Test data comes from the seed loaders plus small, named fixtures. Never use real employee data.

## Rates and law

Seeded rates and tables must be checked against official issuances before the first real payroll and before go-live. That duty is in [Keeping rates current](COMPLIANCE.md#keeping-rates-current), not here.
