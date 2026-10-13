# Testing

How changes are checked. The short version: **few automated tests** (see [ADR 0010](adr/0010-manual-verification-before-automated-tests.md)): only the [sensitive-data guard tests](#sensitive-data-guard-tests), the [audit, notification and reveal tests](#audit-notification-and-reveal-tests), the [Core administration tests](#core-administration-tests), the [user account tests](#user-account-tests), the [module access tests](#module-access-tests), the [user access tests](#user-access-tests), the [master data tests](#master-data-tests), the [approvals tests](#approvals-tests), the [holiday calendar tests](#holiday-calendar-tests), the [directory, org chart and command bar tests](#directory-org-chart-and-command-bar-tests), the [employee record tests](#employee-record-tests), the [document, e-signature and certification tests](#document-e-signature-and-certification-tests) and the [payroll settings tests](#payroll-settings-tests). Every build step is checked with typecheck, lint and a browser check, and every phase ends with a review and a hands-on phase check.

## What happens today

| Check | When | How |
|---|---|---|
| Typecheck and lint | After every build step | `pnpm typecheck` and `pnpm lint` must pass |
| Automated tests | After every build step | `pnpm test` must pass (see [Sensitive-data guard tests](#sensitive-data-guard-tests), [Audit, notification and reveal tests](#audit-notification-and-reveal-tests), [Core administration tests](#core-administration-tests), [User account tests](#user-account-tests), [Module access tests](#module-access-tests), [User access tests](#user-access-tests), [Master data tests](#master-data-tests), [Approvals tests](#approvals-tests), [Holiday calendar tests](#holiday-calendar-tests), [Directory, org chart and command bar tests](#directory-org-chart-and-command-bar-tests), [Employee record tests](#employee-record-tests), [Document, e-signature and certification tests](#document-e-signature-and-certification-tests) and [Payroll settings tests](#payroll-settings-tests), [Timesheet and work schedule tests](#timesheet-and-work-schedule-tests)) |
| Browser check | After every build step | Open the step's screens in light and dark appearance and at phone width (see [Checking a screen](DESIGN_SYSTEM.md#checking-a-screen)) |
| "Done when" | After every build step | Each step in the [build plan](BUILD_PLAN.md) ends with a concrete "Done when" line. That line is the step's acceptance test |
| Phase review | End of every phase | A review sub-agent checks the whole phase against the docs, using the [security review checklist](../SECURITY.md#review-checklist) |
| Phase check | End of every phase | The hands-on walkthrough listed under each phase in the build plan |
| Whole-app review | Build step 7.8 | Review sub-agents check every module in parallel |

Development aids: `/dev/ui` shows every token and component, and `/dev/health` checks MongoDB (with a transaction), Redis, the worker, storage and encryption. Both are development-only.

`pnpm test` runs the committed automated tests: the sensitive-data guard suite; from build step 1.3, the audit log, notification and sensitive reveal suites; from build step 1.4, the departments, positions, company settings, company details reminder, allowed email domains, upload settings and company logo route suites; from build step 1.5, the employee number, reporting line, user, user account schema, employee model, session and temporary password suites; from build step 1.6, the module access level, effective access, file access and navigation suites; and from build step 1.7, the user access, access reminder, duplicate notification, access-change notification, system account disable and enable, and admin recovery suites; and from build step 1.8, the master data suites (clients, sites and contacts, products, catalog items, suppliers, the TIN and mobile helpers and the product seed loader); and from build step 1.9, the approvals suites (the decision schema and fixed sets, routing, the engine and its hooks, the development sample type and the Approvals navigation); and from build step 1.10, the holiday calendar suites (the Easter and rule dates, the auto-draft and the online source, holiday changes and visibility, the reminder, holidays-changed, the worker's Core job wiring and the Holidays navigation); and from build step 1.11, the directory, org chart and command bar suites (the directory allowlist and visibility, the org chart graph and layout, reporting line edits, the command bar registry and people provider, the Home team and oldest waiting approval, and the Directory and Org chart navigation); and from build step 2.1, the employee record suites (the Core identity service, the employee record and compensation models and services, section visibility, who may change what, the Talent reveals, the formats and the My record navigation); and from build step 2.2, the document, e-signature and certification suites (file view audit, the profile photo, the approval signer, the medical rule, 201 documents, e-signature pinning, certifications and their read services, skills, and the expiry alert job and its worker wiring); and from build step 2.3, the payroll settings suites (the seed loaders, the SSS, PhilHealth, Pag-IBIG and withholding lookups, cut-offs, the minimum wage check and warning, automatic and explicit allowances, adding a version, the wage order list and the Payroll settings navigation); from build step 2.4, the timesheet and work schedule suites (the hours computation with its hand-checked cases, cut-offs, work schedule assignments, the timesheet type snapshot and the opening job, time entries and the clock, who may see and change a timesheet, the Core supervisor identity reads, the new settings and the Timesheet navigation).

## Sensitive-data guard tests

The guard that keeps sensitive fields encrypted was the first area with committed automated tests ([ADR 0012](adr/0012-fail-closed-sensitive-fields.md)). A missed write path stores plain text silently, so a hand check isn't enough. The only other tested areas are the [audit log, notifications and sensitive reveal](#audit-notification-and-reveal-tests), [Core administration](#core-administration-tests), [user accounts](#user-account-tests), [module access](#module-access-tests), [user access](#user-access-tests), [master data](#master-data-tests), [approvals](#approvals-tests) and the [holiday calendar](#holiday-calendar-tests). Other areas have no automated tests until this doc says so.

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

## Module access tests

Added in build step 1.6. Module access decides what every user can open, and a wrong level, a System Administrator who resolves to None, or a file opened without a check all look fine to the person testing as an admin. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only). They partly move the proposed [access-control tests](#when-automated-tests-arrive-proposed) into what runs today: the level matrix, not yet each module's pages, actions and exceptions.

- **Where.** Next to the code they test, as `*.test.ts`: `packages/core/src/module-access.test.ts`, `packages/core/src/server/auth/module-access.test.ts`, `packages/core/src/server/files/access.test.ts` and `apps/web/lib/navigation.test.ts`.
- **What they cover.**
  - **Levels (`module-access.test.ts` in `src/`, [Rules](../SECURITY.md#rules)).** The level order None < Read < Write < Owner, the Insight limit (None or Read), a missing module reads as None, and the list of readable modules.
  - **Effective access (`server/auth/module-access.test.ts`, [Resolving and enforcing](../SECURITY.md#resolving-and-enforcing-build-step-16)).** The stored map comes through the session load (`loadSessionUser`), and an account with no field resolves to None everywhere. The System Administrator and the bootstrap system account resolve to Owner on every module and Read on Insight, whatever is stored. HR or Board members with nothing stored get None. The schema refuses `owner` on Insight and unknown levels. The full matrix of 7 modules × 4 stored levels × required levels. The admin area kinds (`hrOrSystemAdministrator`, `systemAdministrator`) for HR, the System Administrator and anyone else.
  - **File access (`server/files/access.test.ts`, [File storage](ARCHITECTURE.md#file-storage)).** An unregistered owner type is refused. The company logo (`core.companySettings`) opens for a signed-in user. `dev.sample` is refused in production. A refused file and a missing one get the same answer.
  - **Worker wiring (`apps/worker/src/core-jobs.test.ts`).** Each Core job has one handler, the holiday schedules are the documented crons on Asia/Manila time, and each handler calls its Core service.
  - **Navigation (`navigation.test.ts`, [Administration area](modules/core.md#administration-area)).** A new user sees only Home; Talent Read adds Talent; HR sees the four HR admin entries; the System Administrator sees all 7 modules and all 6 admin entries (five and seven from step 1.7, see [User access tests](#user-access-tests)); breadcrumbs use the longest matching entry.

## User access tests

Added in build step 1.7. The access setter decides who can open every module, and a save that lets HR edit their own row, skips an audit entry, or switches off the last System Administrator looks fine on screen. A reminder sent twice, or to the wrong people, is just as quiet. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only).

- **Where.** Next to the code they test, as `*.test.ts`: `packages/core/src/user-access.test.ts`, `packages/core/src/server/access/access.test.ts` and `packages/core/src/server/access/reminder-job.test.ts`, plus new cases in `notifications.test.ts`, `users.test.ts` and `apps/web/lib/navigation.test.ts`.
- **What they cover.**
  - **Schema and summaries (`user-access.test.ts` in `src/`, [User access page](modules/core.md#user-access-page)).** The save schema refuses Write or Owner on Insight and unknown levels. The access summary lists each module above None (`Talent R`) and reads "All modules R" when every module has the same level. Who needs access.
  - **Setting access (`server/access/access.test.ts`, [Resolving and enforcing](../SECURITY.md#resolving-and-enforcing-build-step-16)).** Only HR and System Administrators can save; anyone else is refused and nothing changes. Refused: one's own row, HR on a System Administrator's row, the bootstrap system account, an inactive user, a stale form, and an actor deactivated before the save runs. Each changed module writes exactly one `accessChange` entry holding both levels; a save that changes nothing writes none; a failed audit write leaves the access unchanged. `moduleAccessChangedAt` and `moduleAccessChangedBy` are set. Only a System Administrator can use the switch; once it is on, the user resolves to Owner (Read on Insight) through `loadSessionUser` while the stored levels stay; the last System Administrator can't be switched off, also when two System Administrators switch each other off at once (exactly one succeeds). The list pins Needs access newest first, and its filters and search (name and employee number) work; HR never sees the system account; the needs-access count matches the list.
  - **Access reminder (`server/access/reminder-job.test.ts`, [Background jobs](ARCHITECTURE.md#background-jobs)).** Only active HR users and System Administrators are notified, with the link `/admin/access`. Nothing is sent when nobody needs access. A second run on the same Manila day sends nothing more.
  - **Duplicate check (`notifications.test.ts`, [Notifications](modules/core.md#notifications)).** A recipient who already has a notification with the same `dedupeKey` is skipped, and the unique index holds when two sends overlap.
  - **Access-change notifications (`users.test.ts`, [Managing user accounts](modules/core.md#managing-user-accounts)).** Creating a user notifies the other active HR users and System Administrators, not the actor, in the create transaction, so a rolled-back create sends nothing. A position change notifies them; other edits don't. The user themselves is never notified, also when they are new to HR or an HR user whose position changed. Disabling and enabling the system account is System Administrator only, refused when it would leave no active System Administrator, and audit-logged.
  - **Admin recovery (`server/seed/recover-admin.test.ts`, [The only System Administrator is disabled](RUNBOOK.md#the-only-system-administrator-is-disabled)).** `pnpm recover:admin` is refused while any System Administrator is active, and with an empty password, and changes nothing then. Otherwise it re-enables the bootstrap system account with a new password hash, sets `mustChangePassword`, keeps or restores the System Administrator role, ends its old sessions and writes one `update` entry with no actor. The password and its hash are never returned, logged or put in the entry.
  - **Navigation (`navigation.test.ts`, [Administration area](modules/core.md#administration-area)).** HR sees five admin entries, User access included; the System Administrator sees all seven (eleven from step 1.8, see [Master data tests](#master-data-tests)); the breadcrumb reads "Administration › User access".

## Master data tests

Added in build step 1.8. Clients, products, catalog items and suppliers are shared by every later module, and their services check Engage and Supply access for callers that don't exist yet, so only a test exercises most of those checks. A second primary contact, a retired product with live items, a supplier name repeated in another case, or a change without its audit entry all look fine on screen. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only).

- **Where.** Next to the code they test, as `*.test.ts`: `packages/core/src/server/clients/` (`clients.test.ts`, `client-sites.test.ts`, `client-contacts.test.ts`), `brands/brands.test.ts`, `catalog-items/catalog-items.test.ts` and `suppliers/suppliers.test.ts`; the form schemas with the TIN and mobile helpers in `packages/core/src/master-data.test.ts`; the audit label helper in `packages/core/src/server/master-data-audit.test.ts`; the product loader in `packages/core/src/server/seed/brands-loader.test.ts`; plus new cases in `apps/web/lib/navigation.test.ts`.
- **What they cover.**
  - **Access ([Managing master data](modules/core.md#managing-master-data), [Rules](../SECURITY.md#rules)).** Each service against the level it needs: Engage Read, Write and Owner for clients, sites and contacts (Owner to retire or restore a client) and products (Owner to change them); Supply Read and Owner for suppliers and catalog items. A lower level is refused and changes nothing. A System Administrator passes everything, and HR with no module access is refused. The picker option lists work for any signed-in user and hold only the id and name of live records.
  - **Audit entries.** Every create, edit, retire, restore, removal and restoration writes exactly one entry of the right record type (`core.client`, `core.clientSite`, `core.clientContact`, `core.brand`, `core.catalogItem`, `core.supplier`), action and label, in the same transaction; a failed audit write leaves the record unchanged.
  - **Retire and restore.** A retire is a soft delete (`delete`, `after` null) and a restore brings the record back unchanged. A product with live catalog items can't be retired, also when an item is added at the same time. A retired record can't be edited or picked for a new record, and existing links to it are kept. No site or contact is added to or restored on a retired client, nor a catalog item under a retired product.
  - **Uniqueness.** Product names, supplier names, part numbers within a product and site names within a client are unique ignoring case, retired and removed records included, and the unique indexes themselves refuse a name that differs only in case. Client names and TINs aren't unique.
  - **Duplicate client names.** A name matching another client's ignoring case, retired ones included, is refused unless the request confirms it, and saved when it does.
  - **Primary contact.** Marking a contact primary clears the old one in the same transaction, two overlapping marks never leave two primaries, and removing the primary contact clears its flag.
  - **Field helpers.** TINs: dashes and spaces stripped, only 9, 12 or 14 digits accepted, and the display format. Mobiles: the lenient Philippine check accepts the `+63`, `63` and `0` forms with spaces, dashes and parentheses, and the value is stored as typed. Credit and payment terms, default warranty months and the owning Account Manager (an active employee, never the system account) follow their ranges and rules.
  - **Product seed loader.** An empty database gets the 13 products, each with its `seedKey`. A second run adds nothing, a product added by hand with a seeded name (in any case) counts as present, and a renamed seeded product isn't added again.
  - **Navigation (`navigation.test.ts`, [Administration area](modules/core.md#administration-area)).** The System Administrator sees the four master data entries; HR doesn't; the breadcrumbs read "Administration › Clients" and so on. From the sidebar sub-groups (2026-10-08, [Administration area](modules/core.md#administration-area)): every admin entry but Overview has a group, the entries of a group sit together in group order, Overview stays outside the groups, HR gets only People and organization (its four entries), the System Administrator gets all three groups in order with their entries, and a viewer with no admin entries gets no groups.

## Approvals tests

Added in build step 1.9. Every module's approvals run through one engine, and no module sends requests yet, so only a test exercises most of it. A request routed back to its own requester, two approvers settling one step, a decision whose hook failed but still counted, or a second pending request for one record all look fine on screen. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only).

- **Where.** Next to the code they test, as `*.test.ts`: `packages/core/src/approvals.test.ts`, `packages/core/src/server/approvals/routing.test.ts`, `packages/core/src/server/approvals/approvals.test.ts` and `packages/core/src/server/approvals/dev-sample.test.ts`, plus new cases in `apps/web/lib/navigation.test.ts`.
- **What they cover.**
  - **Schema and fixed sets (`approvals.test.ts` in `src/`, [Approvals](modules/core.md#approvals)).** The decision schema needs remarks for a return or rejection and refuses remarks over 1,000 characters. `APPROVAL_STATUSES`, `APPROVAL_STEP_KINDS` and `APPROVAL_DECISIONS` hold the specified values.
  - **Routing (`server/approvals/routing.test.ts`).** A `reportingTo` step reaches every active supervisor and leaves out inactive and separated ones. The requester is removed from every set. A step whose only approver was the requester goes to every active System Administrator as an any-one step, flagged as routed, never to the requester; in an all-of step the requester's place is filled by any one System Administrator. With no other System Administrator active, the submit is refused. An empty step follows the type's `whenEmpty` rule (skip, HR or System Administrator), and is refused without one. Approvers stay fixed when `reportingTo` changes after submit.
  - **The engine (`server/approvals/approvals.test.ts`).** Any-one: the first decision settles the step, and the other approvers are notified and lose the item. Two overlapping decisions: exactly one wins, and a stale form is refused. All-of: each approver must approve, in any order, and one return or rejection ends the request. Several steps: an approved step makes the next one pending and notifies its approvers. Remarks: a return or rejection without them is refused, and a decision a type doesn't allow is refused. Refusals: anyone but a named approver of the pending step can't decide, someone who may not read a request gets the same answer as for a missing one, and an unregistered type can't be submitted. Hooks: they run in the decision's transaction, and a hook that throws rolls back the decision, its audit entry and its notifications; a submit rolls back with the module's own transaction. Audit: a `create` entry on submit and one `update` entry per decision on `core.approvalRequest`, with the remarks as the reason. One pending request per record, also when two submits overlap; a resubmission after a return links to the old request and starts again from the first step. The registry, `isApproverFor` (current and past approvers, while pending and afterwards, and refusing a malformed record type), the outcome going to the requester or the type's `outcomeRecipients`, and the lists: who sees a request (its approvers, its requester, a System Administrator), the waiting count, and Decided (a request shows there as soon as the user's part in a step ends, also when another approver settled an any-one step or another System Administrator filled an all-of place while a later step is pending, or the approvers still pending when an all-of step is returned; newest first by the user's latest part, listed once, unchanged by another approver's later decision, with ties on the same time broken by id across pages).
  - **Development sample (`server/approvals/dev-sample.test.ts`).** `dev.sample` is registered only outside production, and the script's step options (`supervisors`, `board`, `all:<emails>`, `self`) build the right steps; it refuses to run in production.
  - **Navigation (`navigation.test.ts`, [Approvals list](modules/core.md#approvals-list)).** Approvals sits after Home for every signed-in user, its breadcrumb reads "Pulse Core › Approvals", and its badge uses the waiting count.

## Holiday calendar tests

Added in build step 1.10. Holidays decide which days are paid as holidays from Phase 2, and a wrong Easter date, a draft shown to everyone, an auto-draft that brings back a holiday HR deleted, or a reminder sent twice all look fine on screen. The Holy Week dates move from [Hand calculations](#hand-calculations) into these tests. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only). The build places the files next to the code they test and updates the "Where" line, as earlier steps did.

- **Where.** Next to the code they test, as `*.test.ts`: the date rules and form schemas in `packages/core/src/holidays.test.ts`; in `packages/core/src/server/holidays/`, `holidays.test.ts` (the holiday services, visibility, audit entries and holidays-changed), `auto-draft.test.ts` (the auto-draft and the online source), `holiday-rules.test.ts` (the rules seed loader) and `reminder.test.ts`; the worker's Core job wiring in `apps/worker/src/core-jobs.test.ts`; plus new cases in `apps/web/lib/navigation.test.ts`.
- **What they cover.**
  - **Easter and the rule dates ([Holiday calendar](modules/core.md#holiday-calendar)).** The anonymous Gregorian algorithm gives Easter Sunday 2026-04-05, 2027-03-28 and 2028-04-16, so Maundy Thursday, Good Friday and Black Saturday fall on 2026-04-02, 04-03 and 04-04; 2027-03-25, 03-26 and 03-27; and 2028-04-13, 04-14 and 04-15. National Heroes Day, the last Monday of August, falls on 2026-08-31, 2027-08-30 and 2028-08-28. Fixed rules give their month and day. Every date is the Manila day at 00:00 stored as UTC.
  - **Rules setting.** The `core.holidayRules` schema accepts the three kinds and refuses an unknown kind or an impossible date. The seed loader adds the first version, effective from the seed day, only when the setting has none, and a second run changes nothing. A run uses the version in effect on the day it runs.
  - **The auto-draft.** A run for a year adds one draft per rule with `sourceKey` `rule:<key>`, source `rule`, the rule's default type, nationwide scope and no legal basis, and returns the counts. A second run adds nothing. A deleted auto-draft, or one moved to another date, isn't drafted again. A rule whose date already has a live holiday added by hand is skipped, but two rules on the same date (Black Saturday and Araw ng Kagitingan, April 9, 2039) are both drafted. After the scheduled run, someone who isn't HR or a System Administrator sees none of the drafts, then only the one confirmed (the step's "Done when", in `auto-draft.test.ts`). Two overlapping runs never make the same draft twice (the partial unique index holds). Only HR and System Administrators can run it by hand, for the current or next year only. A scheduled run writes its `create` entries with no actor, a run by hand with that person.
  - **The online source.** Off when `HOLIDAY_SOURCE_URL` is empty. With a stubbed feed (never the real internet), each date with no holiday, deleted ones included, becomes a special non-working day draft with `sourceKey` `online:<YYYY-MM-DD>`; a date that already has a holiday, under any name, is skipped; nothing is confirmed. A failing or malformed feed is logged and the rule-based drafts are still made.
  - **Holiday changes.** Only HR and System Administrators can add, edit, confirm, declare and delete; anyone else is refused and nothing changes. Adding creates a draft. Confirming without a legal basis is refused; Confirm all is refused while any draft lacks one, lists those drafts and confirms nothing. Location is required for a local holiday and empty otherwise. The same name on the same date, ignoring case, is refused among live holidays, a deleted one doesn't block it, and a different name on the same date is accepted. Deleting is a soft delete. `source` and `sourceKey` can't be changed. A date can be moved within its year; a move to another year is refused and changes nothing.
  - **Declaring.** A declaration needs a legal basis, creates a confirmed holiday with `declared` true, and notifies every active user except the person declaring it, never the bootstrap system account, in the same transaction, so a failed save notifies no one. Confirm and Confirm all notify nobody.
  - **Visibility.** Someone who isn't HR or a System Administrator gets confirmed holidays only from the service; HR and System Administrators get drafts too.
  - **Audit entries.** Each add, declaration, auto-drafted holiday, edit, confirm and delete writes exactly one entry on `core.holiday` with the right action and the label `<name> · <YYYY-MM-DD>`, in the same transaction; a failed audit write leaves the holiday unchanged.
  - **The reminder.** In December (on the 1st, 8th, 15th, 22nd and 29th) it notifies active HR users and System Administrators only while next year has no confirmed holiday, and in January and February it checks the current year. Nothing is sent once the year has a confirmed holiday. A second run on the same Manila day sends nothing more.
  - **Holidays changed.** Confirm, Confirm all, declare, and editing or deleting a confirmed holiday enqueue `core.holidaysChanged` once, after the commit, with the affected dates (both dates for a move, every confirmed date for Confirm all); changes to drafts and a rolled-back change enqueue nothing. The job runs every registered listener, and with none registered does nothing.
  - **Navigation (`navigation.test.ts`, [Holiday calendar](modules/core.md#holiday-calendar)).** Holidays sits after Approvals for every signed-in user, and its breadcrumb reads "Pulse Core › Holidays".

## Directory, org chart and command bar tests

Added in build step 1.11. The directory is open to everyone, so a field that slips into its results, a separated person shown to the wrong user, a command bar provider called for someone without access, or a second line drawn as a second card all look fine on screen. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only). The build places the files next to the code they test (the directory and org chart services, the reporting-lines service, the command bar registry, the approvals service and the org chart layout), adds new cases to `apps/web/lib/navigation.test.ts`, and adds a "Where" line here, as earlier steps did.

- **Where.** Next to the code they test, as `*.test.ts`: in `packages/core/src/server/`, `directory/directory.test.ts` (the directory allowlist and visibility, the org chart graph, the Home team and the inspector's supervisor search), `employees/set-reporting-lines.test.ts` (reporting line edits), `command-bar/registry.test.ts` (the registry and the people provider) and new cases in `approvals/approvals.test.ts` (the oldest waiting approval); in `apps/web/lib/`, `org-chart-layout.test.ts` (the layout) and `home.test.ts` (the Home greeting, the Manila days behind "Oldest submitted N days ago" and the upcoming holidays window); plus new cases in `apps/web/lib/navigation.test.ts`. The `/admin/users` reporting line edits stay covered by the user tests of step 1.5.
- **What they cover.**
  - **The directory allowlist ([Company directory](modules/core.md#company-directory), [Sensitive data](../SECURITY.md#sensitive-data)).** Every directory, card, people search and Home team result has exactly the allowed keys (name, initials, employee number, department, position, email, reporting lines, direct reports, and the "Inactive" flag for HR and System Administrators), never the date hired, employment status, separation date, module access or a password hash.
  - **Directory visibility.** Active people only. `?separated=1` shows separated people to HR and System Administrators and is ignored for anyone else, Board members included; a separated person's card answers like a missing one for anyone else. The bootstrap system account never appears. Search on name, employee number and email, the department filter and the sort by last name. An inactive supervisor shows on a card only to HR, Board members and System Administrators.
  - **The org chart ([Org chart](modules/core.md#org-chart)).** An employee with two supervisors is one node with two lines (the step's "Done when"). Separated employees aren't shown, and a line to a separated supervisor isn't drawn (the person moves to the top level when none is left). The department filter keeps that department's members and the lines among them, with "Reports to" names for supervisors outside it.
  - **The layout.** Each person is placed once, below every shown supervisor, by the longest chain above them; the order is stable; a cycle in bad input still finishes.
  - **Reporting line edits ([Reporting lines](modules/core.md#reporting-lines)).** HR, Board members and System Administrators can save; anyone else is refused and nothing changes. Their own lines, the system account and a separated employee are refused. A stale form is refused. The checks of step 1.5 still apply (a cycle, an inactive new supervisor), and an edit that only removes keeps an inactive line. One `update` entry on `core.employee` in the same transaction; a save that changes nothing writes nothing; no notification is sent. `/admin/users` edits still behave as before.
  - **The command bar registry ([Command bar](modules/core.md#command-bar)).** A provider whose `isVisibleTo` refuses the user is never called. A second registration of a key throws in production. A provider that throws is left out and the log holds its key only, never the query. A result whose link isn't a path inside the app is dropped. A query under 2 characters returns nothing, and each provider returns at most 8 results.
  - **The people provider.** It finds a person by name and by employee number (for example `2027-01`), returns the name, number and position with a `/directory?person=` link, and never returns separated people or the system account.
  - **Home ([Home](modules/core.md#home)).** The team tile's service returns the user's active supervisors and active direct reports only, and nothing for the system account; the oldest waiting approval helper returns the oldest submit date among the requests waiting for the user, and none when nothing waits. The greeting follows the Manila hour (changing at 12:00 and 18:00) with no name for the system account, "Oldest submitted N days ago" counts Manila calendar days, and the holidays window runs from today through 60 days ahead.
  - **Navigation (`navigation.test.ts`).** Directory and Org chart sit after Holidays for every signed-in user, with the breadcrumbs "Pulse Core › Directory" and "Pulse Core › Org chart".

## Employee record tests

Added in build step 2.1. A record's sensitive data looks the same on screen whether it reached the browser masked or not at all, so these tests check what the server sends. A Talent Write user given a last 4, HR changing a colleague's pay, a salary entry edited in place, or a reveal returned without its audit entry would all go unseen in a browser check. They use the framework, database setup and rules of the guard tests above (Vitest, a throwaway `mongodb-memory-server` replica set, one database per file, made-up data only, never a real ID or account number).

- **Where.** Next to the code they test, as `*.test.ts`:
  - `packages/core/src/server/employees/identity.test.ts`: the identity service
  - `packages/talent/src/validation.test.ts`: the formats and form schemas
  - In `packages/talent/src/server/`: `employee-records/employee-records.test.ts` (the record, its sections and edits), `compensation/compensation.test.ts`, and `sensitive/reveal.test.ts` (the Talent reveals)
  - New cases in `apps/web/lib/navigation.test.ts`
- **What they cover.**
  - **The identity service ([People data ownership](modules/core.md#people-data-ownership)).**
    - Talent Read gets identities; someone with Talent None gets only their own; anyone else is refused.
    - Separated employees appear only when asked, with Talent Read. The system account never appears.
    - The result has exactly the listed keys.
  - **Storage ([The employee record](modules/talent.md#the-employee-record-build-step-21)).**
    - The TIN, SSS, PhilHealth, Pag-IBIG, account number and salary are stored as binary subtype 6, and a plain value is refused by the model and by the collection's validator.
    - The first save creates one record; two first saves at once leave one.
    - A stale `version` is refused and changes nothing.
    - Every write that could delete or replace a record is refused: `deleteOne`, `deleteMany`, `findOneAndDelete`, `replaceOne`, `findOneAndReplace`, `updateMany`, a `bulkWrite` with anything but inserts, `$out`, and `save()` or `deleteOne()` on a loaded record.
    - An empty ID or account number keeps the stored one, and a given one replaces it. The first bank account save needs an account number.
  - **Compensation.**
    - Entries are insert-only. These are refused: `updateOne`, `updateMany`, `findOneAndUpdate`, `findByIdAndUpdate`, `replaceOne`, `findOneAndReplace`, `deleteOne`, `deleteMany`, `findOneAndDelete`, a `bulkWrite` with anything but inserts, `$merge`, and `save()` or `deleteOne()` on a loaded entry.
    - The current entry is the latest effective date on or before today in Manila. A same-date correction wins and marks the old one superseded. A future entry is scheduled, not current.
    - Centavos round-trip exactly.
    - An effective date before the date hired or more than a year ahead is refused.
  - **Section visibility (the step's "Done when").**
    - The record view for a Talent Write (and Owner) user with no role has no Compensation, Government IDs or Bank account section, no date of birth or civil status, and none of the values' last 4 digits anywhere in the serialized result.
    - HR's view has the TIN's last 4.
    - Accounting's view matches HR's.
    - A Board member's view has the three sections for an HR-department employee only, without the date of birth or civil status.
    - The employee's own view (`/talent/me`) has everything.
    - The salary is masked with no digits.
    - The record and the list are refused without Talent Read, and the system account has no own view.
    - The list has exactly the listed keys, with no sensitive field, date of birth or civil status.
    - A salary entry alone counts as "filled in" only for viewers who may see Compensation (HR and Accounting). It never does for a Talent Write or Read user, or for a Board member outside HR.
    - Manage access and Edit in Users are offered to HR and the System Administrator only.
  - **Who may change what ([Sensitive data](../SECURITY.md#sensitive-data)).**
    - HR and the System Administrator, with Talent Write, change IDs, bank and compensation for a non-HR employee.
    - HR is refused for an HR-department employee, where the System Administrator and a Board member with Talent Write succeed.
    - A Board member is refused for anyone outside HR.
    - Accounting is always refused.
    - A Talent Write user with no role changes personal and employment fields, but is refused for the sensitive sections and for the date of birth and civil status.
    - Nobody changes their own record.
    - A refused change writes nothing.
    - The employee's department is read again on save: after a move into HR, HR is refused.
    - The actor is read again inside the transaction. A session that still says Talent Write or HR is refused once the stored access is lowered or the actor has moved out of HR.
  - **Audit.**
    - One `create` entry on the first save and one `update` per later save, on `talent.employeeRecord` with the employee label, in the same transaction.
    - Changed sensitive values show as hidden and changed.
    - One `create` per compensation entry.
    - The raw audit JSON never holds a plaintext value or its last 4.
    - When the audit entry can't be written, the save writes nothing.
  - **The Talent reveals.**
    - HR reveals a TIN, and one `reveal` entry with module `talent` and `fields: ["tin"]` is written before the value returns.
    - A Talent Write user with no role is refused and nothing is written.
    - The Board on an HR-department record versus another.
    - The employee on their own record.
    - An unregistered field is refused.
  - **Formats.** Each ID's accepted digit counts and display format, digits-only storage with leading zeros kept, and peso input to centavos without floating point.
  - **Navigation (`navigation.test.ts`).**
    - My record shows in the Pulse Core group for a user with an employee record, never for the system account, with the breadcrumb "Pulse Core › My record".
    - The Talent item isn't current on `/talent/me`.

## Document, e-signature and certification tests

Added in build step 2.2 ([Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22), decisions 173–190). As in step 2.1, the tests check what the server sends and stores, not only what a screen shows.

- **Where.** Next to the code they test, as `*.test.ts`:
  - In `packages/core/src/server/`:
    - `files/access.test.ts`: new cases for `auditView` and `openAccessibleFile`
    - `employees/photo.test.ts`: the profile photo
    - `files/image-transform.test.ts`: the `sharp` re-encoding of photos and signatures
    - `employees/notification-contacts.test.ts`: the job-only recipient helpers
    - `approvals/approvals.test.ts`: new cases for the signer
    - `sensitive/reveal.test.ts`: the medical rule
    - the directory and identity tests: `photoUrl` in the allowlist
  - In `packages/talent/src/server/`: `documents/documents.test.ts`, `e-signatures/e-signatures.test.ts`, `certifications/certifications.test.ts` (certifications, skills and the expiry setting) and `expiry-alerts/expiry-alerts.test.ts`.
  - `apps/worker/src/talent-jobs.test.ts`
- **What they cover.**
  - **File views.**
    - A registration with `auditView` writes one `reveal` entry with `fields: ["file"]` before any content is read.
    - When the entry can't be written, the file isn't opened.
    - A registration without it writes nothing.
    - A refused file and a missing one still get the same answer.
  - **Profile photo.**
    - The employee, HR and the System Administrator set and remove it. Anyone else is refused, and so is the system account.
    - Each change is one `update` entry on `core.employee`.
    - Only the current photo opens, for any signed-in active user.
    - The stored image has no EXIF or GPS metadata.
    - The directory and identity results carry `photoUrl` and still have exactly the listed keys.
  - **The approval signer.**
    - Only an approve calls the signer; return and reject don't.
    - The stamp is stored on the decision and passed to the hooks.
    - With no signer registered, an approve is refused.
    - A signer that throws rolls back the decision, its audit entry and its notifications.
    - With no signature on file, the decision stores `signature: null`.
  - **The medical rule.** Accounting is refused `medical` and keeps every other category. HR, the System Administrator and the employee pass.
  - **201 documents.**
    - **Who sees what.** HR and the System Administrator with Talent Read see every document. Accounting sees all but medical certificates. The employee sees their own. A Talent Write user with no role, and a Board member, get no document and no document data anywhere in the serialized view. The same answers hold at the file route.
    - **Who changes them.** Adding, editing and archiving need Talent Write and HR or the System Administrator, never on one's own record. HR may manage another HR employee's documents.
    - **Never deleted.** Deletes and replacements are refused. Archiving keeps the document and needs a reason. A stale `version` is refused. Archiving the replaced document happens in the same save.
    - **Audit.** Each change writes its audit entry in the same transaction, and nothing is written when the entry fails.
  - **E-signature (the step's "Done when").**
    - Only the owner uploads, and versions go 1, 2, 3.
    - Approving with version 1, replacing it with version 2, then approving another request: the first decision and its `signatureApplications` row still name version 1 and its file, and the second names version 2.
    - Signatures and applications refuse every update and delete.
    - The image opens only for the owner and the System Administrator.
    - Each upload and each use writes its audit entry. A request whose label is as long as allowed still signs: the audit label is shortened to the limit.
  - **Certifications and skills.**
    - Talent Write adds and edits, never on one's own record; removing needs Talent Owner. A name as long as allowed still saves, with its audit label shortened.
    - `listCertifications` and `countCertifiedEmployeesByBrand` need Talent, Engage or Ops Read. Their results have exactly the listed keys, never the license number or the attachment, and leave out separated employees.
    - Skills refuse more than 30 tags, tags over 50 characters, and duplicates ignoring case.
  - **The expiry job (the step's "Done when").**
    - An expiring 201 document alerts HR and the employee. An expiring certification also alerts the employee's supervisors.
    - The lead days come from `talent.expiryAlerts`, 30 by default.
    - The expired alert is sent once on or after the expiry date.
    - A rerun sends nothing twice, and a changed expiry date alerts again.
    - Archived documents, removed certifications and separated employees are skipped.
    - With no active HR user, the System Administrators get the HR alerts.
    - The worker registers the schedule `0 8 * * *` and wires the handler.

## Payroll settings tests

Added in build step 2.3 ([Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23), decisions 191–212). The figures below are worked by hand from the seeded rates in [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23). If HR replaces a seeded table, the tests keep testing the seed data, not the database.

- **Where.** Next to the code they test, as `*.test.ts`, in `packages/talent/src/` (the pure schemas and lookups) and `packages/talent/src/server/` (`payroll-settings/`, `allowances/`, `minimum-wage/`, `compensation/`), plus `apps/web/lib/navigation.test.ts`.
- **A fixed "today".** The payroll settings, allowance and minimum wage service tests fake only `Date`, at 2026-10-12 10:00 Manila (after NCR-28 took effect), and move it where a test needs another day (2026-09-01 for ₱695, 2026-11-03 for the date hired). A version's status, "upcoming", the badge and the wage order list mean the same thing whenever the tests run.
- **Seeding.**
  - Each of the ten loaders adds its seeded versions once; a second run adds nothing.
  - A setting that already has a version is left alone.
  - Every seeded value passes its schema and has no fractional number.
  - Every seeded version has a source.
- **SSS** (`sssRowFor`, monthly compensation → MSC, employee, employer, EC). The generated table has 61 rows.

  | Compensation | MSC | Employee | Employer | EC |
  |---|---|---|---|---|
  | ₱4,000.00 | ₱5,000 | ₱250 | ₱500 | ₱10 |
  | ₱14,749.99 | ₱14,500 | ₱725 | ₱1,450 | ₱10 |
  | ₱14,750.00 | ₱15,000 | ₱750 | ₱1,500 | ₱30 |
  | ₱20,000.00 | ₱20,000 (MPF 0) | ₱1,000 | ₱2,000 | ₱30 |
  | ₱25,000.00 | ₱20,000 + MPF ₱5,000 | ₱1,250 (₱1,000 + ₱250) | ₱2,500 (₱2,000 + ₱500) | ₱30 |
  | ₱50,000.00 | ₱20,000 + MPF ₱15,000 | ₱1,750 | ₱3,500 | ₱30 |

- **PhilHealth** (5%, half each; the premium is rounded half-up once, the employee's half is rounded half-up and the employer takes the remainder, so the two add up to the premium):
  - ₱8,000 → floor ₱10,000 → premium ₱500, employee ₱250.
  - ₱25,000 → ₱1,250, employee ₱625.
  - ₱150,000 → ceiling ₱100,000 → ₱5,000, employee ₱2,500.
- **Pag-IBIG:**
  - ₱1,500 → employee ₱15, employer ₱30.
  - ₱8,000 → ₱160 and ₱160.
  - ₱30,000 → capped at ₱10,000 → ₱200 and ₱200.
- **BIR semi-monthly** (`semiMonthlyWithholding`):
  - ₱10,417.00 → ₱0.00.
  - ₱12,000.00 → ₱237.45 (15% of ₱1,583).
  - ₱20,000.00 → ₱1,604.10 (₱937.50 + 20% of ₱3,333).
  - ₱50,000.00 → ₱8,437.45 (₱4,270.70 + 25% of ₱16,667).
  - The seeded brackets are continuous: each base tax equals the previous base plus its rate times the width.
- **De minimis.** The overtime meal limit is 30% of the regional minimum wage: ₱226.50 a day at ₱755.
- **Cut-offs** (`cutOffFor`, seeded schedule):
  - 2026-02-11 to 2026-02-25 pays on 2026-02-28.
  - 2026-01-26 to 2026-02-10 pays on 2026-02-15.
  - The end-of-month cut-off in February 2028 pays on the 29th.
  - A split that doesn't total exactly 1, overlapping cut-offs, and a `payrollSettings` version not starting on a cut-off start day are refused.
- **Minimum wage** (NCR, factor 261). The exact comparison is monthly × 12 < minimum × 261.
  - At ₱755 (from 2026-09-26):
    - Monthly ₱16,421.24 is below (1,642,124 × 12 = 19,705,488 < 75,500 × 261 = 19,705,500).
    - ₱16,421.25 isn't (equal).
    - Daily ₱754.99 is below; ₱755.00 isn't.
    - Monthly ₱16,000.00 shows the daily rate ₱735.63.
    - The warning rounds the daily rate down: ₱16,421.24 a month (₱754.9995… a day) shows ₱754.99, never ₱755.00.
  - At ₱695 (a "today" before 2026-09-26): ₱15,116.24 is below and ₱15,116.25 isn't.
  - **The "Done when", in the service.** A salary below the minimum without the confirmation saves nothing and returns the warning. With "Save anyway" it saves with `minimumWageWarningConfirmed`. A region with no rate saves with the note.
  - The check uses the later of the effective date and today.
  - The badge appears only for a current salary below today's minimum, and only in the Compensation section.
- **Allowances.**
  - **The "Done when".** A new employee hired 2026-11-03 has no allowance on 2026-11-02 and the internet allowance (₱500 per cut-off, automatic) from 2026-11-03. On 2026-10-12 the record shows it as upcoming ("Starts"); from 2026-11-03 it no longer is.
  - Correcting the date hired in Core moves the start.
  - An `end` entry stops the allowance, and a `set` entry changes its amount.
  - A new `talent.allowanceTypes` default applies from its version's date.
  - A tie on the same date goes to the newest entry.
  - Assigned amounts are stored encrypted and revealed only through the audit-logged reveal (`talent.allowanceAssignment`, `amount`).
  - Who assigns:
    - HR assigns.
    - Talent Write alone, Accounting and anyone on their own record are refused.
    - HR is refused for HR staff, and a Board member or the System Administrator is allowed.
  - The allowances part is sent only to a viewer who may reveal `allowances`.
- **The view.** On 2026-10-12 NCR-28 is in effect and NCR-26 superseded; on 2026-09-01 NCR-28 is scheduled and NCR-26 in effect. "Add version" accepts dates from the day after the latest version to one year ahead (2027-10-12).
- **Adding a version.**
  - Talent Owner without HR or the System Administrator is refused, and so is HR without Talent Owner.
  - A date on or before the latest version, or more than a year ahead, is refused. A same-day collision is refused.
  - Removing an allowance type key is refused.
  - The `create` entry on `core.configVersion` is written in the same transaction.
- **The wage order list** counts and lists the active employees below a version in its region, shows no amounts, and is refused without Talent Read or for a viewer outside HR, Accounting and the System Administrator.
- **Navigation.** `/talent/payroll-settings` keeps the Talent item current, with the breadcrumb "Pulse Talent › Payroll settings".

## Timesheet and work schedule tests

Added in build step 2.4 ([Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24), decisions 213–234). The hours are worked by hand from the seeded schedule (08:00–17:00, break 12:00–13:00), `hoursPerDay` 8, the night window 22:00–06:00 and `offsetRatio` 1.

- **Where.** Next to the code they test: `packages/talent/src/timesheets/` (the pure schedule and hours computation), `packages/talent/src/server/` (`work-schedules/`, `timesheets/`, `payroll-settings/` for the two new settings), `packages/core/src/server/employees/identity.test.ts` (the supervisor reads), `apps/web/lib/navigation.test.ts` and `apps/worker/src/talent-jobs.test.ts`.
- **A fixed "today".** The service tests fake only `Date`, at 2026-09-14 10:00 Manila unless a test needs another day, so "no later than today" and the clock are deterministic.
- **The hours computation.** All 14 cases in [the hand-checked cases](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24), each as its own test, among them:
  - Case 1: Friday 2026-09-11, 08:00–19:00 marked, Overtime: worked 10.0 h, ordinary day 2.0 h, night differential 0. Unmarked (case 2): not claimed 2.0 h.
  - Case 5: a Driver, ordinary day 08:00–23:30 marked: worked 14.5 h, ordinary day 6.5 h, night differential 1.5 h.
  - Case 7: Monday 2026-11-30 (confirmed regular holiday), 08:00–19:00 marked: holiday 10.0 h, 8.0 h + 2.0 h beyond 8. As a draft or a local holiday (case 8): ordinary day 2.0 h.
  - Case 10: Standard, Monday 2026-09-14, 07:55 (manual) to 19:30 marked: worked 635 min, offset 155 min (2.6 h); with `offsetRatio` "1.5", 233 min (3.9 h).

  Also: an open entry counts nothing; totals are added in minutes before rounding (three days of 20 minutes show 1.0 h, not 0.9 h); the night window wraps past midnight on both sides of a day; the treatment comes from `talent.timesheetSettings`, so swapping `extraHours.standard` to `overtime` in a test version shows overtime by kind.
- **Cut-offs.** Case 14, plus a `payrollSettings` version taking effect inside a period ends that period the day before.
- **Work schedules.**
  - The schedule for a day: the latest assignment on or before it (a tie goes to the newest), a `null` assignment returns to the company default, and the default's own versions apply by day.
  - Schedule checks: no work days, a break outside the span and scheduled minutes under 60 are refused; an end before the start is an overnight schedule.
  - Who sets one: HR with Talent Write sets one; Talent Write alone, HR without Talent Write and anyone on their own record are refused. Assignments are insert-only (`guardWrites`), and the `create` audit entry is in the same transaction.
- **Timesheets.**
  - The job creates one timesheet per active employee for today's cut-off and nothing on a second run; a separated employee gets none.
  - The type snapshot: changing a position's type after its timesheet exists leaves that timesheet's type unchanged, and the next cut-off's timesheet takes the new type. A timesheet first created on use records `typeReadOn` as that day.
- **Time entries.**
  - Time in stores the server's time with the source `clock`; a second Time in while one is open is refused; Time out without an activity is refused until one is given.
  - Editing a clocked time sets that side to `manual`; a browser can't save a time as `clock`.
  - Refused: a time out before the time in, more than 24 hours, a future time, a date before the date hired or after the separation date, an overlap with another entry (on the same or the previous day), a stale `version`, and an activity over 500 characters.
  - Overlaps are compared in whole minutes: a typed entry may start in the minute a clocked one ended (17:00:42 and 17:00 touch).
  - Two overlapping saves at once: exactly one saves, three times running (the timesheet touch serializes them). The timesheets' write guard allows the touch and refuses any other update.
  - Delete is soft; each create, update and delete writes its audit entry in the same transaction.
- **Who sees and changes a timesheet.**
  - The employee clocks and edits their own; the self-service services take no employee id.
  - Talent Read and a `reportingTo` supervisor (with no module access) open it read-only; a supervisor's view carries no date hired or employment status.
  - Refused: another employee without Talent Read who isn't a supervisor, and any change to another person's entries, HR and the System Administrator included.
- **Core supervisor reads.** `getEmployeeIdentity` returns an active team member to their supervisor and refuses a non-supervisor without Talent Read; a separated team member needs Talent Read. `listDirectReportIdentities` lists only active direct reports, and none for the bootstrap system account.
- **Settings.** `talent.workSchedule` and `talent.timesheetSettings` are seeded once with the values in [DATA_MODEL.md](DATA_MODEL.md#versioned-configuration), and adding a version follows the step 2.3 rules.
- **Navigation.** "Timesheet" is listed for users with an employee only, in the Pulse Core group after My record; the Talent item isn't current on `/talent/timesheet`, and `/talent/timesheets/<id>` keeps Talent current with the breadcrumb "Pulse Talent › Timesheet".
- **Worker.** `talent.openTimesheets` is registered once with cron `5 0 * * *` and calls Talent's service.

## Hand calculations

The riskiest code computes money, time and deadlines. Until automated tests exist, check these by hand against a worked example and keep the example in the step's notes:

- Timesheet hours (build step 2.4), automated in the [timesheet and work schedule tests](#timesheet-and-work-schedule-tests) and checked again on a phone: case 1 (08:00–19:00 on an ordinary day, ordinary day 2.0 h), case 5 (a Driver 08:00–23:30, ordinary day 6.5 h and night differential 1.5 h), case 7 (08:00–19:00 on a regular holiday, holiday 8.0 h + 2.0 h beyond 8) and case 10 (Standard, 07:55 manual to 19:30, offset 2.6 h with "Manual" shown)
- A payroll line for one Overtime-timesheet and one Standard-timesheet employee, from the seeded rates (build step 2.9)
- Billing milestones that sum exactly to the contract value, with the remainder on the last one (step 4.3)
- SLA due times across business hours, weekends and holidays (step 6.4)
- ~~Holy Week dates from the Easter computation (step 1.10)~~ Automated in step 1.10 ([Holiday calendar tests](#holiday-calendar-tests))

## When automated tests arrive (proposed)

Apart from the [sensitive-data guard tests](#sensitive-data-guard-tests), the [audit, notification and reveal tests](#audit-notification-and-reveal-tests), the [Core administration tests](#core-administration-tests), the [user account tests](#user-account-tests), the [module access tests](#module-access-tests), the [user access tests](#user-access-tests), the [master data tests](#master-data-tests), the [approvals tests](#approvals-tests), the [holiday calendar tests](#holiday-calendar-tests), the [directory, org chart and command bar tests](#directory-org-chart-and-command-bar-tests), the [employee record tests](#employee-record-tests), the [document, e-signature and certification tests](#document-e-signature-and-certification-tests) and the [payroll settings tests](#payroll-settings-tests), none of this is in use yet. It's a plan for when tests are added, in priority order:

1. **Unit tests for pure computations**, with Vitest: money rounding, pay computation, DTR, leave and offset balances, 13th month, milestone split, SLA business-hours math, employee and document numbers, Holy Week dates.
2. **Service tests against a real MongoDB replica set**, for example `mongodb-memory-server` in replica-set mode: transactions, balanced journal entries, stock movements and derived on-hand, duplicate receipts. The approvals engine's tests already run (see [Approvals tests](#approvals-tests)).
3. **Access-control tests**: a matrix of module (Engage, Ops, …) × access level (None, Read, Write, Owner) × action, run against `requireModuleAccess` and the [exceptions](../SECURITY.md#exceptions-to-module-access), plus record-level visibility (deal team, project team, project costs). The level matrix, the file access registry and the user access setter already run (see [Module access tests](#module-access-tests) and [User access tests](#user-access-tests)); per-module pages, actions and exceptions are still to come.
4. **End-to-end tests** with Playwright for the phone flows: timesheet, leave, delivery receipt signing, site report, service report.

Tests go next to the code they test (`*.test.ts`). Test data comes from the seed loaders plus small, named fixtures. Never use real employee data.

## Rates and law

Seeded rates and tables must be checked against official issuances before the first real payroll and before go-live. That duty is in [Keeping rates current](COMPLIANCE.md#keeping-rates-current), not here.
