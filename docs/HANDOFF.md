# Build handoff

**Date:** 2026-10-18 · **Branch:** `phase-1` · **For:** the next Claude Code session and the project owner

Where the build stands, what's half-done, and what to do next. Facts here were checked against the repo on this date. The specs in [BUILD_PLAN.md](BUILD_PLAN.md), [SECURITY.md](../SECURITY.md) and the ADRs win over this file.

For the full session summary (status by step, decisions, open items), see [BUILD_SUMMARY.md](BUILD_SUMMARY.md).

## Read this first

From [CLAUDE.md](../CLAUDE.md):

- **Never do the work yourself.** Dispatch a sub-agent for every task, including reading code.
- **Model routing.** Haiku (`model: "haiku"`) for lookups and summaries. Opus (`model: "opus"`) for everything else. Always pass `model` explicitly.
- **One sub-agent per task.** Plan first, then dispatch. Run independent sub-agents in parallel.
- **Read the sub-agent's report**, not the files.
- **Verification is delegated too**: typecheck, lint, tests and review each go to a sub-agent.
- **Tell each sub-agent which docs to read**: the step's **Spec** links in [BUILD_PLAN.md](BUILD_PLAN.md), or the map in [AGENTS.md](../AGENTS.md#where-the-rules-are).

From [AGENTS.md](../AGENTS.md#how-to-work):

- **One build step at a time.** Nothing from a later step.
- **Plan first.** Show the plan and wait for the user's approval before any code.
- **Spec changes first.** Change the docs before the code ([CONTRIBUTING.md](../CONTRIBUTING.md#change-the-spec-first)).
- **Don't guess.** If docs are unclear or contradict each other, say so, and list what you assumed at the end of the step.
- **Don't commit without asking the user.**

## Branches and commits

`phase-1` is pushed up to step 1.8 (2026-10-08): `origin/phase-1` exists and is its upstream. The sidebar grouping (`89296fb`), step 1.9 (`42e64f1`), step 1.10 (`5f283bb`) step 1.11 (`2d2d3ca`), step 2.1 (`cd2a5a6`), step 2.2 (`58e3971`), step 2.3 (`fffefd7`), step 2.4 (`1e1cb41`), step 2.5 (`d1847a5`) and step 2.6 (2026-10-18) are committed but **not pushed**. Phase 2 continues on `phase-1`. No pull request is open yet. `phase-0` is not pushed.

| Branch | Commit | What |
|---|---|---|
| `main` | `ad0e3f7` | Docs baseline |
| `phase-0` | `73a73a7` | Phase 0 foundation (steps 0.1–0.8) |
| `phase-1` (current, built on `phase-0`) | `78d22b6` | Step 1.1 core schemas and seed script |
| | `54cbe7a` | Step 1.2 sign-in, password change and status check |
| | `8cddb26` | Step 1.2 follow-up: temporary-password sign-ins land on `/change-password` |
| | `2b7c959` | Step 0.8 sensitive data validators, guard hardening and tests |
| | `823a8d2` | Dev server accepts this machine's LAN addresses as dev origins |
| | `84667ff` | Step 1.3 audit log, notifications and sensitive reveal |
| | `238a9f0` | Step 1.4 departments, positions and company settings (with the review fixes) |
| | `45f1dc4` | Step 1.5 user accounts and employee numbers (with the review fixes) |
| | `61c2ccb` | Step 1.6 module access and the signed-in shell (with the review follow-ups) |
| | `be19cda` | Step 1.7 user access (57 files). Pushed |
| | `c1fba4f` | Step 1.8 shared master data, with `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md`. Pushed (2026-10-08) |
| | `89296fb` | Administration sidebar sub-groups (2026-10-09). Not pushed |
| | `42e64f1` | Step 1.9 approvals engine (2026-10-11). Not pushed |
| | `5f283bb` | Step 1.10 holiday calendar (2026-10-12). Not pushed |
| | `2d2d3ca` | Step 1.11 directory, org chart, command bar and Home tiles (2026-10-12). Not pushed |
| | `cd2a5a6` | Step 2.1 employee record and sensitive fields (2026-10-12). Not pushed |

## Step 1.2 follow-up (committed as `8cddb26`)

**What it fixes:** after signing in with a temporary password, the address bar should land on `/change-password`.

**How:** the sign-in action calls `signIn(..., { redirect: false })`, then `redirect()`s to `/change-password?callbackUrl=…` when `needsPasswordChange(email)` is true, else to the safe callback. The `callbackUrl` is carried through `/change-password` and sanitized again. The proxy uses `changePasswordPath`.

**Files (8, +50 −11):**

- `apps/web/app/(auth)/login/actions.ts`
- `apps/web/app/(auth)/change-password/page.tsx`, `change-password-form.tsx`, `actions.ts`
- `apps/web/lib/callback-url.ts` (`changePasswordPath`)
- `apps/web/proxy.ts`
- `packages/core/src/server/auth/authenticate.ts` (`needsPasswordChange`)
- `packages/core/src/server/index.ts` (export)

**Status:** done and independently verified in full (2026-10-03). The verifier passed it:

- `pnpm typecheck`, `pnpm lint` and `next build` pass.
- About 30 open-redirect payloads, via `/change-password?callbackUrl=` and tampered hidden fields (including `//evil.com`, backslash and encoded variants), all fall back to `/` on this site.
- No account enumeration: `needsPasswordChange` runs only after a successful sign-in.
- Live Playwright flows pass in dev and in a production build.

The user also did the browser checks.

## Phase 0 status

| Step | Status |
|---|---|
| 0.1–0.7 | Done. Verified against the real local services (MongoDB `rs0` and Memurai). Typecheck, lint, web build, seed and `/dev/health` (34/34) pass. |
| 0.8 Sensitive data helper | Done, verified, **committed as `2b7c959`** on `phase-1` (2026-10-03). One accepted limitation (F1/F2, below). See below. |

### Step 0.8: what was finished (2026-10-03)

The earlier gap list here was stale: `guard.ts` in `73a73a7` already handled `$rename` at both ends, the unsupported shapes (`[sensitiveField()]`, nested arrays, Maps, discriminators), `$push`/`$addToSet` checks, `$pull`/`$pop`, upserts with a sensitive filter and `$setOnInsert`. The fix round added tests for those and the rest of the spec:

- **Validator.** `packages/db/src/sensitive-validator.ts` builds a `$jsonSchema` from the schema's sensitive paths (leaf `{ encrypt: {} }`, containers pinned to object or array, or null) and installs it in the index readiness step (`indexes.ts`): `createCollection` when missing, `collMod` only when it differs.
- **`encrypt` keyword.** Works on Community 8.3.11 at top level, in nested `properties` and under `items`; pins subtype 6 and refuses `null`; can't be combined with `bsonType`. Recorded in ADR 0005 and 0012.
- **`$out`.** Keeps the validator and validates; only `bypassDocumentValidation` skips it, so the guard refuses that option (also on another model's aggregate that `$out`s or `$merge`s into a sensitive collection).
- **Guard.** Also refuses `strict: false` (schema option at definition; query, bulkWrite and save at write time), `bypassDocumentValidation`, and `null` (the setter too).
- **Tests.** `pnpm test` (Vitest) against a `mongodb-memory-server` replica set (x64 build on Windows on Arm): `packages/core/src/server/encryption/guard.test.ts` and `packages/db/src/sensitive-validator.test.ts`.
- **Not checked against the real dev database.** The `devEncryptionSamples` collection there gets its validator on the next `pnpm dev`; `/dev/health` and `/dev/ui` should be rechecked by hand.

- **Verified (2026-10-03).** An independent verifier passed the step with one blocking finding (F1/F2), which the user chose to accept and document rather than fix with code wrappers:
  - **F1.** Mongoose's per-call option `middleware: false` (or `middleware: { pre: false }`) skips every user hook, the guard included. With `bypassDocumentValidation` it stores plain text (update pipeline, `$merge` with `.option(...)`, lean `insertMany`).
  - **F2.** `middleware: false` alone, or `mongoose.connection.bulkWrite` (which never runs the model's `bulkWrite` hooks), turns a plain value or `null` into the setter's empty subtype 6 placeholder, and the write succeeds: silent data loss.
  - **Mitigation.** Recorded in [ADR 0012](adr/0012-fail-closed-sensitive-fields.md#consequences) and [Sensitive data](../SECURITY.md#sensitive-data) (plus a review-checklist item). ESLint (`eslint.config.mjs`) bans `middleware` and `bypassDocumentValidation` as object-literal keys and `bulkWrite` on `connection`/`conn`/`db` in `apps/`, `packages/` and `scripts/`; `guard.test.ts` is exempt. Tests named "known limitation" pin today's behaviour.
  - **Also fixed in the same round.** Upsert filters reaching a sensitive field through `$in`, `$nin`, `$all` or `$elemMatch` on a parent are refused (F7); tests for a Map of subdocuments with a deeper sensitive field and for the NamespaceExists (code 48) race; BUILD_PLAN's testing note; a long JSDoc line in `indexes.ts`.

Committed on `phase-1` as `2b7c959`. The dev-origins fix followed as `823a8d2`.

### Known issue outside step 0.8 (not fixed)

- `packages/db/src/define-model.ts`'s `insertMany` pre hook reads `options?.session`, but Mongoose 9 passes only `[arr]`, so an `insertMany` inside a transaction waits for indexes instead of failing fast.

## Phase 1 status

| Step | Status |
|---|---|
| 1.1 Core schemas and seed script | Done, `78d22b6`, verified |
| 1.2 Sign-in, password change and status check | Done, `54cbe7a`, verified. Follow-up fix committed as `8cddb26` and independently verified. User browser checks done (confirmed by the user, 2026-10-03) |
| 1.3 Audit log, notifications and sensitive reveal | Done, verified, **committed as `84667ff`** on `phase-1` (2026-10-03). Stage 1 (server side, docs, tests) and stage 2 (UI) both built and checked live. The user settled the four open items and the changed-sensitive-field fix is in (below) |
| 1.4 Departments, positions and company settings | Done, verified, **committed as `238a9f0`** on `phase-1` (2026-10-05), including the [1.4 review fixes](#14-review-fixes-2026-10-05). Typecheck, lint, `pnpm test` (249), Prettier and browser checks pass. See [Approved 1.4 plan](#approved-14-plan) |
| 1.5 User accounts and employee numbers | Done, verified, **committed as `45f1dc4`** on `phase-1` (2026-10-05), including the [1.5 review fixes](#15-review-fixes-2026-10-05). Typecheck, lint, `pnpm test` (395), Prettier and browser checks pass. See [Approved 1.5 plan](#approved-15-plan) and [1.5 review fixes](#15-review-fixes-2026-10-05) |
| 1.6 Module access and the signed-in shell | Done, verified, **committed as `61c2ccb`** on `phase-1` (2026-10-05), including the [1.6 review follow-ups](#16-review-follow-ups-2026-10-05). Typecheck, lint, `pnpm test` (449), Prettier, and the real 403/404 and browser checks in dev and a production build pass. See [Approved 1.6 plan](#approved-16-plan) |
| 1.7 User access page | Done, **committed as `be19cda`** on `phase-1` and pushed (2026-10-06). Built per the user's 16 decisions (BUILD_PLAN decisions 65–80). Typecheck, lint, `pnpm test` (28 files, 495 tests) and the production build pass. **Open:** the browser check by a person. See [1.7 build](#17-build-2026-10-06) |
| 1.8 Shared master data services | Done, verified, **committed** on `phase-1` as "feat(core,web): step 1.8 shared master data" and pushed (2026-10-08). Typecheck, lint, Prettier, `pnpm test` (37 files, 671 tests) and the production build pass. **Open:** the browser check by a person and three judgement calls. See [1.8 build status](#18-build-status-2026-10-08) |
| 1.9 Approvals engine | Done, **committed as `42e64f1`** on `phase-1` (2026-10-11), not pushed. Built per BUILD_PLAN decisions 99–110 |
| 1.10 Holiday calendar | Done, **committed as `5f283bb`** on `phase-1` (2026-10-12), not pushed. Built per BUILD_PLAN decisions 111–132 |
| 1.11 Directory, org chart, command bar and Home tiles | Done, **committed as `2d2d3ca`** on `phase-1` (2026-10-12), not pushed. Built per BUILD_PLAN decisions 133–153. Typecheck, lint, Prettier, `pnpm test` (52 files, 910 tests) and the production build pass. **Open:** the user's hands-on checks in the browser, then the Phase 1 check. See [1.11 build](#111-build-2026-10-12) |

### 1.1 notes

Decisions are recorded in [modules/core.md](modules/core.md) and [ARCHITECTURE.md](ARCHITECTURE.md): loaders only fill absent fields; seed writes aren't audit-logged; positions keep a `seedKey`; the allowed-domain check lives in services and the users schema checks shape only; Core schemas live in `packages/core` (the plan to put shared master data in `packages/db` was superseded in 1.8 by [ADR 0013](adr/0013-master-data-schemas-in-core.md): it lives in `packages/core` too); no password rule for the seed; recovery of a disabled only-admin is deferred.

Known minors:

- The `companySettings` fill loop fails if `birRegistration` is stored as `null`.
- The fill `$set` skips validators.
- The unique index allows only one system account.

### 1.2 notes

- Two majors were found and fixed before commit: non-idempotent `defineModel`, and an open redirect in `callback-url.ts`.
- `next-auth` is pinned to `5.0.0-beta.32`. The Auth.js instance is in `apps/web`; the logic is in `packages/core`, which must not import `next`.
- `proxy.ts` reloads the user on every request, clears cookies for deactivated users, enforces an absolute 24 hours via `signedInAt` (a value more than 5 minutes in the future is refused), and sends `mustChangePassword` users to `/change-password`.
- Password rule: 12–128 characters, different from the current password and the email.
- Sign-out is in the toolbar. `/dev/*` sits outside the proxy. `/files` requires sign-in.
- `AUTH_TRUST_HOST=true` is documented and set in `.env.local`.

**User browser checks done** (the user confirmed, 2026-10-03): light and dark, phone width, keyboard and Escape on the Account popover, reduced motion, screen-reader announcements, and comparison against the design canvas.

### 1.3 notes

The user released 1.3 and approved the plan on 2026-10-03. It is built in two stages by separate agents.

**Stage 1 (server side), built, committed in `84667ff`.** Docs first (DATA_MODEL, core.md, SECURITY, ARCHITECTURE, COMPLIANCE, TESTING, ADR 0005 and 0010, AGENTS, README, BUILD_PLAN, CHANGELOG), then:

- `packages/core/src/server/audit/`: the append-only `auditLogs` model (private), `recordAudit`, `listAuditEntries`, `snapshotForAudit` and `redactForAudit`.
- `packages/core/src/server/notifications/`: the `notifications` model (private; only `readAt` may change), `notify`, `countUnread`, `listNotifications`, `markRead`, `markAllRead`.
- `packages/core/src/server/sensitive/`: `registerSensitiveReveal`, `canRevealSensitive`, `revealSensitiveField`. `revealSensitive` hands off to it; the Phase 0 production refusal is gone.
- `changePassword` writes a `passwordChange` entry in the same transaction.
- `MODULES`/`ModuleKey` in `@pulse/core` (`packages/core/src/modules.ts`), plus `AUDIT_ACTIONS`, `auditFiltersSchema` and `isInternalHref`.
- `guardWrites` gained an opt-in `allowManyUpdates` (notifications use it for mark-all-read).
- Web: `apps/web/lib/auth.ts` (`signedInUser`, `requireSystemAdministrator`, `systemAdministratorOnly`) and Server Actions in `apps/web/lib/actions/` (`notifications.ts`, `sensitive.ts`, `audit.ts`). `/dev/ui`'s masked field now uses the shared reveal action and needs a sign-in; `apps/web/app/dev/ui/actions.ts` was removed.
- Tests: `audit.test.ts`, `notifications.test.ts`, `reveal.test.ts` and `auth/change-password.test.ts`. `pnpm test` was at 165 tests, all passing, as of stage 1; 170 after the changed-sensitive-field fix.

**Stage 2 (UI), built, committed in `84667ff`.** The toolbar bell with an accent unread badge (capped at "99+"; refreshes on navigation, window focus and popover open, no polling; popover shows the latest 20, "Mark all as read", "See all" and the empty state), the `/notifications` page (30 per page, All and Unread), the `/admin/audit` page (System Administrator only via `requireSystemAdministrator()`; URL filters, 50 per page with keyset Newer/Older paging, an inspector with a before → after comparison), and inline EmptyState and ErrorState variants plus `formatRelativeTime`. No reference design exists for the bell. Checked live in Chromium and WebKit, light and dark, at 375 px.

**Open items: settled by the user (2026-10-03):**

1. **Changed-sensitive-field gap: approved and fixed.** `snapshotsForAudit(model, before, after)` in `packages/core/src/server/audit/snapshot.ts` snapshots both sides of an update together. A sensitive field whose stored encrypted bytes differ from `before` (or that `before` didn't have) becomes `{ "$hidden": "sensitive", "changed": true }` (`HIDDEN_SENSITIVE_CHANGED`) in `after`; `before` and unchanged fields keep `{ "$hidden": "sensitive" }`. Only the stored bytes are compared, in memory; neither the ciphertext nor the value goes into the snapshot. Encryption is randomized, so re-saving the same value also shows as changed. Arrays of subdocuments are compared by position. `snapshotForAudit` (one side) never marks. `recordAudit`'s backstop keeps the marker. The audit page shows it as "Hidden (sensitive), changed" in the changed fields list (`apps/web/app/(pulse)/admin/audit/snapshot-changes.tsx`). Docs: [Audit logging](../SECURITY.md#audit-logging), [Audit log](modules/core.md#audit-log), [Architecture rules](ARCHITECTURE.md#architecture-rules), BUILD_PLAN decision 19, CHANGELOG. Tests: five new cases in `audit.test.ts` (a changed field is marked; unchanged ones are not, lean reads included; a new field and a same-value re-save are marked; nothing is marked without `before`; no ciphertext or plain value in memory or in the stored entry). `pnpm test`: 170 passing.
2. **Not-found with HTTP 200 on `/admin/audit` for non-admins: deferred to 1.6**, no code change now. Listed in [Open items for later steps](#open-items-for-later-steps).
3. **Breadcrumb showing "Administration": kept** as it is.
4. **Spec readings confirmed:** an employee can reveal every category on their own record; HR can reveal other HR staff's values; booleans (and `null`) under password-like keys are kept in snapshots. The docs say so explicitly ([Sensitive data](../SECURITY.md#sensitive-data) reveal table, [Audit logging](../SECURITY.md#audit-logging), BUILD_PLAN decision 19) and the code matches (`sensitive/policy.ts`, `audit/snapshot.ts`; covered by the reveal matrix and the snapshot tests).

**Notes for later:**

- Audit append-only is enforced in Mongoose only (`guardWrites`). Raw driver calls can bypass it. Accepted.
- Reveal registrations are in-process. A module must call `registerSensitiveReveal` before its reveals are used.

**The user's 16 decisions (final, 2026-10-03):**

1. Collections are `auditLogs` and `notifications`.
2. Add `MODULES` and `ModuleKey` now; the audit `module` is one of them or `core`. Module access itself is step 1.6.
3. Retention: nothing is ever deleted or expires, no TTL indexes, for both collections. Philippine-law retention and erasure set aside for this internal app. Redaction rules still apply.
4. Audit entries store full redacted `before`/`after` snapshots (null on create/delete), not diffs: `select: false` fields left out, sensitive paths marked, encrypted values, bytes and secret-looking keys redacted at any depth, ObjectIds and dates as strings, size capped with markers.
5. A failed audit write blocks the change (same `withTransaction` session).
6. The audit page is System Administrator only; everyone else gets `notFound()` until 1.6.
7. The dev sample can be revealed by the System Administrator, HR and Accounting; revealing on `/dev/ui` needs a sign-in.
8. Context-based reveals (medical-certificate approver; Board payroll and disciplinary views) are denied in 1.3.
9. A reveal needs no typed reason.
10. Viewing the audit log and marking notifications read are not audit-logged; reveals are.
11. The badge refreshes on navigation, window focus and popover open, no polling (stage 2); stage 1 gives `countUnread` through a Server Action.
12. A full `/notifications` page in stage 2; stage 1 gives the paged list service and actions.
13. The badge uses the accent colour; no reference design.
14. No dedupe key in `notify()`; step 1.7 adds it.
15. `pnpm test` covers the audit, notification and reveal rules too; TESTING.md, ADR 0010 and AGENTS.md updated first.
16. Step 1.3 may change 0.8's reveal code: `revealSensitive` hands off to the access-checked, audited service and requires an actor; the blanket production refusal is removed; `noAccessCheckYet` dropped from the dev reveal.

- Seed writes and sign-ins are never audit-logged.

## Approved 1.4 plan

The user approved this plan on 2026-10-03. The spec was updated first (docs only, uncommitted): [Managing departments and positions](modules/core.md#managing-departments-and-positions), [Company settings page](modules/core.md#company-settings-page), the `/company-logo` exception in [SECURITY.md](../SECURITY.md#exceptions-to-module-access) and [File storage](ARCHITECTURE.md#file-storage), the [Background jobs](ARCHITECTURE.md#background-jobs) row, [Core administration tests](TESTING.md#core-administration-tests), ADR 0010, AGENTS.md, README.md, CHANGELOG and BUILD_PLAN decisions 20–30. Build agents read those sections; this section is the implementation plan.

### The user's 11 decisions

1. "System-wide settings" are only the `core.fileUploads` limits (maximum upload size, allowed file types), as versioned config: a change is a new version effective from today in Manila, never an edit.
2. A narrow public `/company-logo` Route Handler serves only the file whose id equals `companySettings.logoFileId`, PNG/JPEG/WebP only, with the `/files` hardening headers and a `?v=<fileId>` cache buster. Documented as a module access exception and in File storage.
3. The company details reminder job runs weekly (Mondays 08:00 Asia/Manila) while any detail is a placeholder. It notifies active HR and System Administrator users (event `core.companyDetailsPending`; link `/admin/settings` for the System Administrator, `/admin` for HR), skipping a recipient who already got that event that Manila day. A banner on Home and `/admin` lists the missing details, for HR and the System Administrator only.
4. A department can't be retired while it has live positions or active employees; a position can't be retired while active employees hold it. `HR`, `ACCT` and `BOD` are **not** protected (the user's choice). Restore is allowed (audit `restore`). Codes are never reused; unique indexes include retired records. Retire is a soft delete (`deletedAt`), audit `delete` with `after: null`.
5. A position's department is fixed after creation. A timesheet type change saves at once and takes effect from the next cut-off.
6. A second upload settings change on the same Manila day is refused with a clear error.
7. Removing an allowed domain is a soft delete; re-adding restores it (audit `restore`). Removing the last domain, or the acting admin's own domain, is refused. The confirm dialog shows the domain's user count.
8. The logo counts as a company detail: while `logoFileId` is null, the reminder stays.
9. A department head is optional: any employee whose account resolves to active, in any department.
10. Automated tests for 1.4: departments, positions, company settings, reminder, allowed email domains and upload settings suites (permissions, audit entries, retire rules, reminder logic, domain safeguards).
11. The not-found page on the new restricted pages returns HTTP 200; accepted and deferred to 1.6.

### Access until 1.6

- Departments and positions: HR or System Administrator (the page guard returns not found to anyone else). Company settings, the logo, allowed domains and upload settings: System Administrator only.
- Services re-check the role themselves. Every mutation writes its change and `recordAudit` in one transaction.
- Audit record types: `core.department`, `core.position`, `core.companySettings`, `core.allowedEmailDomain`, `core.configVersion`.
- Routes: `/admin/departments`, `/admin/positions`, `/admin/settings`. Not in the sidebar until 1.6.
- Company TIN and employer numbers are company data, not sensitive personal data.
- The logo file is saved before the transaction; if the transaction fails the file is left orphaned. Accepted.

### packages/core

- `src/company-details.ts` (pure): `COMPANY_DETAIL_FIELDS`, `pendingCompanyDetails(settings)` using `isPlaceholder`, and the Zod schemas `companyDetailsSchema`, `emailDomainSchema`, `fileUploadSettingsInputSchema`.
- `src/org-structure.ts` (pure): the Zod schemas `departmentInputSchema`, `departmentUpdateSchema`, `positionInputSchema` and `positionUpdateSchema`, and the department code pattern the form shares. (The plan first put the department and position schemas in `company-details.ts`; they were built here instead.)
- `server/auth/roles.ts`: `canManageOrgStructure`.
- `server/departments/service.ts`: list (head name, live position count, employee count), create, update (name and head; code read-only), retire, restore, `listEligibleDepartmentHeads`.
- `server/positions/service.ts`: list, create (department must be live), update (name and timesheet type), retire, restore.
- `server/company-settings/service.ts`: get, `getCompanyDetailsStatus`, `getCompanyLogoFile`, `updateCompanyDetails`, `setCompanyLogo` (`saveUpload` outside the transaction, accept PNG/JPEG/WebP, owner `core.companySettings`), `removeCompanyLogo`.
- `server/allowed-email-domains/service.ts`: extend with list (with user counts), add (restore if removed), remove (with the safeguards).
- `server/files/settings.ts`: `updateFileUploadSettings`, using `addConfigVersion` and `recordAudit` in one transaction.
- `server/company-settings/reminder-job.ts`: `defineSchedule('core.companyDetailsReminder', …)`, registered in `apps/worker`.
- Exports go in `server/index.ts` and `src/index.ts`.

### apps/web

- `lib/auth.ts`: `requireHROrSystemAdministrator`, `hrOrSystemAdministratorOnly`.
- `lib/actions/org-structure.ts` and `lib/actions/company-settings.ts`, using the `defineAction` pattern.
- The `admin/page.tsx` overview: HR sees the Departments and Positions cards; the System Administrator also sees Settings and Audit; plus the banner.
- The pages `admin/departments`, `admin/positions` and `admin/settings`.
- `components/company-details-reminder.tsx`, on Home and `/admin`.
- `components/company-logo.tsx`, replacing `LogoPlaceholder` in `pulse-shell.tsx` and `(auth)/layout.tsx` once a logo exists.
- `app/company-logo/route.ts`, plus its `PUBLIC_PATHS` entry in `proxy.ts`.

### UI

- Data tables on `surface` cards.
- Create and edit in a Sheet with inset grouped sections.
- The timesheet type as a Segmented control (Standard | Overtime), with the footer "Takes effect from the next cut-off".
- The department head as a searchable picker, with an empty state.
- A destructive confirm to retire.
- Settings as one page of inset grouped sections, with "Placeholder" labels.
- Checked in light, dark and at 375 px.

### Build order

1. Docs first. Done (2026-10-03).
2. In parallel:
   - **2a.** Org structure server (departments, positions, `canManageOrgStructure`) and its tests.
   - **2b.** Settings server (company settings, allowed domains, upload settings), the reminder job, the logo route, and their tests. 2b owns the `index.ts` export files (`server/index.ts`, `src/index.ts`).
   - Not settled by the plan: which of 2a and 2b writes `src/company-details.ts`, since both need its schemas. Assign it when dispatching.
3. Then, in parallel:
   - **3a.** Departments and Positions UI, the `auth.ts` helpers, and the org-structure actions.
   - **3b.** Settings UI, the company-settings actions, the banner, `admin/page.tsx` and `CompanyLogo`. Only 3b edits `admin/page.tsx`.
4. Verification: typecheck, lint, `pnpm test`, Prettier, review against the docs and decisions 20–30, browser checks in light, dark and phone width.

### 1.4 review fixes (2026-10-05)

A code review of the built step found these; the user approved fixing them, and they are applied (committed in `238a9f0`):

- **Write skew, department retired while a position is added or restored.** `createPosition` and `restorePosition` now write the department document in their transaction (`claimLiveDepartment`: `$inc __v` with timestamps off, so no audit entry and no `updatedAt` change) and refuse when it no longer matches as live. `retireDepartment` writes the same document, so one of two overlapping transactions gets a write conflict and is retried. Assigning employees to departments or positions (from step 1.5 on) needs the same write, since retiring also checks for active employees.
- **Write skew, last allowed email domain removed.** `removeAllowedEmailDomain` bumps `__v` on every live domain before counting them, so two concurrent removals conflict and the retried one is refused as the last domain.
- **Position names ignore case** (spec first: [Managing departments and positions](modules/core.md#managing-departments-and-positions), CHANGELOG 2026-10-05). The unique `{ departmentId, name }` index has `collation: { locale: 'en', strength: 2 }` and a new name, `departmentId_1_name_1_ci`. Department names have no uniqueness rule in the spec or the code, and codes are uppercased on save, so nothing changed for departments.
- `positions.departmentId` is `immutable`.
- Position audit labels are `<DEPT CODE> · <name>`, like the department entries.
- The logo hint on `/admin/settings` lists only the logo types the current upload settings also allow.
- `.gitattributes` added (`* text=auto eol=lf`); `packages/db/src/connection.ts` converted to LF.
- Docs: TESTING.md, AGENTS.md and README.md list the logo route test and every 1.4 suite.

Known issues:

- **An existing local database keeps the old case-sensitive index until `pnpm seed:admin` runs.** Indexes are built by `connectDb()` (`model.init()`, then `createIndexes()`; never `syncIndexes`), which adds the new `departmentId_1_name_1_ci` index beside the old `departmentId_1_name_1` one but drops nothing. Because the new index has its own name there is no options conflict, so nothing breaks, and names are unique ignoring case as soon as it is built. The positions seed loader then drops the old index, but only when `departmentId_1_name_1_ci` exists; otherwise it keeps the old one and prints a `positions: kept the old case-sensitive index...` warning, so names never lose their unique index. **Developer action:** run `pnpm seed:admin` once (or `db.positions.dropIndex('departmentId_1_name_1')` in mongosh). If a department already holds two positions whose names differ only in case, the new index can't be built and writes to `positions` are refused with `IndexBuildError` until one is renamed (then run `pnpm seed:admin` again); the seeded data has no such pair.

## Approved 1.5 plan

Step 1.5 plan approved 2026-10-05, all 19 recommendations accepted. The spec was updated first (docs only, uncommitted): [Managing user accounts](modules/core.md#managing-user-accounts), [Employee number](modules/core.md#employee-number-company-id), [Reporting lines](modules/core.md#reporting-lines), the inactive-head badge in [Managing departments and positions](modules/core.md#managing-departments-and-positions), [People data ownership](modules/core.md#people-data-ownership), [Sign-in and passwords](../SECURITY.md#sign-in-and-passwords), [Account status](../SECURITY.md#account-status), [System Administrator](../SECURITY.md#system-administrator), the audit list and review checklist in SECURITY.md, DATA_MODEL (`users.sessionsValidFrom`, `employees.separationDate`, the Account status row), talent.md (separation date on Core's identity; empty `reportingTo` wording), [User account tests](TESTING.md#user-account-tests), ADR 0010, AGENTS.md, README.md, RUNBOOK (recovery in 1.7), CHANGELOG and BUILD_PLAN decisions 31–49. Build agents read those sections; this section is the implementation plan.

### The user's 19 decisions

1. HR and the System Administrator create and edit users (`/admin/users`). HR can't grant the System Administrator role; new users get `isSystemAdministrator` false (the switch is 1.7).
2. Create fields (Core-owned): email; first, middle (optional), last name; employee number (Generate or Enter existing); date hired; department and position (both live, position in the department); employment status Probationary, Regular or Contractual; `reportingTo`. Phase 2 adds the rest.
3. Editable: name, email, department, position, `reportingTo`, employment status, separation date. Employee number fixed; date hired changes only within the number's year. Own row read-only. HR can't change a System Administrator's email or employment status, or reset their password; only another System Administrator can.
4. Bootstrap system account: shown only to System Administrators, read-only, Reset password by another System Administrator; hidden from HR. Disable and recovery are 1.7.
5. Temporary password: server-generated, 16 crypto-random Crockford base32 characters as `XXXX-XXXX-XXXX-XXXX`. Shown once in a dialog with Copy and "Hand it over privately"; never stored in plain text, logged or audited; can't be shown again. No expiry.
6. Reset: new temporary password, `mustChangePassword` true, `passwordReset` audit entry (no hash; `mustChangePassword` before/after), and all the target's sessions end via `users.sessionsValidFrom` (a session with `signedInAt` before it is refused). Changing your own password keeps other sessions.
7. Self-reset on `/admin/users` refused for everyone. A System Administrator is reset only by a different System Administrator; HR may reset anyone else, HR and Board included.
8. `employees.separationDate` (00:00 Manila as UTC), kept by Core. Required for a separated status (Resigned, Terminated, Retired), null otherwise, on or after date hired, today or earlier in Manila ("Set this on the separation date."). A status change takes effect at once.
9. Terminated not selectable: refused with "Terminated is available once termination due process is built (Phase 2). Use Resigned or Retired, or wait."; shown disabled with that hint. `EMPLOYMENT_STATUS` unchanged.
10. Reversals (for example Resigned → Regular) allowed: audited, separation date cleared, checked like a new active employee, no typed reason. Rehire under a new number not built.
11. A status change leaving no active System Administrator is refused (system account counts while active); every active System Administrator user is written in the transaction before counting.
12. Date hired from 1990-01-01 to today + 365 days (Manila). Account active from creation.
13. Employee numbers: Generate = per-year counter `$inc` in the create transaction. Enter existing: `YYYY-NN`, year = Manila year of date hired, unused (field error); raises the counter with `$max`, never lowers it. No gap filling. Full-year message: "Employee numbers for 2027 have run out: 2027-99 has been issued. Enter the person's existing company ID if they have one." Nothing written on failure. Counter writes not audited.
14. Reporting lines: empty allowed for anyone, with the hint "No supervisor: leave and offset time off go to HR." for non-Board hires. Not self; at most 10; no repeats; each supervisor exists, is a real employee (not the system account) and active when saved; no cycles (walk the chain in the transaction, writing every ancestor read plus the subject). Lines to someone who later separates stay. Only HR and the System Administrator edit lines in 1.5; Board in 1.11.
15. Create, department/position change and reversal write the department (shared `claimLiveDepartment`) and position (new `claimLivePosition`) in the transaction.
16. A department head who separates stays set; the departments list shows an "Inactive" badge; escalations treat an inactive head as none (Phase 6).
17. Email lowercased and checked against stored allowed domains on create and email edit; duplicate email is a field error; changing email doesn't end sessions.
18. Audit: `core.employee` (label `<employee number> · <first last>`, for example `2027-01 · Ana Cruz`) and `core.user` (label: email). Create writes two `create` entries in one transaction; edits are `update` (`snapshotsForAudit`); reset is `passwordReset`. No 1.5 field is sensitive. No notifications in 1.5 (new-user notification is 1.7).
19. `/admin/users` for HR and the System Administrator, not found for anyone else (HTTP 200 until 1.6), linked from `/admin`, not in the sidebar. Columns: number, name, email, department, position, status (+ "Temporary password" badge). Search by name, number or email; department filter; "Show separated" (`?separated=1`); no paging; sorted by last name.

### Build order

1. Docs first. Done (2026-10-05).
2. In parallel:
   - **2a.** Employee numbers service (generate with `$inc`, enter existing with `$max`, the full-year error) and `employee-numbers.test.ts`.
   - **2b.** Reporting-lines validation (limits, active supervisors, cycle walk with the serializing writes) and `reporting-lines.test.ts`.
   - **2c.** Accounts and sessions: the `users.sessionsValidFrom` and `employees.separationDate` model fields, the session check (`session-user.ts`), the temporary password generator, and the pure Zod schemas in `src/user-accounts.ts`; `session-user.test.ts` and `temporary-password.test.ts`.
3. The user service (create, edit, status changes, reset, list), the roles helpers, `claimLivePosition` and the shared claims, `headActive` for the departments list, the `index.ts` exports, and `users.test.ts`.
4. In parallel:
   - **4a.** Users UI: `/admin/users`, the create and edit sheet, the temporary password dialog, the actions, and the `/admin` overview card.
   - **4b.** The "Inactive" head badge on the departments list.
5. Verification on a throwaway database: typecheck, lint, `pnpm test`, Prettier, review against the docs and decisions 31–49, browser checks in light, dark and phone width, and the "Done when" line. Risk to check: when a user whose session was just ended (by a reset or a status change) next triggers a Server Action, the proxy's redirect on that POST may render inline instead of navigating to `/login`.

### 1.5 review fixes (2026-10-05)

The built step was verified (391 tests, review, browser checks). The user approved fixing these; they are applied (committed in `45f1dc4`):

- **Signed-out notice lost with concurrent requests** (`apps/web/proxy.ts`). When a refused session's click fired two Server Actions, the first redirect cleared the session cookie and the second arrived without it, so its `/login` redirect had no `reason=signed-out`. The proxy now also sets a `pulse-signed-out` flag cookie (value `1`, httpOnly, SameSite Lax, Secure like the session cookie, one minute) when it refuses a session cookie, and adds the reason whenever the flag is present. A valid session deletes the flag. Someone who was never signed in has no flag and sees no notice; plain navigation and the `mustChangePassword` redirect are unchanged.
- **Email-domain race.** `claimEmailDomain` (allowed-email-domains service) writes the domain record in the save's transaction (`$inc __v`, timestamps off), like `claimLiveDepartment`; `createUser` claims it after the quick pre-transaction check, and `updateUser` claims it when the email changes. A removal overlapping the save conflicts and the retry is refused with the domain field error.
- **Last-System-Administrator guard re-checks the actor.** Inside the transaction the actor's user (and employee) must still resolve as active (the system account unless disabled), else "Your account is no longer active, so this change wasn't saved."
- **HR saving a System Administrator's row** ignores the posted email and keeps the stored one, so a form opened before another System Administrator changed the email no longer fails. `ADMIN_EMAIL_ONLY` is gone.
- **Users list** fits 1280px with the sidebar: badges (System Administrator, You, Temporary password) sit under the name, the email is truncated (full on hover and in the sheet), department and position wrap, the status column holds only the status. Phone cards unchanged. It starts sorted by Name (last name, system account first; a descending sort puts the system account last, since the shared table reverses the whole comparator), so the phone control reads "Sort by Name".
- **Reset confirmation** adds "Unsaved changes in this form will be lost." when the edit form has edits.
- Docs: separation date wording ("required for a separated status (Resigned, Terminated, Retired), null otherwise") in SECURITY.md, decision 38, core.md, DATA_MODEL and decision 8 above; core.md reporting lines (remove/reorder isn't re-checked); TESTING.md, AGENTS.md and README.md list `user-accounts.test.ts` and `employees/model.test.ts`; CHANGELOG.

The user's two decisions:

- **HR moving someone into or out of HR changes their role**, and it's audited (the `core.employee` `update` entry shows the department change). Recorded in [Roles](../SECURITY.md#roles) and core.md.
- **Known limit accepted:** a future-dated hire can't be separated before their date hired, and employees can't be deleted. Date-aware statuses (possibly Phase 2) address it. Recorded in [Managing user accounts](modules/core.md#managing-user-accounts).

Known issues:

- The future-dated hire limit above.
- The `pulse-signed-out` flag lasts a minute: a sign-out in the same browser within that minute of a refused session also shows "You were signed out", which is still true.
- Deferred cosmetic items (2026-10-05):
  - Most company emails truncate in the users table at 1280px.
  - The reset dialog's unsaved-changes warning stays after an edit is reverted to its original value.
  - HR sees the hint "Changing the email doesn't sign them out." on a System Administrator's read-only email.
  - The actor re-check runs only when the target is a System Administrator (matches the spec; revisit in 1.7).
  - `proxy.ts` deletes the `pulse-signed-out` flag cookie without the Secure attribute (harmless).

## Approved 1.6 plan

Step 1.6 plan approved 2026-10-05, all 15 recommendations accepted. The spec was updated first (docs only, uncommitted): [Resolving and enforcing](../SECURITY.md#resolving-and-enforcing-build-step-16), the admin area rule in [Rules](../SECURITY.md#rules), [Roles](../SECURITY.md#roles), [System Administrator](../SECURITY.md#system-administrator), the file route exception in [Exceptions to module access](../SECURITY.md#exceptions-to-module-access), [Development-only pages](../SECURITY.md#development-only-pages) and the review checklist in SECURITY.md; DATA_MODEL (`users.moduleAccess`); core.md ([Administration area](modules/core.md#administration-area), the final rule replacing every "until 1.6 … not found (HTTP 200)", and the new user's home in [User access page](modules/core.md#user-access-page)); ARCHITECTURE ([One application](ARCHITECTURE.md#one-application), [File storage](ARCHITECTURE.md#file-storage)); [CODE_STYLE › Pages](CODE_STYLE.md#pages-server-actions-and-route-handlers); [DESIGN_SYSTEM › Feedback & motion](DESIGN_SYSTEM.md#feedback--motion); [Module access tests](TESTING.md#module-access-tests), ADR 0010, AGENTS.md, README.md, CHANGELOG and BUILD_PLAN decisions 50–64 (with decisions 30 and 49 marked superseded) and the step's Spec line. Build agents read those sections; this section is the implementation plan.

### The user's 15 decisions

1. **Storage.** `users.moduleAccess`, a subdocument (no `_id`), one key per module. Engage, Ops, Supply, Desk, Fiscal, Talent: `none|read|write|owner`; Insight: `none|read`. Each defaults to none; a missing key or subdocument resolves to none (no migration). Read-only in 1.6: the setter, the `accessChange` audit entry and "last changed by" are 1.7.
2. **System Administrator.** Effective access computed when the session loads: `isSystemAdministrator` true (bootstrap system account included) → Owner on every module, Read on Insight, stored values ignored. `CurrentUser.moduleAccess` is the effective map. Whether 1.7's switch also writes the stored map is left to 1.7.
3. **Blocked route status.** HTTP 403 with the no-access state inside the shell: `forbidden()`, `(pulse)/forbidden.tsx`, `experimental.authInterrupts`. Guard first, before anything that can suspend, then in-page `<Suspense>`; no route-level `loading.tsx` above a guarded page (it forces 200). Guards in pages, not layouts. Fallback if the flag fails in dev or a production build: `notFound()` with a no-access not-found page (404).
4. **Admin pages without the role** get the no-access state, not "not found", on every `/admin` page: HR on `/admin/audit` and `/admin/settings`; anyone not HR or System Administrator on any `/admin` page, `/admin` included.
5. **Admin area by role.** HR or System Administrator: `/admin`, `/admin/users`, `/admin/departments`, `/admin/positions`. System Administrator only: `/admin/settings`, `/admin/audit`. One helper, `requireAdminPage('hrOrSystemAdministrator' | 'systemAdministrator')`. Review checklist: "calls `requireModuleAccess`, or a Pulse Core check (signed in, or the admin area role), or is an exception".
6. **Sidebar Administration group.** HR and the System Administrator: Overview, Users, Departments, Positions; the System Administrator also Company settings and Audit log. Anyone else: no group; empty groups hidden. Overrides decision 49's "not in the sidebar". Breadcrumbs "Administration › Users" etc., longest match. Command bar nav items follow the filtered sidebar. `/admin/access` and its badge are 1.7.
7. **Home access message** for anyone whose effective access is None on every module (never the System Administrator; can be HR or Board). A designed card under the hero: icon tile, "Your access is being set up. HR will give you access to the modules you need." Replaces "Nothing needs your attention" when shown. Company details reminder unchanged.
8. **No-access state.** Icon tile (Lucide `Lock`); "You don't have access to Pulse <Module>", or "…to this page" for admin pages; "Ask HR or the System Administrator if you need it."; one action, "Go to Home". Same in light, dark and phone width.
9. **Designed not-found.** `app/not-found.tsx` for unknown URLs (real 404, outside the shell, centred empty state, "Go to Home"); `(pulse)/not-found.tsx` for `notFound()` inside the shell.
10. **File route.** Registry `registerFileAccess(ownerType, check(user, file))`; unregistered owner type refused. Registered: `core.companySettings` (any signed-in active user; after the review, only the current logo, the file whose id equals `companySettings.logoFileId`) and `dev.sample` (development only, signed in). Production-wide refusal removed. "File not found." with 404 for missing and denied alike. Sensitive file view audit waits for the first sensitive owner type (Phase 2, 201 files).
11. `noAccessCheckYet` removed. The dev upload action uses `requireSignedIn()`. `/dev` never served in production.
12. **Helper API.** Core: `hasModuleAccess(user, module, level)`, `assertModuleAccess(...)`. Web: `requireModuleAccess(module, level)` (an `AccessCheck` for Server Actions, usable by Route Handlers) and `requireModulePage(module, level)` (returns `CurrentUser` or calls `forbidden()`). Level typed per module (Write on Insight doesn't compile). "One helper" = one shared check with page and action forms.
13. No setter or dev script in 1.6. Tests write `users.moduleAccess` through the model; browser checks set it directly in a throwaway database.
14. The proxy stays the sign-in and status check, with no route table. Pages, actions and Route Handlers enforce module access.
15. **Automated tests.** New TESTING.md section "Module access tests": `packages/core/src/module-access.test.ts` (level order, Insight limit, missing = none, readable modules); `packages/core/src/server/auth/module-access.test.ts` (stored map through `loadSessionUser`; no field = none; System Administrator and system account → Owner, Read on Insight; HR or Board with nothing stored → none; schema refuses `owner` on Insight and unknown levels; full 7 modules × 4 levels × required-levels matrix; admin-area kinds); `packages/core/src/server/files/access.test.ts` (unregistered owner refused; logo opens for a signed-in user; `dev.sample` refused in production; denied and missing answer the same); `apps/web/lib/navigation.test.ts` (new user sees only Home; Talent Read adds Talent; HR sees the four admin entries; System Administrator sees all 7 modules and all 6 admin entries; longest-match breadcrumbs). Partly moves the proposed access-control matrix into what runs today; ADR 0010 narrowed.

Mapped to BUILD_PLAN decisions 50–64 in this order (1 → 50 … 15 → 64).

### Build order

1. Docs first. Done (2026-10-05).
2. In parallel:
   - **2a. Core module access.** Owns `packages/core/**` except `server/files/`, and owns both `index.ts` export files (`server/index.ts`, `src/index.ts`). Covers `src/module-access.ts`, `server/auth/module-access.ts`, the users model field, `CurrentUser.moduleAccess`, removing `noAccessCheckYet`, the `roles.ts` comments, the tests and fixture fixes.
   - **2b. File access.** Owns `server/files/access.ts`, a new `server/company-settings/file-access.ts` registration, `apps/web/app/files/[fileId]/route.ts` and `apps/web/app/dev/health/actions.ts`.
3. **Web helpers plus an `authInterrupts` spike.** Owns `apps/web/lib/auth.ts` and `next.config.ts`. Proves 403 in dev and in `next build && next start`; if it fails, falls back to decision 3's fallback.
4. In parallel:
   - **4a. Shell, Home, module pages, forbidden, no-access and not-found**, and deleting `(pulse)/loading.tsx`. Owns `lib/navigation.ts` and its test, `pulse-shell.tsx`, `(pulse)/layout.tsx`, `(pulse)/forbidden.tsx`, `components/no-access-state.tsx`, `app/not-found.tsx`, `(pulse)/not-found.tsx`, `(pulse)/page.tsx`, the 7 module pages and `module-placeholder.tsx`.
   - **4b. Admin pages and actions.** Owns `(pulse)/admin/**` and `lib/actions/*.ts`. Guard first, in-page `<Suspense>`, delete the admin `loading.tsx` files, update the "until 1.6" comments. `/notifications` keeps its `loading.tsx`.
5. Verification in dev and in a production build on a throwaway database, checking the real 403 and 404 status codes: typecheck, lint, `pnpm test`, Prettier, review against the docs and decisions 50–64, browser checks in light, dark and phone width, and the "Done when" line.

~~Not settled by the plan: the export of 2b's `registerFileAccess` through 2a's `index.ts` files.~~ Settled in the build: `server/index.ts` exports `registerFileAccess`, `authorizeFileAccess`, `findAccessibleFile` and `registerCoreFileAccess`.

### 1.6 review follow-ups (2026-10-05)

Applied and committed in `61c2ccb`.

- File access registrations are explicit: `registerCoreFileAccess()` (`server/files/registrations.ts`, idempotent) is called by the file route, instead of registering as an import side effect.
- Registering an owner type a second time replaces its check outside production (hot reload) and throws in production.
- The `core.companySettings` rule opens only the current company logo.
- Docs: `adminOnly(kind)` named in SECURITY.md and CODE_STYLE.md; the file route's 401 noted as defence in depth (the proxy redirects first); the Next.js `forbidden()`/`notFound()` empty-HTML limitation noted in SECURITY.md; the Write-on-Insight type gap explained in code.
- **Shell follow-ups:**
  - The sidebar and command bar refresh from the server on each navigation (`visibleNavigationAction` in `lib/actions/navigation.ts`, `visibleHrefsFor` in `lib/visible-navigation.ts`), so a change to someone's module access or role shows without a reload.
  - Administration › Overview is highlighted only on an exact match (`/admin`), not on every admin page.
  - The toolbar and the browser tab read "No access" and "Page not found" on the status pages, through `ShellPageTitle` (`components/shell-page-title.tsx`), since `forbidden.tsx` and `not-found.tsx` can't export metadata.
  - The command bar has a visible focus ring, and focus returns to what opened it. When that is now hidden (opened from the toolbar search field, then the window narrowed below `md`), focus goes to the visible phone search button or the Menu button instead of the page body (`app-shell.tsx`).
  - Sidebar links show a pending dot while their route loads. On phones the drawer stays open after a link click so the dot shows, and closes once the route changes; the current page's link closes it at once, and a new-tab click leaves it open.
- **Known Next.js limitation:** `forbidden()` and `notFound()` answer with the right status (403, 404) but blank server HTML; the designed state renders on the client. Documented in SECURITY.md.
- **Verification passed** in dev and in a production build (`next build && next start`) on a throwaway database: typecheck, lint, `pnpm test` (449), Prettier, the real 403 and 404 status codes, and browser checks in light, dark and phone width.

## 1.7 build (2026-10-06)

Committed as `be19cda` "feat(core,ui,web,worker): step 1.7 user access" on `phase-1` (57 files), and pushed (`origin/phase-1` created with its upstream set; no pull request yet). The plan is the user's 16 decisions, recorded as BUILD_PLAN decisions 65–80; the docs were updated first ([User access page](modules/core.md#user-access-page)).

**Checks at the commit:** typecheck, lint and `pnpm test` (28 files, 495 tests) pass. The production build of `apps/web` succeeds, with no `/dev` routes.

### What was built

- **Access service**, `packages/core/src/server/access/service.ts`: `listUserAccess`, `getUserAccess`, `saveUserAccess`, `countUsersNeedingAccessFor` and `countUsersNeedingAccess`. The save checks `moduleAccessChangedAt` for concurrent changes (decision 67) and writes one `accessChange` audit entry per changed module (decision 66).
- **`/admin/access` page and sheet**: stat tiles, the pinned "Needs access" group, search and filters, the System Administrator switch, read-only rows, and `?user=` to open a user's sheet.
- **Needs-access count** in the sidebar and on the `/admin` overview.
- **Notifications**: `notify()`'s `dedupeKey` (decision 71), so a notification can't be sent twice; the new-user and position-change notifications, which leave out both the actor and the user being changed.
- **Daily access reminder** at 8:00 AM Manila in the worker (decision 72).
- **System account Disable and Enable** on `/admin/users` (decision 75).
- **`pnpm recover:admin`** (`scripts/recover-admin.ts`), with tests.

### Assumptions (list for the user)

1. While a user is, or is becoming, a System Administrator, the module levels sent with a save are ignored. Turning the switch on discards unsaved level edits, and the dialog warns about it.
2. The stat tiles leave out the system account, count System Administrators as having access, and count a module as in use at Read or above.
3. Filters apply to the "Needs access" group, but the count and the tiles are unfiltered.
4. The `/admin` overview "card" is a row in the existing list.
5. Cancel reads "Set access later" whenever the user still needs access.
6. The "Waiting since" line on the Needs access tile wasn't built.
7. The sidebar count always uses the accent colour (the reference design shows a white pill on the current item).
8. The Overview icon changed to `LayoutGrid`.
9. The wording of the system account Disable and Enable dialogs was written by the agent.
10. A disabled system account is listed only under "Show separated".

### Not done

- **Browser check by a person.** Agents couldn't sign in, so this is still to do: light and dark appearance, phone width, the sheet's dialogs, and the full "Done when" flow (HR sets Talent Write for a user → Talent shows in that user's sidebar → `/admin/audit` shows None → Write → HR's own row is read-only).

## Phase 2 status

Phase 2 (Pulse Talent) started on 2026-10-12. The user asked for it to be built fully autonomously: the agents' plan recommendations are approved as written, and each assumption that a person still has to confirm goes in [Assumptions to check](#assumptions-to-check).

| Step | Status |
|---|---|
| 2.1 Employee record and sensitive fields | **Done: committed as `cd2a5a6` (2026-10-12), not pushed.** Built per BUILD_PLAN decisions 154–172, then reviewed with a focus on sensitive data; three small fixes made (see [2.1 review](#21-review-2026-10-12)). Typecheck, lint, Prettier, `pnpm test` (57 files, 976 tests) and the production build pass. **Open:** the user's [hands-on checks](#21-hands-on-checks-by-the-user-signed-in) |
| 2.2 201 file, profile photo, e-signature and certifications | **Done: committed as `58e3971` (2026-10-12), not pushed.** Spec written first (BUILD_PLAN decisions 173–190), built by four agents and reviewed; four small fixes made (see [2.2 review](#22-review-2026-10-12)). Typecheck, lint, `pnpm test` (65 files, 1059 tests) and the production build pass. **Open:** the user's [hands-on checks](#22-hands-on-checks-by-the-user-signed-in). Assumptions 9–26 in [Assumptions to check](#assumptions-to-check) |
| 2.3 Payroll settings and seeded configuration | **Done: committed as `fffefd7` (2026-10-12), not pushed.** Spec written first (BUILD_PLAN decisions 191–212), with the seeded rates checked online on 2026-10-12 ([Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23)). Built by three agents and reviewed; one bug fixed and the clock-dependent tests pinned (see [2.3 review](#23-review-2026-10-12)). Typecheck, lint, `pnpm test` (69 files, 1126 tests) and the production build pass. **Open:** the user's [hands-on checks](#23-hands-on-checks-by-the-user-signed-in). Assumptions 27–45 in [Assumptions to check](#assumptions-to-check) |
| 2.4 Work schedules and daily time entries | **Done: committed as `1e1cb41` (2026-10-13), not pushed.** Spec written first (BUILD_PLAN decisions 213–234, [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24)), built, then reviewed; two bugs fixed (see [2.4 review](#24-review-2026-10-13)). Typecheck, lint, `pnpm test` and the production build pass. **Open:** the user's [hands-on checks](#24-hands-on-checks-by-the-user-signed-in). Assumptions 46–61 in [Assumptions to check](#assumptions-to-check) |
| 2.5 Reimbursements | **Done: committed as `d1847a5` (2026-10-13), not pushed.** The planning agent's 19 recommendations were approved as written. Spec written first (BUILD_PLAN decisions 235–255, [Reimbursements (build step 2.5)](modules/talent.md#reimbursements-build-step-25)), built, then reviewed (see [2.5 review](#25-review-2026-10-13)). Typecheck, lint, Prettier and `pnpm test` pass. **Open:** the user's [hands-on checks](#25-hands-on-checks-by-the-user-signed-in). See [2.5 notes](#25-notes). Assumptions 62–75 in [Assumptions to check](#assumptions-to-check) |
| 2.6 Onboarding checklist and change requests | **Done: committed (2026-10-18), not pushed.** Spec written first (BUILD_PLAN decisions 256–276, [Onboarding checklist and change requests (build step 2.6)](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26)), built in the order in [2.6 notes](#26-notes), then verified and reviewed (see [2.6 review](#26-review-2026-10-18)). Typecheck, lint, Prettier, `pnpm test` (82 files, 1394 tests), the production build and `pnpm seed:admin` twice pass. **Open:** the user's [hands-on checks](#26-hands-on-checks-by-the-user-signed-in). Assumptions 84–122 in [Assumptions to check](#assumptions-to-check) |
| 2.7 Timesheet approval and the DTR | **Spec written, not built** (2026-10-18). BUILD_PLAN decisions 277–298, [Timesheet approval, the DTR and the offset balance (build step 2.7)](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27). Build in the order in [2.7 notes](#27-notes). Assumptions 123–137 in [Assumptions to check](#assumptions-to-check) |

### 2.1 notes

- **Done when** now reads "HR reveals a masked TIN, the System Administrator finds HR's reveal in `/admin/audit`, and a Talent Write user sees none of the sensitive fields". HR can't browse the audit log (decision 154).
- **Build order:**
  1. In parallel: the Core identity service and the `guardWrites` export; and the `packages/talent` scaffold, models and pure schemas.
  2. The Talent services and reveal registrations.
  3. In parallel: the web pages and actions; and the tests.
  4. Verification.
- **Spec:** [The employee record](modules/talent.md#the-employee-record-build-step-21), [Sensitive data](../SECURITY.md#sensitive-data), [People data ownership](modules/core.md#people-data-ownership), [DATA_MODEL.md](DATA_MODEL.md#collection-ownership), [Employee record tests](TESTING.md#employee-record-tests).

### 2.1 review (2026-10-12)

An independent review traced every service return, action return, page prop, error message, audit snapshot and log line for plaintext sensitive values and last 4 digits. It found no leak of a value or its last 4. Confirmed as built:

- **Encryption.** The TIN, SSS, PhilHealth, Pag-IBIG, account number and salary are `sensitiveField()`s, stored as subtype 6. The `$jsonSchema` validator is installed with the indexes. Indexes hold no sensitive path, and nothing passes `bypassDocumentValidation` or `middleware`.
- **The access matrix** in `policy.ts` matches decisions 158–162: the sensitive-change rule, date of birth and civil status, the Board's limits, Accounting never, never one's own. Every save reloads the actor (`reloadActorAccess`) and the employee inside its transaction and checks again.
- **The reveals** map each field to its stored path. The subject comes from Core, and the audit entry is written before decrypting.
- **Append-only.** `guardWrites` refuses every update, replace and delete path on compensation entries, and every delete and replace path on records.
- **Money** is parsed with BigInt and shown with `formatPeso`, with no floats.
- **Talent writes no Core collection.** The test fixtures write Core's models by name, in tests only.
- **`/talent/me`** reads no request parameter. The Talent item isn't current there.

Fixed in the review, each with a test:

1. **The "Not filled in" badge told any Talent reader that a salary was stored** (`employee-records/service.ts`, `filledInSet` and `buildView`). An employee with only a compensation entry showed as filled in to a Talent Write or Read user, or a Board member outside HR: a "has a value" flag, against [Sensitive data](../SECURITY.md#sensitive-data). Now a compensation entry counts only for viewers who may see Compensation. talent.md says so.
2. **The actor's in-transaction re-check had no test.** Added one: a stale session (Talent Write lowered to Read, or HR moved out of HR) is refused and writes nothing.
3. **`/talent/me` jumped from the h1 to the sections' h3s.** The employee's name is now an h2.

Also added tests for the remaining append-only write paths (`findOneAndReplace`, `findByIdAndUpdate`, `$merge`, `bulkWrite` deletes, `updateMany`, `$out`, `save()` on a loaded record). TESTING.md and talent.md now match the code.

Judged and left as built:

- **A save that changes nothing** still raises the `version` and writes an `update` entry. The spec says later saves are `update` entries, and the 1.4 and 1.8 services do the same. Only the access setter (1.7) and reporting lines (1.11) say "a save that changes nothing writes nothing". It doesn't contradict the spec; talent.md now says it. Listed in [Assumptions to check](#assumptions-to-check).
- **A refused save can create the field-encryption data key.** Values are encrypted after the pre-check and before the transaction, so a save refused inside the transaction can still create the shared `sensitiveFields` data key on first use. Accepted: the key holds no personal data, and it's created on the first permitted save anyway.
- **"Manage access" and "Edit in Users" show on your own record** for HR and the System Administrator. Accepted: both pages open your own row read-only and say why (decision 169 doesn't exclude it). talent.md says so.

### 2.1 hands-on checks (by the user, signed in)

Set up as in [Assumptions to check](#assumptions-to-check) item 5. Then:

1. **The "Done when".** As HR with Talent Read: open `/talent`, open a filled-in employee outside HR, and reveal the masked TIN. As the System Administrator: find HR's `reveal` entry in `/admin/audit` (module `talent`, record `<number> · <name>`, field `tin`, and no value). As the Talent Write user outside HR, Accounting and the Board: open the same record. It shows no Compensation, Government IDs or bank account section, no date of birth or civil status, only the "Pay, government IDs and bank details are visible…" line.
2. **The Reveal audit.** Reveal a salary and a bank account number, and check that each adds one `reveal` entry. Hide, then reveal again: that adds a second entry.
3. **Editing.** Save each sheet. Add a salary change, then a same-date correction (the old one shows "Superseded"). Open one sheet in two tabs, save both, and check that the second gets "Someone else changed this record. Reload to see it." As HR, open an HR colleague: their IDs, bank and salary have no Edit action.
4. **⌘S (Ctrl+S on Windows)** saves each open sheet, and Escape closes it.
5. **`/talent/me`** as an ordinary user with no Talent access: "My record" sits after Org chart, the Talent item isn't highlighted, the record is read-only, and Reveal works on your own values. As the bootstrap system account: no "My record" entry, and the page shows the empty state.
6. **Light and dark, and phone width (about 390 px):** the list becomes cards, the inspector becomes a full-height sheet, and the edit sheets and masked fields fit with no sideways scroll.

### 2.2 review (2026-10-12)

An independent review checked the step against decisions 173–190, SECURITY.md and the 2.2 parts of ARCHITECTURE, DATA_MODEL, TESTING and COMPLIANCE. Confirmed as built:

- **The file route** opens every file through `openAccessibleFile`. Every owner type has a registered check, and `findAccessibleFile` refuses owner types with `auditView`. The `reveal` entry for a 201 document is committed before any content is read, and a failed entry sends nothing. Missing and refused files get the same 404. The path comes only from the stored key, never the request. The headers are `private, no-store`, a sandbox CSP and `nosniff`, with `inline` only for images (no SVG is accepted). Files stay under `storage/`.
- **Old files.** A replaced or removed photo no longer opens. Every signature version opens for its owner and the System Administrator only. A certification attachment opens only while it is the current one on a live certification.
- **The document access matrix.** Medical certificates are hidden from Accounting, both in the view and at the file route. Others' documents need Talent Read and the reveal rule. Your own always open. A viewer who may see no category gets no `documents` key at all.
- **The e-signature.** Only the owner uploads: the action and the service take no employee id. `applyESignature` reads the employee from the database in the transaction. Signatures and applications are insert-only (`guardWrites`). An approve with no signer registered is refused, and a signer that throws rolls back. Only approve signs.
- **Images.** `sharp` strips EXIF and GPS (tested), and 201 documents are stored byte for byte. The type is read from the content, and the size is checked before decoding, with a decompression-bomb limit.
- **The expiry job.** The recipients, dedupe keys, skips and HR fallback match decision 186. Dates are Manila days, and no title or file name goes into a notification.
- **The read services** return the allowlist only, with no license number and no attachment.
- **Every write** re-checks access in its transaction, is audited and checks the version. `photoUrl` is only ever `/files/<id>?inline=1`, and the command bar registry drops anything else. The self-service actions can't target another employee. The 2.1 sensitive-key tests still pass.

Fixed in the review:

1. **A long approval couldn't be approved by someone with a signature** (`e-signatures/service.ts`, `applyESignature`). The application's audit label `<employee number> · Approval: <label>` could pass the 200-character audit limit, so the audit write failed and rolled back the approve. Labels are now shortened with "…" (`auditLabelOf` in `shared.ts`). Test added.
2. **The same for a certification with a 200-character name** (`certifications/service.ts`, `certificationLabel`). Adding, editing or removing it failed at the audit write. Same fix, test added.
3. **The approvals inspector's requester initials split on the letter "s"** (`approval-inspector.tsx`, `split(/s+/)` instead of `split(/\s+/)`). Fixed.
4. **The "stale form" check matched any error containing "reload"** (`employee-documents-sheets.tsx`). It is now a shared list, `STALE_FORM_MESSAGES` in `@pulse/talent`, with the refusals for a changed or missing record. "This document is archived, so it can't be changed." now also says "Reload the page." and gets the Reload button.

Also aligned: the certification sheet's issue date no longer stops at today, since the service allows a future issue date. talent.md, TESTING.md, SECURITY.md and DATA_MODEL.md now match the code, including the agents' choices (items 19–26 in [Assumptions to check](#assumptions-to-check)).

Not checked: the screens in a browser (no browser tools here), and `pnpm dev:expiry-alerts` against a development database.

### 2.2 hands-on checks (by the user, signed in)

Set up as in [Assumptions to check](#assumptions-to-check) item 18. Then:

1. **The "Done when", signatures.** As an approver, upload an e-signature on `/talent/me`. Run `pnpm dev:approval --requester <email> --step all:<approver email>`, open the request in `/approvals` and approve it: the inspector says "Signed with e-signature, version 1". Replace the signature on `/talent/me` (version 2, "Applied once" on version 1). Submit and approve a second request: it says version 2, and the first still says version 1. An approver with no signature gets "Approved without an e-signature".
2. **The "Done when", expiry alerts.** As HR, add a 201 document and a certification that expire within 30 days, for an employee who has a supervisor. Run `pnpm dev:expiry-alerts` (or `--date YYYY-MM-DD`): HR and the employee get the document alert, and the supervisor also gets the certification alert. Run it again: nothing new. Run it with `--date` on the expiry date: the "expired" alerts arrive once. No notification names a file or a document title.
3. **The 201 open audit.** Open a document as HR, as Accounting, and as the employee on `/talent/me`. Each open adds one `reveal` entry with the field `file` in `/admin/audit`. Accounting doesn't see a medical certificate, and gets "Medical certificates are visible to HR and the System Administrator." A Talent Write user outside HR gets only "201 file documents are visible to HR, Accounting and the System Administrator." Copying a document's `/files/<id>` link into their browser gives "File not found."
4. **Uploads end to end.** Upload a PDF and a JPEG document, a certification attachment, a photo (Change, then Remove) and a signature. A HEIC or a file over the limit is refused next to the field. A phone photo shows upright. Archive a document, then find it under "Show archived". Renew one with "Replaces". Change the expiry alert lead days in Settings on `/talent` as a Talent Owner: a second change the same day is refused.
5. **Photos everywhere.** After adding a photo, it shows in the directory, the org chart, the access page, the approvals list and inspector, the Talent list and inspector, and the command bar's people results (⌘K or Ctrl+K, type a name).
6. **Light and dark, and phone width (about 390 px):** the Documents and Skills & certifications sections, every sheet, the signature tile (dark ink stays readable in dark appearance) and `/talent/me` fit with no sideways scroll, and every badge carries text.

### 2.3 notes

- **Rates checked on 2026-10-12.** The planning figures (mid-2025) were checked online against the agencies. Changed from the plan:
  - **NCR minimum wage:** ₱755 from 2026-09-26 (Wage Order NCR-28), seeded after NCR-26 (₱695, from 2025-07-18). NCR-27 isn't seeded: a Pasig RTC injunction blocked it, NCR-28 replaced it, and its case is before the Supreme Court.
  - **De minimis limits:** RR 29-2025, from 2026-01-06, replaces the RR 11-2018 figures (for example rice ₱2,500 a month, and overtime meals at 30% of the minimum wage).
  - **Unchanged and confirmed:** SSS (Circular No. 2024-006 is still the latest schedule), PhilHealth, Pag-IBIG, the BIR table and the ₱90,000 ceiling. How each was verified is in [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23).
- **Build order (planned):**
  1. **One Talent server agent, in order:**
     - the pure schemas and lookups
     - the settings and seed loaders, with `scripts/seed-admin.ts` and the `./server/seed` export
     - the allowances and minimum wage services
     - the compensation and record view changes and the reveal registration, with tests

     These share `views.ts`, `validation.ts`, `policy.ts` and `server/index.ts`, so one agent does them in sequence.
  2. **Then two agents in parallel:**
     - the Payroll settings page: `apps/web/app/(pulse)/talent/payroll-settings/`, `lib/actions/talent-payroll.ts`, the button on `/talent` and the breadcrumb
     - the record UI: `employee-record-sections.tsx`, `employee-record-sheets.tsx`, `employee-inspector.tsx`, `talent/me/page.tsx` and `lib/actions/talent.ts`
  3. **Verification:** typecheck, lint, Prettier, `pnpm test`, the production build, `pnpm seed:admin` twice on a throwaway database, and a review focused on money and sensitive data.
  4. **Docs:** HANDOFF, BUILD_SUMMARY and the step's results in TESTING.
- **Hands-on checks:** see [2.3 hands-on checks](#23-hands-on-checks-by-the-user-signed-in).

### 2.3 review (2026-10-12)

An independent review checked the step against decisions 191–212, COMPLIANCE.md, DATA_MODEL.md, SECURITY.md and TESTING.md. Confirmed as built:

- **Money.** No floating point: the actions convert pesos with `parsePesos`, rates are decimal strings read with `ratio`, percentages are shown by moving the decimal point, the monthly figure is `addCentavos(amount, amount)`, and the minimum wage comparison is exact (monthly × 12 < minimum × factor, in BigInt). Every seeded value is whole centavos with rates as decimal strings (tested).
- **The seed figures match COMPLIANCE.md.** The SSS generator gives 61 rows and matches the six pinned rows. PhilHealth, Pag-IBIG, the ₱90,000 ceiling, the RR 29-2025 de minimis limits, the premium rates, the pay schedule, NCR-26 (₱695 from 2025-07-18), NCR-28 (₱755 from 2026-09-26) and the internet allowance (₱500 per cut-off, automatic) are as listed. The BIR brackets are continuous: ₱937.50 = 15% × ₱6,250; ₱4,270.70 = ₱937.50 + 20% × ₱16,666; ₱16,770.70 = ₱4,270.70 + 25% × ₱50,000; ₱91,770.70 = ₱16,770.70 + 30% × ₱250,000. Every hand-checked figure in TESTING.md was recomputed and is asserted by a test.
- **Minimum wage.** The check runs in the salary transaction, saves nothing on `belowMinimumWage`, stores `minimumWageWarningConfirmed` on "Save anyway", saves with a note when the region has no rate, and uses the work region (NCR by default) and the later of the effective date and today. The sheet clears the warning when the amount, rate type or effective date changes. The wage order list shows no amounts and needs Talent Read and HR, Accounting or the System Administrator.
- **Allowances.** The automatic line is derived from Core's date hired and the type version in effect; explicit entries are insert-only (`guardWrites`) with the amount encrypted; the reveal is registered and audited; `view.allowances` is absent for a viewer who may not reveal `allowances`; the salary rule applies, never on one's own record.
- **The settings service** checks Talent Owner and HR or the System Administrator in the action and again in the transaction, enforces the date rules (after the latest version, at most a year ahead, a cut-off start for `payrollSettings`), keeps allowance keys, writes the `core.configVersion` audit entry in the transaction, and turns a same-date race into the friendly message.
- **The seed** is idempotent, writes with no actor and no audit, and `scripts/seed-admin.ts` runs `talentSeedLoaders` after Core's.

Fixed in the review:

1. **The minimum wage warning could say "The daily rate ₱755.00 is below the NCR minimum wage of ₱755.00"** (`payroll/minimum-wage.ts`, `minimumWageWarningFor`). The exact rate (₱754.9995… for ₱16,421.24 a month) was rounded half-up for the sentence. It is now rounded down, so it reads ₱754.99. Test added (`payroll.test.ts`), and the service test updated.
2. **Clock-dependent tests** (`payroll-settings.test.ts`, `allowances.test.ts`, `minimum-wage.test.ts`). The view's version statuses, "upcoming", the badge, the scheduled salary from 2027-06-01 and the wage order list depended on the real date being on or after 2026-09-26 (and before 2027-06-01). These files now fake only `Date`, at 2026-10-12 10:00 Manila, and move it where a test needs another day. A test was added for NCR-28 shown as scheduled on 2026-09-01.

Also aligned: talent.md, TESTING.md and DATA_MODEL.md now describe the build's choices (allowances before the date hired, how "Seeded" is detected, the PhilHealth and Pag-IBIG rounding, the cut-off end day, the empty effective date, rates typed as decimals, the `end` entry with no amount). New assumptions 42–45.

Not checked: the screens in a browser (no browser tools here), and `pnpm seed:admin` against a real database (the seed loaders are tested against the in-memory replica set).

### 2.3 hands-on checks (by the user, signed in)

1. **The seed, twice.** On a fresh database, run `pnpm seed:admin`: it prints a line for each of the ten `talent.*` loaders, with `talent.minimumWages: added 2, kept 0`. Run it again: every loader says `added 0`.
2. **The "Done when", allowance.** As HR with Talent Write, create a user whose date hired is today (or a later date) and open their record in `/talent`: Compensation shows "Internet allowance · ₱500.00 per cut-off (₱1,000.00 a month) · Automatic from <date>" (or "Starts <date>"). No allowance entry is stored.
3. **The "Done when", the warning.** For an NCR employee, use "Add salary change" with ₱16,000 a month (or ₱750 a day): nothing saves, the warning names ₱735.63 (or ₱750.00) against ₱755.00 (Wage Order NCR-28), and the button reads "Save anyway". Change the amount: the warning clears. Put ₱16,000 back and choose "Save anyway": it saves and the "Below minimum wage" badge shows. Set the work region to one with no rate and save: the note "No minimum wage on file for <region>. Add it in Payroll settings." shows.
4. **Adding a version.** As a Talent Owner in HR (or the System Administrator), open `/talent/payroll-settings` from "Payroll settings" on `/talent`, and add a premium rates version with a source: the confirmation shows, the version appears as scheduled or in effect, and `/admin/audit` has a `create` entry on `core.configVersion`. A date on or before the latest version is refused. A Talent Owner outside HR sees no "Add version".
5. **The wage order list.** On Minimum wage, NCR-28 shows the count of employees paid below it; "View list" shows names, numbers, departments and positions, with no amounts. A Talent Read user outside HR, Accounting and the System Administrator sees no counts.
6. **Allowances.** "Assign allowance" sets an amount (shown "••••", Reveal adds a `reveal` entry in `/admin/audit`) and "End" stops it. The employee sees their own allowances read-only on `/talent/me`.
7. **Light and dark, and phone width (about 390 px):** every payroll settings view and its "Add version" sheet (the SSS and withholding grids scroll inside their own region), the Compensation section with its badge and allowances, and both sheets fit with no sideways page scroll.

### 2.4 notes

- **Plan.** The planning agent's 20 recommendations were approved as written (the user wants Phase 2 built autonomously). The spec is in [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) and BUILD_PLAN decisions 213–234.
- **Build order (planned):**
  1. **In parallel:**
     - Core: the supervisor pass in `getEmployeeIdentity` and `listDirectReportIdentities` (`packages/core/src/server/employees/identity.ts`), exported, with tests.
     - Talent pure layer: `packages/talent/src/timesheets/` (schemas, `scheduleOn`, `versionOn`, `computeDay`, `computeTimesheet`, the 14 hand-checked cases), the two new keys in `payroll/schemas.ts`, `seed-data.ts` and `settings.ts`, and the 2.3 tests that assume ten settings.
  2. **Talent server, one agent** (they share `policy.ts`, `server/index.ts` and `validation.ts`): `server/work-schedules/`, `server/timesheets/` (models, services, the `talent.openTimesheets` job), policy and exports, with tests.
  3. **In parallel:**
     - Timesheet UI: `app/(pulse)/talent/timesheet/`, `timesheets/[employeeId]/`, the shared `timesheet-ui/` components, `lib/actions/talent-timesheets.ts`, and `lib/navigation.ts` with its test.
     - Schedule UI and wiring: the inspector's Work schedule section and Timesheet link, `/talent/me`, `lib/actions/talent.ts`, the Payroll settings Work schedule segment, and `apps/worker/src/talent-jobs.ts` with its test.
  4. **Verification:** typecheck, lint, Prettier, `pnpm test`, the production build, `pnpm seed:admin` twice, and a review of access, append-only writes, time arithmetic and phone width in light and dark.
  5. **Docs:** HANDOFF, BUILD_SUMMARY, the step's results in TESTING and CHANGELOG; then commit, not push.
- **Spec:** [Timesheets & attendance](modules/talent.md#timesheets--attendance), [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24), [Timesheet hours](COMPLIANCE.md#timesheet-hours-build-step-24), [DATA_MODEL.md](DATA_MODEL.md#versioned-configuration), [Exceptions to module access](../SECURITY.md#exceptions-to-module-access), [People data ownership](modules/core.md#people-data-ownership), [Timesheets on a phone](DESIGN_SYSTEM.md#layout--components), [Timesheet and work schedule tests](TESTING.md#timesheet-and-work-schedule-tests).

### 2.4 review (2026-10-13)

An independent review checked the build against decisions 213–234, talent.md, DATA_MODEL.md, SECURITY.md, COMPLIANCE.md, TESTING.md and DESIGN_SYSTEM.md. Confirmed as built:

- **The time arithmetic.** All 14 hand-checked cases were recomputed by hand and each is asserted by its own test. Also checked: Manila day boundaries (UTC+8), an entry past midnight staying on its time-in day, the break deducted wherever entries overlap it (break windows placed on the day before, the day and the day after), the night window wrapping past midnight, the rest-day and holiday split at `hoursPerDay`, claimed against not claimed, offset with ratio "1.5" (232.5 → 233 min, exact BigInt half-up), seconds dropped by flooring both ends, drafts and local holidays not applied, and two holidays on one date (regular when either is).
- **Writes.** Self-service only: every service reloads the actor and their own employee in the transaction and takes no employee id; another person's entry is "not found", HR and the System Administrator included. Time in and Time out use the server's clock; a source sent by the browser is ignored. Every refusal is in the transaction (overlap including the open entry and the previous night, more than 24 hours, the future, before hire and after separation, the timesheet open, a stale version). Delete is soft with its audit entry.
- **Reads.** A supervisor without Talent Read gets directory fields only (page props carry `toDirectoryIdentity` fields; the inspector is Talent Read only). An outsider gets 403, also for an unknown id, and a null view 404. The breadcrumb's `openToOthers` names the page only; the service decides access. The type snapshot job is idempotent, the type is immutable and guarded, and first use falls back to that day's type. Schedule assignments are insert-only, never on one's own record, dated from the date hired to a year ahead, audited, and the newest wins a tie. The Work schedule segment's `draftToValue` is convenience only: the action and the service parse the value again. The job is registered with cron `5 0 * * *`.

Fixed in the review:

1. **Overlaps were checked to the millisecond, the hours to the minute** (`packages/talent/src/server/timesheets/service.ts`, `checkEntry`). After Time out at 17:00:42, a typed entry from 17:00 was refused as overlapping, though the hours count them as touching. The check now compares whole minutes, like the computation. Test added.
2. **The timesheet touch didn't always serialize** (`service.ts`, `touchTimesheets`; `model.ts` guard). It set `updatedBy` and `updatedAt`; when those already held the same values (the same actor within the same millisecond, and always under the tests' frozen clock), MongoDB skipped the no-op write, so two concurrent overlapping saves could both commit. The touch now also increments `__v`, so it is always a real write, and the guard allows that `$inc` only. A concurrency test (two overlapping saves at once, three rounds: exactly one saves) failed before the fix and passes now; a guard test was added.

Also aligned: talent.md, COMPLIANCE.md, DATA_MODEL.md, TESTING.md and DESIGN_SYSTEM.md now describe the build's choices (seconds dropped, the two-holidays rule, night differential under offset counting scheduled minutes only, the shortened period's pay date, the retired client shown as "Removed client", the serialization, newest-first days, and the read-only page loading with no skeleton). New assumptions 59–61.

Not checked: the screens in a browser (no browser tools here), and `pnpm seed:admin` against a real database.

### 2.4 hands-on checks (by the user, signed in)

1. **The seed.** Run `pnpm seed:admin`: it adds `talent.workSchedule` and `talent.timesheetSettings` (one version each, from 2000-01-01); a second run adds nothing.
2. **The "Done when", on a phone.** As a Driver (Overtime timesheet), open `/talent/timesheet` and add the entries of hand cases 1 (Friday 08:00–19:00, marked: ordinary day 2.0 h) and 5 (08:00–23:30, marked: ordinary day 6.5 h, night differential 1.5 h), and case 7 if 2026-11-30 is a confirmed holiday in the cut-off (holiday 8.0 h + 2.0 h beyond 8). "Overtime by kind" shows each kind. As an office employee (Standard timesheet), add case 10 (07:55 to 19:30, marked): offset 2.6 h, with "Manual" on both times.
3. **Time in and Time out.** Time in shows "Timed in" with the time; a second tap reads Time out, asks for the activity, then saves; both times show without "Manual". Edit one time: that side shows "Manual".
4. **A supervisor's read-only view.** As a supervisor with no Talent access, "My team" on `/talent/timesheet` opens the team member's timesheet: no clock, no Add entry, no edit. Another user gets the no-access page.
5. **Set schedule.** As HR with Talent Write, set an own schedule in the inspector's Work schedule section (it appears in the history, and `/admin/audit` has the `create` entry). HR can't set their own. The employee sees it read-only on `/talent/me`.
6. **The Work schedule settings tab** on `/talent/payroll-settings`: both settings show, and "Add version" works for a Talent Owner in HR.
7. **Light and dark, and phone width (about 390 px):** the timesheet page, the day and entry sheets, the Work schedule section and the settings tab fit with no sideways scroll.

### 2.5 notes

- **Plan.** The planning agent's 19 recommendations were approved as written (the user wants Phase 2 built autonomously). The spec is in [Reimbursements (build step 2.5)](modules/talent.md#reimbursements-build-step-25) and BUILD_PLAN decisions 235–255.
- **Done when:** a second claim with the same merchant TIN and receipt number is rejected, even from another employee.
- **Build order (planned):**
  1. **In parallel:**
     - Core: the `receipt` transform (`packages/core/src/server/files/image-transform.ts`) and `saveUpload`'s `transformImages` (`stored-files.ts`), with tests.
     - Talent pure layer: `packages/talent/src/reimbursements/` (the setting and input schemas, the receipt key, limits, views), the new key in `payroll/schemas.ts`, `seed-data.ts` and `settings.ts`, the 2.3 and 2.4 tests that count the settings, and the exports.
  2. **Talent server, one agent** (they share `policy.ts`, `server/index.ts` and `timesheets/`): `server/receipt-claims/`, `server/reimbursements/`, the timesheet view's reimbursements, the `talent.reimbursement` file registration, the fixtures, and tests.
  3. **In parallel:**
     - Timesheet UI: `timesheet-ui/` (the Reimbursements segment, list, sheet and footer), the two timesheet pages, and `lib/actions/talent-reimbursements.ts`.
     - Settings and lookup UI: the Payroll settings Reimbursements segment, "Check a receipt" on `/talent`, and `lib/actions/talent-receipts.ts`.
  4. **Verification:** typecheck, lint, Prettier, `pnpm test`, the production build, `pnpm seed:admin` twice, and a review of the duplicate check's atomicity, access, the filing window, money as integers, and phone width in light and dark.
  5. **Docs:** HANDOFF, BUILD_SUMMARY, the step's results in TESTING and CHANGELOG; then commit, not push.
- **Spec:** [Reimbursements](modules/talent.md#reimbursements-build-step-25), [DATA_MODEL.md](DATA_MODEL.md#collection-ownership), [Sensitive data](../SECURITY.md#sensitive-data), [Exceptions to module access](../SECURITY.md#exceptions-to-module-access), [File storage](ARCHITECTURE.md#file-storage), [Reimbursement receipts](COMPLIANCE.md#reimbursement-receipts-build-step-25), [Timesheets on a phone](DESIGN_SYSTEM.md#layout--components), [Reimbursement tests](TESTING.md#reimbursement-tests).

### 2.5 review (2026-10-13)

An independent review checked the build against decisions 235–255, talent.md, SECURITY.md, DATA_MODEL.md, TESTING.md and DESIGN_SYSTEM.md. Typecheck, lint, Prettier (the 53 changed files) and `pnpm test` (75 files, 1297 tests) pass. Confirmed as built:

- **The register and the Done when.** `receiptClaims` has a unique partial index on the canonical TIN and the receipt key among live claims. `claimReceipt` and `releaseReceiptClaim` refuse to run outside the caller's transaction, and the write guard allows only the release. Of two saves of one receipt at once, the loser's transaction retries on the write conflict and is then refused (or is refused on the duplicate key), without naming anyone. Deleting a line, or changing its TIN or number, releases the claim in the same transaction.
- **Writes.** Self-service only: the actions need a signed-in user and take no employee id; the services reload the actor and their own employee in the transaction, so another person's line is "not found", HR and the System Administrator included. Every check runs once before the receipt file is saved and again in the transaction (the timesheet open, the filing window from today's version, the type and its required fields from the receipt date's version, a live client, the duplicate, the `version`). Each save touches the timesheet and writes its `create`, `update` or `delete` entry on `talent.reimbursement` in the same transaction.
- **Money.** Amounts and limits are whole centavos end to end: the actions read pesos with `parsePesos`, the schemas and the model refuse anything but safe positive integers, and the per-day sums are integer.
- **Reads and files.** The segment comes on the timesheet view after its access check; the filing window and the types go to the own timesheet only. The `talent.reimbursement` file check needs a live line pointing at that file and the timesheet view rule. Nothing sensitive is logged, and no other module's collections are written. The Payroll settings Reimbursements editor sends the shape `reimbursementSettingsSchema` takes (limits under `amountCentavos`, converted by the action) and keeps every stored type key.

Fixed in the review: three comment lines over the 100-character width (`payroll-settings/service.ts`, `files/registrations.ts`, Core's `files/image-transform.ts`). No code change.

Not checked: the screens in a browser (no browser tools here), the production build, and `pnpm seed:admin` against a real database.

### 2.5 hands-on checks (by the user, signed in)

1. **The seed.** Run `pnpm seed:admin`: it adds `talent.reimbursementSettings` (one version from 2000-01-01); a second run adds nothing.
2. **The "Done when".** As employee A, add a reimbursement on `/talent/timesheet` with a receipt photo. As employee B, add one with the same merchant TIN (typed differently, or as 9 digits) and the same receipt number: it is refused with "This receipt has already been claimed…", without A's name. A's own second try reads "You already claimed this receipt on <date> (<type>)."
3. **Freeing a receipt.** Delete A's line: B can now claim it. `/admin/audit` has the `create` and `delete` entries.
4. **Required fields and the window.** Transportation needs pick-up and drop-off, other a description, every line a receipt; a receipt dated before the previous cut-off or after today is refused.
5. **Limits.** Add a per-day meal limit as a new version on Payroll settings › Reimbursements; two meal lines on one day over it both show "Over limit" and still save.
6. **Read-only views.** A supervisor and Talent Read see the lines and open the receipt on `/talent/timesheets/<employeeId>`; anyone else can't open the receipt's URL. "Check a receipt" on `/talent` finds the claimant.
7. **Light and dark, and phone width (about 390 px):** the Reimbursements segment and its footer, the reimbursement sheet (a phone offers the camera), "Check a receipt" and the settings segment fit with no sideways scroll.

### 2.6 notes

- **Spec.** Written first, on 2026-10-13, with every open question settled by its recommended option (the user wants Phase 2 built autonomously): [Onboarding checklist and change requests (build step 2.6)](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) and BUILD_PLAN decisions 256–276. The unconfirmed choices are assumptions 84–101 below; the build added 102–122. Built and verified on 2026-10-18 (see [2.6 review](#26-review-2026-10-18)).
- **Done when:** a new user skips the checklist and keeps working, but an action gated on the e-signature names the missing item. Check it with `pnpm dev:approval --requester <someone> --step all:<new user's email>`: the new user's Approve is refused with "Complete this onboarding item first: E-signature. Upload it in My record, then try again."
- **What it builds on.**
  - Step 2.1: `employeeRecords` and its section services (`packages/talent/src/server/employee-records/`), the rules in `server/policy.ts` (`canChangeSensitiveDetails` is the verifier rule), and the reveal registration (`server/sensitive/reveals.ts`).
  - Step 2.2: `applyESignature` and `registerTalentApprovalSigner` (`server/e-signatures/service.ts`), which today returns null for no signature; the 201 document and certification services; `employeeNotificationContacts` and `activeHrUserIds` in Core.
  - Step 1.9: the approvals engine (`registerApprovalType`, `submitApproval` with `steps`, `onSettled`, `whenEmpty`, `isApproverFor`) in `packages/core/src/server/approvals/`; `lib/actions/approvals.ts` registers the types and the signer before deciding.
  - Step 2.2's expiry alert setting (`server/expiry-alerts/settings.ts`) is the model for `talent.onboardingSettings` (a version effective today, at most one a day, from Settings on `/talent`), and the step 2.3 seed loader (`server/seed/index.ts`) for its seeding.
  - Step 1.7's "Needs access" rule, for the module access item.
- **Build order (planned).** Each chunk owns the files listed; nothing outside its list.
  1. **In parallel:**
     - **A. Talent pure rules, setting and seed.** Owns `packages/talent/src/onboarding/` (new: the item keys and labels, `onboardingStatus(snapshot)`, progress, `ONBOARDING_GATES`, `checkOnboardingGate`, `assertOnboardingGate`, `OnboardingGateError`, the change request sections and their field lists, the input schemas, the view types, and tests), the new fixed sets in `packages/talent/src/fixed-sets.ts` (`CHANGE_REQUEST_SECTIONS`, `CHANGE_REQUEST_STATUSES`), the exports in `packages/talent/src/index.ts`, `packages/talent/src/server/onboarding/settings.ts` (the `talent.onboardingSettings` setting, its read and its "add version" service), and the new loader in `packages/talent/src/server/seed/index.ts`, with tests. The status function takes a plain snapshot, so it needs nothing from chunk B.
     - **B. Core onboarding facts.** Owns `packages/core/src/server/employees/onboarding-facts.ts` (new: `employeeOnboardingFacts(employeeIds)`), its export from `@pulse/core/server`, and its tests. No other Core change: the engine stays as it is.
  2. **C. Talent server, one agent** (the work shares `server/policy.ts`, `server/index.ts` and the employee record service). Owns:
     - `server/policy.ts`: the verifier, "No supervisor", own-entry, change request approver and viewer rules
     - `server/employee-records/`: the new fields on the model, the own-entry split (blanks saved, the rest handed to change requests), the verification set and clear rules in the existing section saves, "Mark verified" and "No supervisor"
     - `server/change-requests/` (new): the model with its sensitive paths and validator, the service (send, send again, cancel, list own, get with the view rule), `registerTalentApprovalTypes()` with the routing and the `onSettled` hook that applies the change. The service calls `registerTalentApprovalTypes()` itself before submitting
     - `server/onboarding/service.ts` (new): the own and others' status (with the hidden-item rule), and the `/talent` filter and counts
     - `server/e-signatures/service.ts`: the gate in `applyESignature`
     - `server/documents/` and `server/certifications/`: the employee's own upload and add, and the two notifications
     - `server/sensitive/reveals.ts`: `talent.changeRequest`
     - `server/index.ts`, `server/testing/fixtures.ts`, and the tests, the Done when included
  3. **In parallel:**
     - **D. Self-service UI.** Owns `apps/web/app/(pulse)/talent/onboarding/` (new), `apps/web/app/(pulse)/talent/me/` (new files for the own Edit sheets, "Upload document", "Add certification" and the Change requests list), `apps/web/app/(pulse)/talent/change-requests/[id]/` (new), `apps/web/lib/actions/talent-self.ts`, a new `apps/web/lib/actions/talent-change-requests.ts`, the toolbar pill in `apps/web/components/pulse-shell.tsx` (and a new `components/onboarding-progress.tsx`), the Home card in `apps/web/app/(pulse)/page.tsx` and `home-tiles.tsx`, `apps/web/lib/home.ts`, the redirect in `apps/web/app/(auth)/change-password/actions.ts`, and `apps/web/lib/navigation.ts` with its test.
     - **E. HR and approvals UI.** Owns the inspector (`employee-inspector.tsx`, a new `onboarding-section.tsx`), the shared `employee-record-sections.tsx` and `record-ui.tsx` (the verification badge, "Mark verified", and a per-section actions slot that chunk D fills on `/talent/me`: `sectionActions?: Partial<Record<'personal' | 'governmentIds' | 'bankAccount' | 'skills', ReactNode>>`), `employees-manager.tsx` and `page.tsx` on `/talent` (the onboarding filter and tiles), the Settings sheet's "Required onboarding documents", `apps/web/lib/actions/talent.ts`, and `apps/web/app/(pulse)/approvals/` with `apps/web/lib/actions/approvals.ts` (the gate notice, the change request lines, and `registerTalentApprovalTypes()` beside the signer).
  4. **Verification:** typecheck, lint, Prettier, `pnpm test`, the production build, `pnpm seed:admin` twice, and a review of the sensitive paths (no value in titles, summaries, notifications, logs or the checklist), the role re-check at decision, the gate's rollback, self-service taking no employee id, and phone width in light and dark.
  5. **Docs:** HANDOFF, BUILD_SUMMARY, the step's results in TESTING and CHANGELOG; then commit, not push.
- **Spec:** [Onboarding (first sign-in)](modules/talent.md#onboarding-first-sign-in), [Self-service & record changes](modules/talent.md#self-service--record-changes), [Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26), [Sensitive data](../SECURITY.md#sensitive-data), [Exceptions to module access](../SECURITY.md#exceptions-to-module-access), [Approvals](modules/core.md#approvals), [People data ownership](modules/core.md#people-data-ownership), [DATA_MODEL.md](DATA_MODEL.md#collection-ownership), [Feedback & motion](DESIGN_SYSTEM.md#feedback--motion), [Onboarding and change request tests](TESTING.md#onboarding-and-change-request-tests).

### 2.6 review (2026-10-18)

Built in the planned chunks (A and B in parallel, then C, then D and E in parallel), then verified and reviewed by separate agents. Typecheck, lint, Prettier, `pnpm test` (82 files, 1394 tests), the production build (`next build`) and `pnpm seed:admin` run twice (the second run adds nothing) pass. The security review of the sensitive paths, the role re-check at decision, the gate's rollback and self-service taking no employee id found nothing to fix. Worth knowing:

- **Approval types in one place.** The new `apps/web/lib/approval-types.ts` registers Core's approval types, `talent.changeRequest` and the Talent signer, and every Approvals read and decide calls it, so the e-signature gate and the change request hook run whichever page decides (item 116). It has its own test.
- **A `status` slot in the shell.** `packages/ui`'s `AppShell` and `TopToolbar` take a new optional `status` slot, before the bell, which holds the onboarding progress pill (item 119).
- **New code.** `packages/talent/src/onboarding/` (the items, progress and `ONBOARDING_GATES`), `server/onboarding/`, `server/change-requests/`, the own-entry split in `server/employee-records/` (`own.ts`, `write.ts`), Core's `employeeOnboardingFacts`, and the pages `/talent/onboarding` and `/talent/change-requests/<id>`.
- **Choices made during the build** are assumptions 102–122 in [Assumptions to check](#assumptions-to-check).

Not checked: the screens in a browser (no browser tools here).

### 2.6 hands-on checks (by the user, signed in)

1. **The seed.** On an existing development database, run `pnpm seed:admin` again: it adds `talent.onboardingSettings` (government ID copy and NBI clearance); a second run adds nothing.
2. **The "Done when".** Create a new user and sign in as them; after the temporary password change, `/talent/onboarding` opens. Skip it and keep working (open the timesheet, add a time entry). Then run `pnpm dev:approval --requester <someone> --step all:<new user's email>` and try Approve on `/approvals` as the new user: it is refused, naming "E-signature" ("Complete this onboarding item first: E-signature. Upload it in My record, then try again."), and the request stays pending. Upload an e-signature and approve again: it succeeds, signed.
3. **The checklist** on `/talent/onboarding`: the items, their To do, "Waiting for HR to verify" and done states, and each To do row's action.
4. **The toolbar pill and the Home card.** The pill shows the progress (it shortens to "5/8" on a phone); the Home card shows until the employee items are done or waiting for HR.
5. **My record** (`/talent/me`): the Edit sheets (filling an empty field saves at once; changing a filled one sends a change request), "Upload document", "Add certification", and the Change requests list.
6. **A change request** on `/talent/change-requests/<id>`: as the approver, approve, return and reject from `/approvals`; on a returned one, "Edit and send again" and Cancel. The record changes only on approve.
7. **The inspector's Onboarding section** on `/talent`: "Mark verified" on a complete government IDs or bank group, and "Confirm no supervisor" for an employee with none.
8. **`/talent`**: the two onboarding tiles and the Onboarding filter (HR and the System Administrator only), and Settings › Required onboarding documents.
9. **The Approvals gate notice** for an approver with no e-signature.
10. **Light and dark, and phone width (about 390 px):** `/talent/onboarding`, the pill, the Home card, the `/talent/me` sheets, the change request page and the inspector's Onboarding section fit with no sideways scroll.

### 2.7 notes

- **Spec.** Written first, on 2026-10-18, with every open question settled by its recommended option (the user wants Phase 2 built autonomously): [Timesheet approval, the DTR and the offset balance (build step 2.7)](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27) and BUILD_PLAN decisions 277–298. The unconfirmed choices are assumptions 123–137 below. **Not built yet.**
- **Done when:** on a phone, a returned Standard timesheet is resubmitted, approved by a supervisor and HR, locked, and its offset hours credited. Check it with a Standard employee whose cut-off has ended (set `?cutOff=` to a past cut-off, or a test clock): submit, return as the supervisor on `/approvals`, fix an entry and resubmit, approve as the supervisor, then as HR; the timesheet reads "Approved · Locked" and the Offset card "Credited +X h".
- **Settled while writing the spec** (worth the user's eye):
  - **The DTR stays derived, never stored** (decision 288). Step 2.4 decided hours are derived when read, and the "Derived values" table says the same, while the step text says "recompute periods not yet finalized". Both hold: every non-finalized period is always current, and the holidays-changed listener recomputes the one stored value derived from the DTR, the offset credits (decision 292). Step 2.9's payroll run stores the figures it paid.
  - **The deadline needs no new seeded version** (decision 279). Decision 216 said step 2.7 "adds the submission deadline in a later version", but `pnpm seed:admin` never adds to a setting that already has a version, so the field reads 1 when absent.
  - **Late timesheets are accepted** (decision 280). The spec's "after the cut-off ends" with a 1-day deadline leaves a one-day window; refusing late ones would lose overtime and offset.
- **What it builds on.**
  - Step 2.4: `packages/talent/src/timesheets/` (`computeDay`, `computeTimesheet`, `scheduleOn`, `versionOn`; `TIMESHEET_STATUSES` is `['open']` in `schemas.ts`), `server/timesheets/` (`model.ts` with the write guard and the touch, `service.ts` with `TIMESHEET_NOT_OPEN` and `buildView`, `periods.ts`, `open-job.ts`), and `canViewTimesheet` in `server/policy.ts`.
  - Step 2.5: `server/reimbursements/service.ts` (its open check) and `server/receipt-claims/`.
  - Step 2.6: `ONBOARDING_GATES.fileTimeRequest` and `assertOnboardingGate` (`packages/talent/src/onboarding/gates.ts`), the own status in `server/onboarding/service.ts`, and `registerTalentApprovalTypes()` in `server/change-requests/service.ts`, which `apps/web/lib/approval-types.ts` already calls.
  - Core: the approvals engine (`registerApprovalType` with `onStepApproved`, `submitApproval`, `isApproverFor`) in `packages/core/src/server/approvals/`, `registerHolidaysChangedListener` in `packages/core/src/server/holidays/events.ts` (the worker's `core.holidaysChanged` handler already runs the listeners), `notify`, `activeHrUserIds`, `listConfirmedHolidays`. **No Core change is planned.**
  - Step 2.2's expiry alert job (`server/expiry-alerts/`, `scripts/dev-expiry-alerts.ts`) is the model for the reminder job and its dev script.
- **Build order (planned).** Each chunk owns the files listed; nothing outside its list. Chunks on the same line run in parallel and touch no common file.
  1. **In parallel:**
     - **A. DTR pure rules.** Owns the new `packages/talent/src/dtr/` only: `DTR_DAY_STATUSES` and labels, `computeDtr` (day statuses, late, undertime, night differential, overtime or offset, `final`, totals, with a `timeOff` input left empty until step 2.8), its view types, its `index.ts`, and `dtr.test.ts` with cases D1–D12. It reads `timesheets/compute.ts` and `schedule.ts` but doesn't edit them; anything more it needs from the entries it works out itself.
     - **B. Statuses, deadline and offset pure rules, and the setting.** Owns `packages/talent/src/timesheets/schemas.ts` (`TIMESHEET_STATUSES`, labels, editable statuses, `submissionDeadlineDays` defaulting to 1), a new `timesheets/submission.ts` (the deadline, the opening day, "Submitted late", the allowed moves, the reminder days) with its test, `timesheets/views.ts` (the banner, submit summary, list row and DTR segment views) and `timesheets/index.ts`, the new `packages/talent/src/offset/` (`OFFSET_ENTRY_KINDS`, the balance sum, the reconcile difference, views, tests), `packages/talent/src/index.ts` (its exports, and `export * from './dtr'` for chunk A), and `server/payroll-settings/seed-data.ts` with the payroll settings tests that check the `talent.timesheetSettings` value.
  2. **C. Talent server, one agent** (the work shares `server/policy.ts`, `server/index.ts` and the timesheet service). Owns:
     - `server/timesheets/`: `model.ts` (the new fields, the `{ periodStart, status }` index, the guard allowing the status fields), `service.ts` (entry saves allowed only while `open` or `returned`, with the two messages; the view's status, banner, approver access, offset balance, DTR segment and My team status), new `submission.ts` (submit and resubmit), new `approval.ts` (`talent.timesheet` with `onStepApproved` and `onSettled`), new `list.ts` (the timesheets list and its counts), new `reminders.ts` (`TIMESHEET_REMINDERS_JOB`, its schedule and `runTimesheetReminders(at)`)
     - new `server/offset/` (the `offsetEntries` model, the credit, `reconcileOffsetCredits(dates)`, `getOffsetBalance`) and new `server/dtr/` (`getDtr`, and `registerTalentHolidaysChangedListener()` for `talent.recomputeDtr`)
     - `server/reimbursements/service.ts` (open or returned), `server/change-requests/service.ts` (only to register `talent.timesheet` in `registerTalentApprovalTypes()`), `server/policy.ts` (the approver view rule), `server/index.ts`, `server/testing/fixtures.ts`, and the tests, the Done when and D13–D14 included
  3. **In parallel:**
     - **D. Worker and dev script.** Owns `apps/worker/src/talent-jobs.ts` and its test (the reminder job and schedule, and the listener registered at start-up, or in `apps/worker/src/main.ts` if it must run before the handlers), a new `scripts/dev-timesheet-reminders.ts`, and its line in the root `package.json`.
     - **E. Timesheet UI.** Owns `apps/web/app/(pulse)/talent/timesheet-ui/` (the status banner, Submit and its confirmation sheet, the DTR segment, the Offset card's balance and credit line, the footer, My team status, the approver's "Open in Approvals"), `apps/web/app/(pulse)/talent/timesheet/page.tsx`, `apps/web/app/(pulse)/talent/timesheets/[employeeId]/page.tsx`, and `apps/web/lib/actions/talent-timesheets.ts`.
     - **F. Timesheets list and settings UI.** Owns the new `apps/web/app/(pulse)/talent/timesheets/page.tsx` and a new `apps/web/app/(pulse)/talent/timesheets-list/` folder for its parts, the "Timesheets" button in `apps/web/app/(pulse)/talent/page.tsx`, the deadline field in the Work schedule segment under `apps/web/app/(pulse)/talent/payroll-settings/`, `apps/web/lib/actions/talent-payroll.ts`, and `apps/web/lib/navigation.ts` with its test (`/talent/timesheets` as "Timesheets", keeping `/talent/timesheets/<id>` as "Timesheet").
  4. **Verification:** typecheck, lint, Prettier, `pnpm test`, the production build, `pnpm seed:admin` twice (it adds nothing new for 2.7), and a review of the status moves and the lock (no write path on a pending or approved timesheet), the credit's idempotence, the listener's reconcile, self-service taking no employee id, approver access, and phone width in light and dark.
  5. **Docs:** HANDOFF, BUILD_SUMMARY, the step's results in TESTING, CHANGELOG, and AGENTS.md (the `pnpm dev:timesheet-reminders` command and the new tests in the `pnpm test` list); then commit, not push.
- **Spec:** [Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27), [Submission & approval](modules/talent.md#submission--approval), [Daily Time Record (DTR)](modules/talent.md#daily-time-record-dtr), [Offset balance & offset time off](modules/talent.md#offset-balance--offset-time-off), [Reporting lines](modules/core.md#reporting-lines), [Approvals](modules/core.md#approvals), [Holiday calendar](modules/core.md#holiday-calendar), [Attendance and the DTR](COMPLIANCE.md#attendance-and-the-dtr-build-step-27), [DATA_MODEL.md](DATA_MODEL.md#collection-ownership), [Exceptions to module access](../SECURITY.md#exceptions-to-module-access), [Background jobs](ARCHITECTURE.md#background-jobs), [Timesheets on a phone](DESIGN_SYSTEM.md#layout--components), [Timesheet approval, DTR and offset tests](TESTING.md#timesheet-approval-dtr-and-offset-tests).

## Assumptions to check

Things the build assumed that a person still has to confirm or do. Later Phase 2 steps add to this list. Items 27–34 note how far each seeded rate was verified online on 2026-10-12. Nothing here blocks the build. Check each item before HR enters real employee data, or before go-live where it says so.

| # | Assumption or action | Step | Who confirms | Where it lives |
|---|---|---|---|---|
| 1 | **Date of birth and civil status** (RA 10173 Section 3(l): age and marital status are sensitive personal information). They are limited to HR, Accounting, the System Administrator and the employee, kept out of the list, and not encrypted. They appear in audit snapshots, which only the System Administrator can browse. Confirm this is enough, or whether they must be encrypted too. *Assumption, to be confirmed by HR or counsel* | 2.1 | HR, counsel | [Sensitive data](../SECURITY.md#sensitive-data), [COMPLIANCE.md](COMPLIANCE.md#data-privacy-act-of-2012-ra-10173) |
| 2 | **ID and account formats.** The app assumes these, all stored as digits. *Assumption, to be confirmed by HR or counsel.*<ul><li>TIN: 9, 12 or 14 digits (BIR's 5-digit branch code)</li><li>SSS: 10 digits</li><li>PhilHealth PIN: 12 digits</li><li>Pag-IBIG MID: 12 digits</li><li>UnionBank and RCBC account numbers: 10 to 16 digits</li><li>Mobile numbers: 11 digits starting with `09`</li><li>Work region: one of 18 regions, NIR included</li></ul> | 2.1 | HR, the banks | [The employee record](modules/talent.md#the-employee-record-build-step-21) |
| 3 | **Key rotation tooling.** Nothing re-wraps the data keys for a new `FIELD_ENCRYPTION_LOCAL_KEY` yet. Decide whether to build a tool before go-live, and how often to rotate | 2.1 | The project owner | [DEPLOYMENT › Still to decide](DEPLOYMENT.md#still-to-decide) |
| 4 | **Production `FIELD_ENCRYPTION_LOCAL_KEY`.** Generate it on the real server before any real employee data is entered, and keep an offline copy outside the server. Never put real data in a development database or under a development key | Before real data | The project owner | [Secrets](../SECURITY.md#secrets), [Runbook](RUNBOOK.md#encryption-key-lost-or-changed) |
| 5 | **Browser-check setup for 2.1.** A role grants no module access, so on `/admin/access`:<ul><li>give the HR test user Talent Read or Write</li><li>create a user outside HR, Accounting and the Board with Talent Write, for the "sees none of the sensitive fields" check</li></ul>Then check the reveal in `/admin/audit` as the System Administrator | 2.1 | The user | [User access page](modules/core.md#user-access-page) |
| 6 | **A save that changes nothing** still raises the record's `version` and writes an `update` audit entry, as the 1.4 and 1.8 services do. Confirm that, or say whether it should write nothing, as the access setter and reporting lines do | 2.1 | The user | [The employee record](modules/talent.md#the-employee-record-build-step-21) |
| 7 | **"Not filled in" and salary entries.** An employee with only a salary entry shows "Not filled in" to anyone who may not see Compensation (Talent Write or Read alone, or the Board outside HR), so the badge never says a salary is stored. Confirm that is acceptable | 2.1 | The user | [The employee record](modules/talent.md#the-employee-record-build-step-21) |
| 8 | **"Manage access" and "Edit in Users" on your own record.** HR and the System Administrator see both on their own record. The access and users pages open that row read-only | 2.1 | The user | [The employee record](modules/talent.md#the-employee-record-build-step-21) |
| 9 | **Medical certificates are hidden from Accounting.** SECURITY's reveal table gave Accounting every category, but the medical certificate rule leaves Accounting out. The app now follows the medical rule. *Assumption, to be confirmed by HR or counsel* (RA 10173) | 2.2 | HR or counsel | [Sensitive data](../SECURITY.md#sensitive-data) |
| 10 | **The 201 document types** (employment contract, regularization evaluation, government ID copy, NBI clearance, medical certificate, diploma or TOR, other), and that every document needs an issue date. *Assumption, to be confirmed by HR* | 2.2 | HR | [Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22) |
| 11 | **Uploaded e-signature images are legally enough** for approvals now, and for HR documents, contracts and the other signed documents later (RA 8792, the E-Commerce Act; the Rules on Electronic Evidence). *Assumption, to be confirmed by counsel* | 2.2 | Counsel | [COMPLIANCE › Open questions](COMPLIANCE.md#open-questions) |
| 12 | **201 documents are kept forever**, archived but never erased, separated employees' included. *Assumption, to be confirmed by counsel* (Data Privacy Act proportionality) | 2.2 | Counsel | [Record retention](COMPLIANCE.md#record-retention) |
| 13 | **Profile photos are shown to every employee**, with no consent beyond the company's privacy notice. *Assumption, to be confirmed by HR or counsel* | 2.2 | HR or counsel | [Data Privacy Act](COMPLIANCE.md#data-privacy-act-of-2012-ra-10173) |
| 14 | **Stored files aren't encrypted by the app.** Production must keep `storage/` (201 files, medical certificates) on an encrypted disk or volume, and back it up with the database and the key. *Assumption, to be confirmed by the project owner* | Before real data | The project owner | [DEPLOYMENT › Still to decide](DEPLOYMENT.md#still-to-decide) |
| 15 | **Expiry alert defaults.** 30 days ahead plus one "expired" alert. Documents go to HR and the employee; certifications also to the employee's supervisors; the System Administrators when no HR user is active. *Assumption, to be confirmed by HR* | 2.2 | HR | [Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22) |
| 16 | **Skills are free-text tags** (up to 30, 50 characters each), since the spec names skills but gives no fields. *Assumption, to be confirmed by HR* | 2.2 | HR | [Skills & certifications](modules/talent.md#skills--certifications) |
| 17 | **Approvals before a signature is uploaded stay unsigned.** An approver with no e-signature still approves until step 2.6's gate, and the bootstrap system account never signs. *Assumption, to be confirmed by the user*. **Superseded from step 2.6** by item 89: the gate refuses such an approve; only the system account still approves unsigned | 2.2 | The user | [Approvals](modules/core.md#approvals) |
| 18 | **Browser-check setup for 2.2.** On `/admin/access`, give the HR test user Talent Write, give an Accounting user Talent Read, make one user Talent Owner, and give an employee a supervisor. Then check the "Done when" with `pnpm dev:approval` (approve, replace the signature on `/talent/me`, approve another) and `pnpm dev:expiry-alerts` | 2.2 | The user | [TESTING.md](TESTING.md#document-e-signature-and-certification-tests) |
| 19 | **Removing a certification is refused on your own record**, even for a Talent Owner, like every other change to your own record | 2.2 | The user | [Skills & certifications](modules/talent.md#skills--certifications) |
| 20 | **An archived 201 document can't be edited** (or archived again). To correct one, add a new document | 2.2 | HR | [Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22) |
| 21 | **A certification's issue date may be in the future**, unlike a 201 document's | 2.2 | HR | [Skills & certifications](modules/talent.md#skills--certifications) |
| 22 | **A renewal archives the document it replaces with the fixed reason** "Replaced by a renewed document." | 2.2 | HR | [Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22) |
| 23 | **Expiry alert wording, and one alert per person.** "NBI clearance expiring: <name>", "Your NBI clearance expires on <date>" with "Send HR the renewed copy so they can update your record." Someone with two roles gets one alert: the employee's own link first, then HR's record link, then the supervisor's directory link | 2.2 | HR | [Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22) |
| 24 | **The certification read services use the directory's idea of active**: an employee whose account doesn't resolve to active (separated, or with no user) is left out | 2.2 | The user | [Skills & certifications](modules/talent.md#skills--certifications) |
| 25 | **The inspector's photo actions need Talent Read**, like the inspector. HR without Talent Read changes no one's photo there | 2.2 | The user | [Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22) |
| 26 | **Approvals decided before step 2.2** show "Approved without an e-signature", since they have no signature field | 2.2 | The user | [Approvals](modules/core.md#approvals) |
| 27 | **SSS schedule:** MSC ₱5,000–₱35,000 in ₱500 steps, 15% (employee 5%, employer 10%), regular SS up to ₱20,000 then MPF, EC ₱10 or ₱30, from SSS Circular No. 2024-006 (2025-01-01). **Verified (official):** still the latest schedule on sss.gov.ph on 2026-10-12; the rows weren't re-read line by line. *Assumption, to be confirmed by HR or the accountant* | 2.3 | HR, the accountant | [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23) |
| 28 | **PhilHealth:** 5% of the monthly basic salary, half each, floor ₱10,000, ceiling ₱100,000 (from 2024-01-01). **Verified (official) for 2025** (Advisory No. 2025-0002). 2026 is unchanged per secondary sources; Advisory No. 2026-0042 couldn't be read. *Assumption, to be confirmed by HR or the accountant* | 2.3 | HR, the accountant | [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23) |
| 29 | **Pag-IBIG:** employee 1% up to ₱1,500 and 2% above, employer 2%, maximum fund salary ₱10,000 (HDMF Circular No. 460, from 2024-02-01). **Verified (secondary):** PNA and payroll guides; no 2026 change found. *Assumption, to be confirmed by HR or the accountant* | 2.3 | HR, the accountant | [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23) |
| 30 | **BIR semi-monthly withholding table** (RR 11-2018 Annex E, from 2023-01-01). **Verified (secondary):** payroll guides confirm it still applies in 2026; the BIR text wasn't re-read. *Assumption, to be confirmed by the accountant* | 2.3 | The accountant | [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23) |
| 31 | **NCR minimum wage:** NCR-26 ₱695 from 2025-07-18, and NCR-28 ₱755 from 2026-09-26 (non-agriculture). **NCR-28 verified (official, NWPC); NCR-26's date is secondary.** NCR-27 isn't seeded (enjoined, then replaced; still before the Supreme Court). If the Court revives it, HR adds a version. *Assumption, to be confirmed by HR or counsel* | 2.3 | HR, counsel | [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23) |
| 32 | **De minimis limits per RR 29-2025** (from 2026-01-06):<ul><li>rice ₱2,500 a month</li><li>uniform ₱8,000 a year</li><li>dependents' medical cash allowance ₱2,000 a semester</li><li>medical assistance ₱12,000 a year</li><li>laundry ₱400 a month</li><li>achievement awards ₱12,000 a year</li><li>gifts ₱6,000 a year</li><li>overtime meals 30% of the minimum wage</li><li>CBA and productivity ₱12,000 a year</li></ul>**Verified (secondary):** Grant Thornton and other firms; the RR text wasn't read. *Assumption, to be confirmed by the accountant* | 2.3 | The accountant | [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23) |
| 33 | **13th month and other benefits ceiling ₱90,000** (RA 10963). **Verified (secondary):** unchanged; House Bill 7661 (₱150,000) is pending. *Assumption, to be confirmed by the accountant* | 2.3 | The accountant | [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23) |
| 34 | **Premium rates** as written in talent.md: 200/100%, 130/0%, 130%, 150%, 260%, overtime +25% and +30%, night differential +10% from 10:00 PM to 6:00 AM. **Not re-checked** (spec values). Check this year's DOLE holiday pay advisory. *Assumption, to be confirmed by HR or the accountant* | 2.3 | HR, the accountant | [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23) |
| 35 | **Pay dates don't move** for weekends or holidays (the 15th, and the 30th or the last day of a shorter month). *Assumption, to be confirmed by HR* | 2.3 | HR | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 36 | **Daily rate factor 261, 8 hours a day, and contributions split half in each cut-off** (spec defaults, seeded as company policy). *Assumption, to be confirmed by HR or the accountant* | 2.3 | HR, the accountant | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 37 | **The internet allowance is non-taxable** (₱500 per cut-off, automatic from the date hired). The spec says so, but an internet allowance isn't on BIR's de minimis list. *Assumption, to be confirmed by the accountant* | 2.3 | The accountant | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 38 | **The minimum wage check** uses the general (non-agriculture) rate and the later of the effective date and today. The list of employees below a wage order shows no amounts, is limited to HR, Accounting and the System Administrator, and isn't audit-logged. *Assumption, to be confirmed by HR* | 2.3 | HR | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 39 | **The contribution basis** is left to the payroll run step. Recommended: PhilHealth on the monthly basic salary; SSS and Pag-IBIG on the month's total taxable compensation. *Assumption, to be confirmed by the accountant* | 2.3 | The accountant | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 40 | **Not seeded:** double holidays (300%), special working days, and the lower minimum wage for agriculture and small retail, service and manufacturing employers (₱718 in NCR), since the spec doesn't list them. *Assumption, to be confirmed by HR or the accountant* | 2.3 | HR, the accountant | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 41 | **Versions can't be withdrawn.** A wrong payroll settings version is replaced from a later date ([RUNBOOK](RUNBOOK.md#a-wrong-payroll-settings-version-was-added)). Company policy and the premium rates are seeded from 2000-01-01 so they cover every date hired | 2.3 | The user | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 42 | **Allowances and the date hired.** No allowance applies before the date hired, automatic or assigned. An automatic type applies only while it is active in that day's allowance types version. Nothing stops the automatic internet allowance at a separation date yet; the payroll run and final pay steps decide that. *Assumption, to be confirmed by HR* | 2.3 | HR | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 43 | **Contribution rounding.** PhilHealth: the premium rounded half-up once, the employee's half rounded half-up, the employer the remainder. Pag-IBIG: each share rounded half-up on its own. The agencies' own rounding wasn't checked. *Assumption, to be confirmed by the accountant* | 2.3 | The accountant | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 44 | **The minimum wage warning shows the daily rate rounded down** to the centavo (₱16,421.24 a month shows ₱754.99 against ₱755.00), so it never reads as the minimum itself. The comparison stays exact. Changed in the review | 2.3 | HR | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 45 | **Edge cases left as built:** a monthly salary is refused, not warned, when no pay schedule is on file (only before `pnpm seed:admin` has run). The seed adds a setting's versions only when it has none, so if a run stopped between NCR-26 and NCR-28, a later run wouldn't add NCR-28; HR would add it on the page. A version counts as "Seeded" when its date and source match the seed's exactly | 2.3 | The user | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23) |
| 46 | **The seeded break is 12:00 to 13:00.** The spec says only "a 1-hour break". The break window is deducted wherever entries overlap it, on any day, even when the employee works through it (unpaid break) | 2.4 | HR | [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) |
| 47 | **How "beyond the schedule" is measured.** Extra hours on an ordinary day are the worked minutes beyond the scheduled minutes, taken as the day's last minutes. Arriving early counts only through the day's total, and a late start made up at the end of the day earns none (Labor Code Arts. 87–88) | 2.4 | HR, counsel | [Timesheet hours](COMPLIANCE.md#timesheet-hours-build-step-24) |
| 48 | **Rest-day and holiday work on the Overtime timesheet** counts only when the employee marks it with a reason, as the spec says for the Standard timesheet | 2.4 | HR, counsel | [Timesheet hours](COMPLIANCE.md#timesheet-hours-build-step-24) |
| 49 | **Local holidays aren't applied** to anyone yet, since no employee has a work location; they show on the day as information. Only confirmed nationwide holidays count | 2.4 | HR | [Holiday calendar](modules/core.md#holiday-calendar) |
| 50 | **An entry past midnight belongs to the day it started** and takes that day's kind. DOLE practice splits holiday hours by calendar day, so check this before night work on a holiday eve is paid (step 2.9) | 2.4 | HR, the accountant | [Timesheet hours](COMPLIANCE.md#timesheet-hours-build-step-24) |
| 51 | **No minimum overtime block** and no rounding to 15 or 30 minutes. Hours come from exact minutes and show to 0.1 h | 2.4 | HR | [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) |
| 52 | **Night differential** uses the `talent.premiumRates` night window and `payrollSettings.hoursPerDay`. It counts paid minutes only and shows on the Overtime timesheet only; the DTR (step 2.7) also counts it for Standard employees' paid night hours | 2.4 | HR, the accountant | [Timesheet hours](COMPLIANCE.md#timesheet-hours-build-step-24) |
| 53 | **The offset ratio is 1:1** (seeded `talent.timesheetSettings.offsetRatio` `"1"`), and offset minutes are rounded half-up to the minute | 2.4 | HR | [DATA_MODEL.md](DATA_MODEL.md#versioned-configuration) |
| 54 | **HR can't correct an employee's time entries** in step 2.4. Corrections come through "return with remarks" in step 2.7 | 2.4 | HR | [Exceptions to module access](../SECURITY.md#exceptions-to-module-access) |
| 55 | **A timesheet created after its cut-off started** (a new hire, or a missed job run) takes the position's type on the day it is created, recorded in `typeReadOn` | 2.4 | HR | [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) |
| 56 | **The offset balance shows 0.0 h** until the credit and usage entries (step 2.7) and the opening balances (step 2.8) exist | 2.4 | HR | [Offset balance & offset time off](modules/talent.md#offset-balance--offset-time-off) |
| 57 | **Clock times come from the server's clock.** Manual times have no limit beyond "not in the future", "no overlap", "at most 24 hours" and the employment dates; approvers see them flagged | 2.4 | HR | [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) |
| 58 | **Supervisors see their direct reports' timesheets read-only from step 2.4**, outside module access, before they approve them in step 2.7. They get only directory fields about the employee | 2.4 | HR, counsel | [Exceptions to module access](../SECURITY.md#exceptions-to-module-access) |
| 59 | **A supervisor can work out a team member's date hired** when it falls in a cut-off they open: the day list starts at the date hired, the previous cut-off button stops there, and an earlier `?cutOff=` is not found. The date itself is never sent. Accepted, as the supervisor works with the employee | 2.4 | HR, counsel | [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) |
| 60 | **One concurrency case is left open:** two saves at once (two devices) of overlapping entries on either side of a cut-off boundary, when neither cut-off has a timesheet yet, could both save. The daily job creates each cut-off's timesheet at 00:05, so this needs a missed run as well | 2.4 | The user | [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) |
| 61 | **Opening one's own past cut-off creates its timesheet** if none exists, with the position's type that day (as in item 55), so browsing back writes timesheets. Another person's view never creates one | 2.4 | HR | [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24) |

| 62 | **A merchant TIN with no branch code is the head office** (`00000`), and the branch code is part of the duplicate key, because invoice series are registered per branch | 2.5 | Accountant | [Reimbursement receipts](COMPLIANCE.md#reimbursement-receipts-build-step-25) |
| 63 | **Receipt numbers match ignoring case, separators and leading zeros** (`or-000123` and `OR 123` are the same receipt). The separators go first, then the leading zeros of each run of digits at the start or after a letter, keeping one digit: `SI-0042` is `SI42` and `0000` is `0`, but `2026-0001` is `20260001` (a zero after a digit is kept, even across a dash) | 2.5 | Accountant | [Reimbursement receipts](COMPLIANCE.md#reimbursement-receipts-build-step-25) |
| 64 | **Invoices count as receipts** under RA 11976 (EOPT Act) and RR 7-2024; the field reads "Receipt or invoice number" | 2.5 | Accountant | [Reimbursement receipts](COMPLIANCE.md#reimbursement-receipts-build-step-25) |
| 65 | **The app doesn't check that a receipt is made out to the company**, though that may be needed for the reimbursement to stay non-taxable and deductible | 2.5 | Accountant | [Reimbursement receipts](COMPLIANCE.md#reimbursement-receipts-build-step-25) |
| 66 | **No limits are seeded** for meal, transportation or other; HR adds them as a new `talent.reimbursementSettings` version | 2.5 | HR | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 67 | **The filing window counts from the line's timesheet**, one previous cut-off by default. Until step 2.7 adds statuses, every timesheet stays open, so lines on older timesheets can still be edited | 2.5 | HR | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 68 | **A duplicate is rejected when the line is saved**, not only on submission; step 2.7 checks again at submission | 2.5 | HR | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 69 | **Deleting a line frees its receipt** for anyone to claim, as does changing its TIN or number | 2.5 | HR, accountant | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 70 | **The client is optional on every seeded type** (a type can require it) | 2.5 | HR | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 71 | **Receipts and routes aren't sensitive personal information**: not encrypted. Pick-up and drop-off can show a home address, and supervisors see them | 2.5 | HR, counsel | [Sensitive data](../SECURITY.md#sensitive-data) |
| 72 | **Receipt views aren't audit-logged**; receipt photos are re-encoded with GPS and other metadata stripped | 2.5 | HR, counsel | [File storage](ARCHITECTURE.md#file-storage) |
| 73 | **A ride with no receipt** (jeepney, tricycle) can't be claimed: every type needs a receipt, a merchant TIN and a number | 2.5 | HR, accountant | [Reimbursement receipts](COMPLIANCE.md#reimbursement-receipts-build-step-25) |
| 74 | **The other claimant is never named** to an employee whose receipt is rejected; Talent Read finds them with "Check a receipt" | 2.5 | HR, counsel | [RUNBOOK](RUNBOOK.md#a-receipt-was-rejected-as-a-duplicate) |
| 75 | **Pick-up and drop-off are kept only when the type requires the route.** On any other type they are stored empty, even if typed; the description is kept whenever it is given | 2.5 | HR | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 76 | **The filing window and the type list go to the employee's own timesheet only.** Talent Read and supervisors see the lines read-only without the window, because the window starts at the date hired (as in item 59) | 2.5 | HR, counsel | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 77 | **A receipt file can be left unused.** The file is saved before the save's transaction (the checks run once before it). When a save is refused after that, for example when another employee claims the same receipt at the same moment, the file stays in storage but never opens, since no live line points at it | 2.5 | The project owner | [File storage](ARCHITECTURE.md#file-storage) |
| 78 | **"Add version" on Reimbursements keeps every stored type.** The sheet starts from the version in effect plus any type only a scheduled version has, since the service refuses a version that drops a key of any stored version. Those types' keys are fixed and they can't be removed in the sheet. The allowance types sheet still starts from the version in effect alone | 2.5 | The user | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 79 | **The reimbursement settings are company policy**, so the "Add version" sheet's date and source hints are the policy ones (any day of the week; "the policy or memo behind the change"), as for the work schedule. The seeded version still shows the shared "Seeded: check against the current issuance" note | 2.5 | HR | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 80 | **"Check a receipt" is a header button and sheet on `/talent`**, for everyone who can open the page (Talent Read). The result names the canonical TIN and receipt key it is for, plus the claimed-on date, and clears when a field is edited | 2.5 | The user | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 81 | **The receipt field has no camera-only button.** It is one native file field with no `capture` attribute, as DESIGN_SYSTEM says, so a phone offers the camera and the files in one picker | 2.5 | The user | [Timesheets on a phone](DESIGN_SYSTEM.md#layout--components) |
| 82 | **"Open receipt" on a PDF downloads it** (the file route serves only images inline, and its sandboxed CSP would block a browser's PDF viewer), so a phone opens it in its own viewer; a photo opens in a new tab | 2.5 | The user | [File storage](ARCHITECTURE.md#file-storage) |
| 83 | **The reimbursement sheet's fields follow today's types.** Which fields are required (pick-up and drop-off, description, client) comes from the version in effect today; the server checks the version in effect on the receipt date. A receipt date in a cut-off before a new version could show the newer rules until the save says otherwise. The add sheet's date starts at the window's last day | 2.5 | HR | [Reimbursements](modules/talent.md#reimbursements-build-step-25) |
| 84 | **The checklist's required fields.** Personal info: date of birth, sex, civil status, nationality, both addresses and the mobile number (the personal email is optional). Emergency contact: name, relationship and mobile number. Government IDs: TIN, RDO code, SSS, PhilHealth PIN and Pag-IBIG MID. Bank: bank, account number and account name | 2.6 | HR | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 85 | **Required onboarding documents** are seeded as a government ID copy and an NBI clearance (`talent.onboardingSettings`); the spec names "201 documents" without a list. A Talent Owner changes the list | 2.6 | HR | [Versioned configuration](DATA_MODEL.md#versioned-configuration) |
| 86 | **The `reportingTo` item** is done with an active supervisor, for a Board member, or once HR, a Board member or the System Administrator confirms "No supervisor". Without it, the step 2.7 and 2.8 gate blocks timesheet submission, leave and offset time off for an employee nobody has given a supervisor | 2.6 | HR, the user | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 87 | **Work schedule and work region count as done by default** (the company schedule and NCR), so HR isn't asked to confirm them | 2.6 | HR | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 88 | **The gate map is code** (`ONBOARDING_GATES`), not an editable setting, because each gated action has to call it | 2.6 | The user | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 89 | **Approving without an e-signature is refused** from step 2.6 (the gate), ending item 17's allowance. The bootstrap system account, which has no employee, is exempt and still approves unsigned, so a request routed to the System Administrators stays decidable | 2.6 | The user | [Approvals](modules/core.md#approvals) |
| 90 | **HR doesn't verify HR staff's government IDs and bank account**: the System Administrator or a Board member does, as for changing them | 2.6 | HR, counsel | [Sensitive data](../SECURITY.md#sensitive-data) |
| 91 | **What counts as verified.** Values a verifier entered (in the inspector) or approved (a change request) are verified by that person, with no separate check; the employee's own entry isn't. Values saved before step 2.6 read as not verified, so HR verifies each existing employee's once | 2.6 | HR | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 92 | **Empty fields stay directly fillable** by the employee after onboarding too; only a change to a filled-in value needs approval. Clearing a value is a change | 2.6 | HR, the user | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 93 | **Employees upload their own 201 documents** of any type but the employment contract and the regularization evaluation; editing and archiving stay with HR | 2.6 | HR | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 94 | **Employees add their own certifications** directly (they count for Engage's certified-engineer numbers at once); editing needs Talent Write and removing Talent Owner | 2.6 | HR | [Skills & certifications](modules/talent.md#skills--certifications) |
| 95 | **Personal details changes (date of birth, sex, civil status, nationality) go to HR only**, not to supervisors, because supervisors never see the date of birth or civil status | 2.6 | HR, counsel | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 96 | **Supervisors approve change requests but don't edit records.** The spec says "HR and any supervisor in `reportingTo` can edit the employee's record"; this is read as approving their team's change requests (contact details and skills), so supervisors get no new view of personal data. Direct editing stays with Talent Write. Decision 162 had said supervisors' editing comes with step 2.6 | 2.6 | The user, counsel | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 97 | **Routing of sensitive changes.** Government IDs and bank go to HR, and for HR staff to any one Board member; the System Administrator gets them only when no one else is left, not as a standing approver | 2.6 | The user | [Sensitive data](../SECURITY.md#sensitive-data) |
| 98 | **Deciding a change request needs no module access** (like every approval); the hook checks the approver's role against the employee as they are at the decision | 2.6 | The user | [Exceptions to module access](../SECURITY.md#exceptions-to-module-access) |
| 99 | **An approved change overwrites a value changed meanwhile** (for example by HR in the inspector), with no conflict check; the request page shows the current values when the approver decides | 2.6 | HR | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 100 | **A pending change request can't be withdrawn** (the approvals engine has no withdraw); the employee asks the approver to return it, then cancels it | 2.6 | The user | [Approvals](modules/core.md#approvals) |
| 101 | **Who sees onboarding status.** The `/talent` onboarding filter and tiles are for HR and the System Administrator only, and the inspector hides the state of items about sections the viewer can't see, so neither says who has IDs, a bank account or a salary on file | 2.6 | The user | [Sensitive data](../SECURITY.md#sensitive-data) |
| 102 | **The gate names an unverified group as such.** When the only item a gate misses is government IDs or the bank account filled in but not verified (the payroll gate), the message ends "Ask HR to verify them." (or "it."), since the spec words only the employee and HR item cases. The password item, always done once the checklist shows, says "Change it from your account menu, then try again." | 2.6 | The user | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 103 | **Before any `talent.onboardingSettings` version exists** (only before `pnpm seed:admin` has run), the checklist uses the seeded value (government ID copy and NBI clearance) | 2.6 | The user | [Versioned configuration](DATA_MODEL.md#versioned-configuration) |
| 104 | **A hidden item hides the counts too.** When the inspector hides an item's state from a viewer (item 101), the progress, "complete" and the reminder flag that count it are hidden as well (`onboardingViewOf` returns null for them), so "8 of 8" can't tell whether IDs or a bank account are on file | 2.6 | The user | [Sensitive data](../SECURITY.md#sensitive-data) |
| 105 | **`talent.verificationNeeded` falls back to the System Administrators** when no HR user is active (a non-HR employee), as `talent.documentUploaded` does; the spec names only HR. Neither notification goes to the person who made the change | 2.6 | The user | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 106 | **A section with an open change request takes no own save at all**, blanks included: the save is refused with "A change to this section is already waiting for approval…", and Edit opens the request instead. Otherwise an approved request could overwrite a blank filled meanwhile | 2.6 | The user | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 107 | **The emergency contact's parts are compared one by one.** Filling its empty relationship or mobile number is a fill (saved straight away); changing or clearing a filled part makes the whole contact a change request field | 2.6 | HR | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 108 | **`changeRequests.sentAt`** (when the request was last sent: the first send, or "Edit and send again") was added for the request page's "sent" date and the own list, since `createdAt` doesn't move on a resend. DATA_MODEL doesn't list it yet | 2.6 | The user | [DATA_MODEL.md](DATA_MODEL.md#collection-ownership) |
| 109 | **Cancel is for a returned request only** (decision 272), so chunk A's `cancelled` status and `cancelChangeRequestSchema` stay; a pending request can't be cancelled (item 100). "Edit and send again" takes only that request's section from the sheet's values, compares it with the record as it is then, and keeps the earlier note unless a new one is sent | 2.6 | The user | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 110 | **A change request on government IDs or the bank account opens only for viewers who may reveal that category** (the employee, HR, Accounting, the System Administrator, the Board for HR staff), approvers included: a Board approver whose employee has since left HR gets the no-access state. A Talent Read user without the reveal rule never sees one. Personal details need the date of birth rule | 2.6 | The user | [Sensitive data](../SECURITY.md#sensitive-data) |
| 111 | **"Mark verified" shows only while the group is complete and not yet verified.** A verifier's inspector save of the group verifies it even when it is still incomplete (the item reads To do until it is complete) | 2.6 | HR | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 112 | **"No supervisor"**: confirming is refused while an active supervisor exists, withdrawing is refused when nothing is confirmed, and the inspector gets `version` from the record view (the Onboarding section's view has none) | 2.6 | HR | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 113 | **"Uploaded by" and "Added by" now show to the employee too** (on /talent/me), as well as to Talent Read. Names of users come from Core's `userNames`, newly exported from `@pulse/core/server` (the only Core change in chunk C) | 2.6 | The user | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 114 | **Settings on `/talent` became a small menu** ("Expiry alerts", "Required onboarding documents"), each opening its own sheet, rather than one sheet with two forms. The two onboarding tiles also toggle the `?onboarding=` filter, beside the "Onboarding" select | 2.6 | The user | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 115 | **The inspector's Onboarding section sits after the record** (it loads on its own, like the Work schedule). "Mark verified" saves on one click, with no confirm dialog, and "Verification" is a row inside each of the two sections ("Verified by <name> on <date>" or "Not verified") | 2.6 | HR | [Onboarding checklist](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 116 | **The Approvals inspector's change request line** ("Approving applies the change to <name>'s record…") is built on the server from the change request page's service, so it is left out for an approver that page refuses (item 110). Every Approvals read and decide now registers the types through one helper (`apps/web/lib/approval-types.ts`: Core's types, `talent.changeRequest`, the signer), which also fixes deciding a change request from Approvals | 2.6 | The user | [Approvals](modules/core.md#approvals) |
| 117 | **"Approved without an e-signature" keeps its wording** on old decisions: the step's view can't tell the bootstrap system account's unsigned approve from one made before step 2.6, so the spec's "Approved by the system account, without an e-signature" isn't shown yet | 2.6 | The user | [Approvals](modules/core.md#approvals) |
| 118 | **The checklist and change request pages read "Pulse Talent › Onboarding" and "Pulse Talent › Change request"** in the breadcrumb for everyone (TESTING's "Pulse Talent pages open to others"), and the Talent item is current there for Talent readers. Neither is a sidebar entry | 2.6 | The user | [Onboarding and change request tests](TESTING.md#onboarding-and-change-request-tests) |
| 119 | **The toolbar pill asks the server for its state** after the page loads, on every navigation and after an own save, rather than coming with the layout's first render, so it can appear a moment after the page. A failed read hides nothing that was shown and never blocks. Adding it needed a `status` slot (before the bell) on the shared `AppShell` and `TopToolbar` | 2.6 | The user | [Feedback & motion](DESIGN_SYSTEM.md#feedback--motion) |
| 120 | **The checklist's rows show their action only while To do** ("Edit", "Upload", "Add photo", "Upload e-signature"); a done or "Waiting for HR to verify" row has none, and further changes are made on My record. "Upload document" on My record sits at the top of the 201 file, since the record's sections are shared with the inspector | 2.6 | The user | [Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 121 | **"Edit and send again" starts from the record's current values**, not the returned proposal (the sheet never holds a stored ID or account number), with the approver's remarks at the top; it shows only the returned request's part. Edit on Personal stays while one of its two parts has an open request: that part shows the request's link in the sheet and is sent back unchanged | 2.6 | The user | [Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 122 | **The note to the approver shows only once the sheet will send for approval**, and the employee's own upload and certification forms are checked by the services, so only the first problem shows next to its field | 2.6 | The user | [Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| 123 | **The submission deadline is 1 day after the cut-off** (`talent.timesheetSettings.submissionDeadlineDays`, 1 to 10). A version stored without the field, the seeded one included, reads as 1, so no new version is seeded | 2.7 | HR | [DATA_MODEL.md](DATA_MODEL.md#versioned-configuration) |
| 124 | **Submission opens the day after the cut-off ends**, not on its last day, and stays open after the deadline: late timesheets are accepted and marked "Submitted late" | 2.7 | HR | [Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27) |
| 125 | **A submitted timesheet can't be changed or withdrawn** by the employee (the approver returns it), and an approved one is never reopened | 2.7 | HR, the user | [Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27) |
| 126 | **Approval is all or nothing.** Approving approves every claimed overtime or offset minute and every reimbursement line; to drop one, the approver returns the timesheet | 2.7 | HR | [Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27) |
| 127 | **Approvers open the timesheet read-only outside module access** (an HR approver without Talent Read gets directory fields only), and HR still can't correct entries: corrections come through a return (item 54) | 2.7 | HR, counsel | [Exceptions to module access](../SECURITY.md#exceptions-to-module-access) |
| 128 | **Lates count from the scheduled start** once the first time in is past the grace period (seeded 15 minutes); within it, nothing is late | 2.7 | HR, counsel | [Attendance and the DTR](COMPLIANCE.md#attendance-and-the-dtr-build-step-27) |
| 129 | **Undertime includes gaps in the middle of the day**, and staying past the scheduled end never makes up a late start or undertime (Labor Code Art. 88) | 2.7 | HR, counsel | [Attendance and the DTR](COMPLIANCE.md#attendance-and-the-dtr-build-step-27) |
| 130 | **An unworked confirmed holiday is "Holiday", never absent**, and a special working day is a work day. Whether the unworked regular holiday is paid (the day-before rule) is left to step 2.9 | 2.7 | HR, the accountant | [Attendance and the DTR](COMPLIANCE.md#attendance-and-the-dtr-build-step-27) |
| 131 | **A timesheet with no entries can be submitted**, with a warning that every scheduled day will show as absent | 2.7 | HR | [Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27) |
| 132 | **Offset hours are credited at HR approval** from the DTR at that moment, a 0-minute credit included, and there is no manual offset correction in step 2.7 | 2.7 | HR | [Offset balance & offset time off](modules/talent.md#offset-balance--offset-time-off) |
| 133 | **A holiday change after approval adjusts the offset balance**, finalized payroll periods included (offset is never pay); the balance may go below zero, and the employee is told with a new notification, `talent.offsetAdjusted`, which the spec doesn't list | 2.7 | HR | [Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27) |
| 134 | **Reminder days.** The employee is reminded on the day submission opens, the deadline day and the day after; HR once, the day after the deadline. Only cut-offs whose deadline is yesterday, today or tomorrow are read | 2.7 | HR | [Background jobs](ARCHITECTURE.md#background-jobs) |
| 135 | **The timesheets list is Talent Read**, not HR only, since timesheet status isn't sensitive and Talent Read already opens any timesheet | 2.7 | The user | [Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27) |
| 136 | **Separated employees get no reminders**, and a last timesheet they can't submit (their account is inactive) is left for the separation step (2.14) | 2.7 | HR | [Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27) |
| 137 | **The DTR is derived when read, never stored.** After a holiday change, a finalized period's DTR on screen shows the new figures, not those paid, until step 2.9's runs store what they paid and show the difference as an adjustment | 2.7 | The user | [DATA_MODEL › Derived values](DATA_MODEL.md#derived-values) |

## Open items for later steps

| Item | When |
|---|---|
| Recovery when the only System Administrator is disabled (the seed counts a disabled admin as existing). Meanwhile, keep two active admins ([RUNBOOK.md](RUNBOOK.md)). **Specified in the 1.7 docs (2026-10-05):** system account Disable/Enable on `/admin/users` and `pnpm recover:admin` (decision 75, [RUNBOOK](RUNBOOK.md#the-only-system-administrator-is-disabled)). **Built in 1.7 (`be19cda`)** | Done |
| Browser check of step 1.7 by a person: light and dark, phone width, the sheet's dialogs, and the full "Done when" flow ([Not done](#not-done)) | First thing next session, with the 1.8 check |
| Browser check of step 1.8 by a person ([Manual checks still needed](#manual-checks-still-needed-by-a-person-signed-in)) | First thing next session |
| The three 1.8 judgement calls and the other 1.8 follow-ups ([Judgement calls left for the user](#judgement-calls-left-for-the-user)) | Ask the user next session |
| `modules/ops.md` (line 46) says Ops creates rollout sites through Core, but the site services need Engage Write. Settle Ops' access check | Phase 4 |
| ~~Whether a password change or reset ends other sessions~~ Decided 2026-10-05 (1.5 plan): a reset ends all the user's sessions via `users.sessionsValidFrom`; changing your own password keeps them ([Sign-in and passwords](../SECURITY.md#sign-in-and-passwords)) | Done |
| `requireModuleAccess` needs the same split as `requireSignedIn` (session read in `apps/web`, logic in `packages/core`). Built in 1.6 (`61c2ccb`): `hasModuleAccess` and `assertModuleAccess` in core, `requireModuleAccess` and `requireModulePage` in web (decision 61) | 1.6 |
| `/admin/audit` answers a non-admin with the not-found page but HTTP 200, because the streaming `loading.tsx` boundary starts the response before `notFound()` runs. Deferred by the user (2026-10-03); fix it with the designed no-access state and `requireModuleAccess`. The 1.4 pages (`/admin/departments`, `/admin/positions`, `/admin/settings`) have the same issue, accepted and deferred with it (decision 30), and `/admin/users` (decision 49). **Built in 1.6 (`61c2ccb`):** HTTP 403 with the no-access state, guard first, in-page `<Suspense>`, no route-level `loading.tsx` above guarded pages (decisions 52 and 53) | 1.6 |
| Add `/admin/departments`, `/admin/positions` and `/admin/settings` to the sidebar (1.4 links them only from the `/admin` overview), and `/admin/users`. Built in 1.6 (`61c2ccb`): the Administration group (decision 55) | 1.6 |
| Unknown URLs get Next's default, unstyled 404 page. Built in 1.6 (`61c2ccb`): designed `app/not-found.tsx` and `(pulse)/not-found.tsx` (decision 58) | 1.6 |
| Each request costs 2–3 DB reads for the status check (by spec) | Accepted |
| Schema edits while `pnpm dev` runs may need a restart (a warning shows) | Dev limitation |
| ~~Add `.gitattributes` with `* text=auto eol=lf`~~ Added in the 1.4 review fixes (2026-10-05) | Done |
| Expand the `.env.example` `AUTH_TRUST_HOST` comment to mention the "UntrustedHost" error | Optional |
| `storage/2026/09/` holds about 20 verifier test files. Git-ignored, safe to delete | Any time |
| Leftover local database `xtreme-pulse-verify12`. Safe to drop | Any time |

## Local environment

Windows 11, no Docker.

| Service | Details |
|---|---|
| MongoDB 8.3 | Windows service "MongoDB", replica set `rs0` at `127.0.0.1:27017` (`mongod.cfg` edited as admin). `mongosh` installed |
| Redis | Memurai 7.2.5 service: `noeviction`, `appendonly yes`, bound to `127.0.0.1`. `memurai-cli` is at `C:\Program Files\Memurai\memurai-cli.exe`, not on PATH |
| `.env.local` | Exists with every variable (96-byte encryption key). Never read it into a report or commit it |

The real `xtreme-pulse` database has base data but **0 users**. The user should run `pnpm seed:admin`.

**Verifiers must use throwaway databases** (for example `xtreme-pulse-verify-<n>`) by setting `MONGODB_URI` in the process environment (`@next/env` doesn't override an existing variable). Drop them afterwards. Never touch the real database.

## Next actions, in order

1. ~~**The user replies** on the four open items~~. Done (2026-10-03), see the [1.3 notes](#13-notes).
2. ~~**Fix the changed-sensitive-field gap**~~. Done (2026-10-03). Typecheck, lint and `pnpm test` (170) pass; Prettier is clean on the changed files.
3. ~~**A final independent check of all of step 1.3** (typecheck, lint, `pnpm test`, Prettier, review against the docs and the 16 decisions, browser checks in light, dark and phone width)~~. Done (2026-10-03).
4. ~~**Commit 1.3 on `phase-1`**, with the user's go-ahead. Leave `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md` out of the commit~~. Done (2026-10-03): committed as `84667ff`, not pushed. `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md` stay uncommitted.
5. ~~**Step 1.4**, "Departments, positions and company settings" ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core))~~. Done (2026-10-05): built per the [Approved 1.4 plan](#approved-14-plan), review fixes applied, verified (typecheck, lint, `pnpm test` 249, Prettier, browser checks) and committed as `238a9f0`, not pushed. `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md` stay uncommitted.
6. ~~**Step 1.5**, "User accounts and employee numbers" ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core))~~. Done (2026-10-05): built per the [Approved 1.5 plan](#approved-15-plan), [review fixes](#15-review-fixes-2026-10-05) applied, verified (typecheck, lint, `pnpm test` 395, Prettier, browser checks) and committed as `45f1dc4`, not pushed. `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md` stay uncommitted.
7. ~~**Step 1.6**, "Module access and the signed-in shell" ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core))~~. Done (2026-10-05): built per the [Approved 1.6 plan](#approved-16-plan), [review follow-ups](#16-review-follow-ups-2026-10-05) applied, verified (typecheck, lint, `pnpm test` 449, Prettier, real 403/404 and browser checks in dev and a production build) and committed as `61c2ccb`, not pushed. `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md` stay uncommitted.
8. ~~**Step 1.7**, "User access page" ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core))~~. Done (2026-10-06): built per decisions 65–80, checked (typecheck, lint, `pnpm test` 495, production build) and committed as `be19cda`, **pushed** to `origin/phase-1` (no PR yet). `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md` stay uncommitted. See [1.7 build](#17-build-2026-10-06).
9. ~~**Step 1.8**, "Shared master data services"~~. Done (2026-10-08): planned, approved, built per decisions 81–98, verified (typecheck, lint, Prettier, `pnpm test` 671, production build) and committed on `phase-1` as "feat(core,web): step 1.8 shared master data", **pushed**. This time `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md` were committed too, at the user's request. See [1.8 build status](#18-build-status-2026-10-08).
10. **Browser-check steps 1.7 and 1.8 by hand** (the user, signed in). First thing next session. Agents here have no browser tools, so a person has to do it:
    - **1.7:** `/admin/access`; HR sets Talent Write for a user → Talent shows in that user's sidebar → `/admin/audit` shows None → Write; HR's own row is read-only; the sheet's dialogs; the "Needs access" group and the sidebar badge; light and dark, phone width. See [Not done](#not-done).
    - **1.8:** see [Manual checks still needed](#manual-checks-still-needed-by-a-person-signed-in).
11. **Ask the user about the 1.8 judgement calls** ([Judgement calls left for the user](#judgement-calls-left-for-the-user)). All are left as built until they decide.
12. ~~**Step 1.9**, "Approvals engine"~~. Done (2026-10-11): built per decisions 99–110 and committed as `42e64f1`, not pushed.
13. ~~**Step 1.10**, "Holiday calendar"~~. Done (2026-10-12): built per decisions 111–132 and committed as `5f283bb`, not pushed.
14. ~~**Step 1.11**, "Directory, org chart, command bar and Home tiles"~~. Built and verified (2026-10-12) per decisions 133–153, and committed as `2d2d3ca`, not pushed. See [1.11 build](#111-build-2026-10-12).
15. **The user's hands-on checks of step 1.11** in the browser ([1.11 manual checks](#111-manual-checks-by-the-user-signed-in)).
16. **The Phase 1 check** ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core), the "Phase check" after step 1.11), which the user runs by hand on a fresh database. With it done, Phase 1 is complete; every build step of Phase 1 is now built.
17. ~~**Step 2.1**, "Employee record and sensitive fields"~~. Done (2026-10-12): built and verified per decisions 154–172 and committed as `cd2a5a6`, not pushed ([2.1 review](#21-review-2026-10-12)). Still open: **the user's [hands-on checks](#21-hands-on-checks-by-the-user-signed-in)**. Check [Assumptions to check](#assumptions-to-check) before real data is entered.
18. **Step 2.2**, "201 file, profile photo, e-signature and certifications". **Built and verified** (2026-10-12) per decisions 173–190, with four review fixes ([2.2 review](#22-review-2026-10-12)), not committed. Next:
    - **the user's [hands-on checks](#22-hands-on-checks-by-the-user-signed-in)**: the "Done when" with `pnpm dev:approval` and `pnpm dev:expiry-alerts`, uploads, the open audit, photos and the command bar, light and dark, phone width
    - **the commit**, with the user's go-ahead

    Assumptions 9–26 are in [Assumptions to check](#assumptions-to-check). **Committed as `58e3971`** (2026-10-12), not pushed; the hands-on checks are still open.
19. **Step 2.3**, "Payroll settings and seeded configuration". **Built and verified** (2026-10-12) per decisions 191–212, with one review fix and the clock-dependent tests pinned ([2.3 review](#23-review-2026-10-12)), not committed. Next:
    - **the user's [hands-on checks](#23-hands-on-checks-by-the-user-signed-in)**: `pnpm seed:admin` twice on a fresh database, the "Done when" (the internet allowance from the date hired, and the warning with "Save anyway" below ₱755 a day), adding a version, the wage order list, light and dark, phone width
    - **the commit**

    Assumptions 27–45 are in [Assumptions to check](#assumptions-to-check). Before the first real payroll, HR checks every seeded rate against the current issuances. **Committed as `fffefd7`** (2026-10-12), not pushed; the hands-on checks are still open.
20. **Step 2.4**, "Work schedules and daily time entries". **Spec written** (2026-10-12): decisions 213–234 and [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24). **Built and verified** (2026-10-13), with two review fixes ([2.4 review](#24-review-2026-10-13)), and **committed as `1e1cb41`**, not pushed. Still open: **the user's [hands-on checks](#24-hands-on-checks-by-the-user-signed-in)**. Assumptions 46–61 are in [Assumptions to check](#assumptions-to-check).
21. **Step 2.5**, "Reimbursements". **Spec written** (2026-10-13): decisions 235–255 and [Reimbursements (build step 2.5)](modules/talent.md#reimbursements-build-step-25). **Built and verified** (2026-10-13), reviewed with no code fixes needed ([2.5 review](#25-review-2026-10-13)), and **committed as `d1847a5`**, not pushed. Still open: **the user's [hands-on checks](#25-hands-on-checks-by-the-user-signed-in)**. Assumptions 62–75 are in [Assumptions to check](#assumptions-to-check).
22. **Step 2.6**, "Onboarding checklist and change requests". **Spec written** (2026-10-13): decisions 256–276 and [Onboarding checklist and change requests (build step 2.6)](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26). **Built and verified** (2026-10-18), reviewed with no code fixes needed ([2.6 review](#26-review-2026-10-18)), and **committed**, not pushed. Still open: **the user's [hands-on checks](#26-hands-on-checks-by-the-user-signed-in)**, after rerunning `pnpm seed:admin` on existing development databases. Assumptions 84–122 are in [Assumptions to check](#assumptions-to-check); item 96 (supervisors approve rather than edit) is the one most worth a look from the user.
23. **Step 2.7**, "Timesheet approval and the DTR". **Spec written, not built** (2026-10-18): decisions 277–298 and [Timesheet approval, the DTR and the offset balance (build step 2.7)](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27). Next: build in the chunks in [2.7 notes](#27-notes) (A and B, then C, then D, E and F), verify, and commit. Assumptions 123–137 are in [Assumptions to check](#assumptions-to-check); items 128–130 (lates, undertime, holidays) go to HR and counsel before real attendance is deducted.

## 1.11 build (2026-10-12)

Built by five sub-agents (Core services; the `packages/ui` Avatar and command bar; the org chart layout; the directory and org chart pages; the command bar wiring and Home), then reviewed and verified by another. Nothing is committed: the code and the 1.11 docs are all in the working tree on `phase-1`, on top of `5f283bb`.

### What was built

- **Core** (`packages/core`): the result shapes, fixed sets (`COMMAND_PROVIDER_KINDS`, `COMMAND_ICONS`) and the reporting line form schema in `src/directory.ts`; the directory, card, Home team, department filter and inspector supervisor search in `server/directory/service.ts`, all built field by field from explicit projections in `server/directory/people.ts`; the org chart graph in `server/directory/org-chart.ts`; the command bar registry and Core's people provider in `server/command-bar/`; `canEditReportingLines` and `canSeeSeparatedPeople` in `roles.ts`; one reporting line change rule (`resolveReportingToChange`) shared by `updateUser` and the new `setReportingLines` in `employees/reporting-lines.ts`; `oldestApprovalWaitingSubmittedAt` in the approvals service; `firstName` on the session's employee; the `employees` index `{ lastName, firstName, _id }`.
- **UI** (`packages/ui`): the shared `Avatar` (also on the User access page), the command bar's search props (result groups, loading and error states, icon keys) and the `/dev/ui` gallery entries.
- **Web** (`apps/web`): `/directory` and `/org-chart` (Pulse Core sidebar, after Holidays), the shared person inspector with inline reporting line editing, the org chart layout (`lib/org-chart-layout.ts`), the SupervisorPicker moved to `components/supervisor-picker.tsx` with the search action passed in (`/admin/users` keeps its own), `reportingLineEditorsOnly()` in `lib/auth.ts`, the command bar search (`lib/actions/command-bar.ts`, wired in `pulse-shell.tsx`), and the Home hero and tiles (`app/(pulse)/page.tsx`, `home-tiles.tsx`, `lib/home.ts`).

### Review (2026-10-12)

Checked against decisions 133–153, Reporting lines, Company directory, Org chart, Command bar and Home in `core.md`, SECURITY.md (Roles, Rules, Command bar providers, the directory allowlist, Audit logging) and DESIGN_SYSTEM.md. No code bug was confirmed, so the code is unchanged by the review. What was checked:

- **Allowlist.** Every directory, card, org chart, people result and Home team value is built field by field; the employment status is read only to resolve the account status, and the date hired, separation date, module access and password hash are never read. The action and page props carry only those shapes.
- **Separated people.** Hidden from everyone but HR and System Administrators across the list, the card (a separated card answers like a missing one), the org chart, the command bar, the Home team and the inspector's links; the server ignores `?separated=1` for anyone else, Board members included. An inactive supervisor shows on a card only to the editors, and a Board member sees it without a link.
- **Editing.** The role is checked in the Server Actions and again in the service; own lines (read fresh from the database), the system account and a separated or account-less employee are refused; the stale-form check counts the order; cycles stay with the claim-based check; the audit entry is written in the save's transaction, and a save that changes nothing writes nothing. The `updateUser` refactor behaves as before (its tests still pass).
- **Command bar.** Providers are filtered by `isVisibleTo` (inside the failure guard), results are rebuilt field by field and links must pass `isInternalHref`, a failed provider is left out with only its key logged, at most 8 results per provider, queries trimmed and capped at 100. `registerCoreCommandProviders()` checks `hasCommandProvider` first, so calling it on every request never throws in production (tested with `NODE_ENV=production`).
- **Limits.** Every search input is capped at 100 characters (directory page and service, supervisor search, card id, command bar).
- **Home.** Each tile reads only the user's own data and loads and fails on its own; the greeting, the "Oldest submitted N days ago" day count and the holidays window use Manila time.
- **UI.** Tokens only, 44px targets on the new controls, accessible names on cards, rows and buttons, the lines and avatars hidden from assistive technology.

Docs aligned with the code: the 1.11 "Where" line in [TESTING.md](TESTING.md#directory-org-chart-and-command-bar-tests) (it was missing) and the Home helper tests; the registry's development behaviour (a second registration replaces the first outside production) and `registerCoreCommandProviders()` in [Command bar](modules/core.md#command-bar).

### Assumptions and small notes (for the user)

- The command bar's Server Action refuses a query over 100 characters rather than cutting it; the command bar cuts it before sending, so a user never sees this. The registry cuts it too.
- The inspector's supervisor search, like `/admin/users`' one, leaves out the person being edited after taking the first 20 matches, so it can show 19.
- "Upcoming holidays" covers today through the 60th day after it (61 Manila days).
- Search waits 250 ms after the last key on the directory and the org chart, and 200 ms in the command bar (the spec fixes only the command bar's).

### 1.11 manual checks (by the user, signed in)

Agents here have no browser. In light and dark appearance and at phone width:

1. As HR or the System Administrator, give one employee two supervisors. On `/org-chart` they appear once with two lines (the step's "Done when"); cards are named "…, reports to A and B".
2. Press ⌘K or Ctrl+K, type part of a name, then an employee number such as `2027-01`: the person shows under People and opens their card on `/directory`.
3. On `/directory`: search by name, number and email; filter by department; as HR, "Show separated" shows the "Inactive" badge; as an ordinary user, `?separated=1` changes nothing and a separated person's `?person=` link says they aren't in the directory.
4. As a Board member, edit someone else's reporting lines in the inspector (Save with ⌘↵ or Ctrl+Enter); your own card says "You can’t change your own reporting lines."; as the System Administrator, `/admin/audit` shows one `update` on `core.employee` for the save. Open the same card in two tabs, save in one, then save in the other: the stale message and Reload show.
5. On `/admin/users`, the supervisor picker still searches and saves as before.
6. Home: the greeting and date, the four tiles and their zero states; the system account sees no name and no Your team tile.
7. The org chart's zoom, Fit and department filter, and name search ("Match" ring, dimming, scroll) by keyboard and at phone width; the page never scrolls sideways.

## Step 1.11 brief (done)

Kept for the record. Built and verified on 2026-10-12, not committed.

**1.11 Directory, org chart, command bar and Home tiles** ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core), Phase 1 step 11).

The spec was changed first (2026-10-12), from the approved plan and its 20 recommendations: BUILD_PLAN decisions 133–153, [Reporting lines](modules/core.md#reporting-lines) (editing in the inspector), [Company directory](modules/core.md#company-directory), [Org chart](modules/core.md#org-chart), [Command bar](modules/core.md#command-bar) and [Home](modules/core.md#home) ("Built in step 1.11"), [SECURITY.md](../SECURITY.md#rules) (the pages, the Board's editor, the command bar provider rule, the directory allowlist, audit), [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#layout--components) (command bar, directory, org chart, Home tiles, the Avatar), [Cross-module integration](ARCHITECTURE.md#cross-module-integration) (`registerCommandProvider`), [DATA_MODEL.md](DATA_MODEL.md#collection-ownership) (the `employees` index), [Constants versus data](CODE_STYLE.md#constants-versus-data) (`COMMAND_PROVIDER_KINDS`, `COMMAND_ICONS`) and the [Directory, org chart and command bar tests](TESTING.md#directory-org-chart-and-command-bar-tests). These docs aren't committed yet.

**Build order (from the approved plan).** Core services first (the `canEditReportingLines` role, a shared reporting line change rule used by `/admin/users` too, `setReportingLines`, the directory, org chart and team services, the oldest waiting approval, the index), the command bar registry and people provider, the `packages/ui` Avatar and command bar props, and the org chart layout, in parallel; then the web pages and actions, and the command bar wiring with the Home tiles; then verification. Home's holidays tile reads `listConfirmedHolidays` from step 1.10.

**Workflow.** Dispatch sub-agents for all work (CLAUDE.md). Build, verify on a throwaway database, and don't commit without asking.

## Step 1.10 brief (done)

Kept for the record. Built and committed as `5f283bb` (2026-10-12).

The spec was changed first (2026-10-11), from the user's approved decisions: BUILD_PLAN decisions 111–132, [Holiday calendar](modules/core.md#holiday-calendar) ("Built in step 1.10"), [DATA_MODEL.md](DATA_MODEL.md#collection-ownership) (`holidays`, `core.holidayRules`), [SECURITY.md](../SECURITY.md#rules) (`/holidays`, audit), [Background jobs](ARCHITECTURE.md#background-jobs), [Environment variables](DEPLOYMENT.md#environment-variables) (`HOLIDAY_SOURCE_URL`), [Runbook](RUNBOOK.md#online-holiday-source-unreachable) and [Holiday calendar tests](TESTING.md#holiday-calendar-tests). These docs aren't committed yet.

**Spec (docs to read):** the links in the step's **Spec** line in BUILD_PLAN.

**Workflow.** Dispatch sub-agents for all work (CLAUDE.md). Show the build plan and wait for the user's approval before any code. Then build, verify on a throwaway database, and don't commit without asking.

## Step 1.9 brief (done)

Kept for the record. Built and committed as `42e64f1` (2026-10-11).

**1.9 Approvals engine** ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core), Phase 1 step 9).

Build the approvals engine, with steps routed to `reportingTo`, any one of a set (the Board), or all of a set (payment approvers). The first decision settles an any-one step and notifies the others; a return needs remarks; a self-only step goes to the System Administrator. Add same-transaction hooks for modules, a read-only approver access check and an Approvals list; Phase 2 adds e-signatures to decisions. Read the step's full text in BUILD_PLAN.

**Spec (docs to read):** [Reporting lines](modules/core.md#reporting-lines); [Module access (RWO)](../SECURITY.md#module-access-rwo); [Timesheets & attendance](modules/talent.md#timesheets--attendance) ([Submission & approval](modules/talent.md#submission--approval)); [Payroll run & payslips](modules/talent.md#payroll-run--payslips); [Payments (disbursements)](modules/fiscal.md#payments-disbursements).

**Workflow.** Dispatch sub-agents for all work (CLAUDE.md). Read the Spec docs, show the plan with recommendations for the open questions, and wait for the user's approval before any code. Docs first, then build, then verify on a throwaway database. Don't commit without asking.

## Step 1.8 brief (done)

Kept for the record. The open questions below were settled by the [Approved 1.8 plan](#approved-18-plan); where this brief says `packages/db`, [ADR 0013](adr/0013-master-data-schemas-in-core.md) supersedes it (master data lives in `packages/core`).

**1.8 Shared master data services** ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core), Phase 1 step 8).

### Goal and tasks

- Add the master data schemas in `packages/db` and their services in `packages/core`: **clients** with **sites** and **contacts**, **products** (`brands` in code), **catalog items** and **suppliers**.
- Catalog items carry their product, part number, description, unit, item kind (serialized, bulk, or non-stock for services and licenses) and default warranty months.
- Seed the products (13 brands: Extreme Networks, Barracuda Networks, Palo Alto Networks, i-PRO, Luxriot, Cradlepoint, Verifone, Docusign, Airedale, Oper8 Global, ebm-papst, Ziehl-Abegg, General; listed in [Deals and stages](modules/engage.md#deals-and-stages)). Products are records, never an enum.
- Build basic System Administrator screens under `/admin`. Engage (Phase 3) and Supply (Phase 4, step 4.4) build the full screens on these services; stock locations are step 4.4, not 1.8.

**Done when:** the System Administrator adds a client with two sites and a contact, and the products list shows all 13 seeded brands.

### Spec (docs to read)

From the step's Spec line:

- [Architecture rules](ARCHITECTURE.md#architecture-rules)
- [Deals and stages (products)](modules/engage.md#deals-and-stages)
- [Clients, sites and contacts](modules/engage.md#clients-sites-and-contacts)
- [Suppliers](modules/supply.md#suppliers)
- [Stock](modules/supply.md#stock)
- [Warranties, support contracts and subscriptions](modules/desk.md#warranties-support-contracts-and-subscriptions)

Also relevant (not on the Spec line): [Shared master data](modules/core.md#shared-master-data), [Administration area](modules/core.md#administration-area), the Core row in [DATA_MODEL.md](DATA_MODEL.md#collection-ownership), [Cross-module integration](ARCHITECTURE.md#cross-module-integration), [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md), and [TESTING.md](TESTING.md) plus ADR 0010 if `pnpm test` gains master data suites.

### What 1.8 builds on from earlier steps

- The 1.1 note: Core schemas live in `packages/core`, and `packages/db` gets shared master data in 1.8.
- `recordAudit` inside the service's transaction (1.3); the soft-delete retire/restore pattern, `claimLive…` write-skew guards and case-insensitive unique indexes (1.4); `requireAdminPage` / `adminOnly(kind)` and the sidebar Administration group (1.6); `pnpm seed:admin` adds only missing base data (the seed for products).
- Step 1.7 leaves nothing 1.8 depends on, apart from its open browser check.

### Open questions (for the plan; not resolved here)

1. **Where the code lives.** The step puts schemas in `packages/db` and services in `packages/core`, while DATA_MODEL lists these collections under Core and Core's other schemas live in `packages/core`. Does `packages/db` hold just the Mongoose models, and how do other modules reach them only through Core's services?
2. **Collection names.** Only `brands` is named. What are the names for clients, sites, contacts, catalog items and suppliers, and are sites and contacts embedded in the client or separate collections? Are supplier contacts the same shape as client contacts?
3. **Who manages them before Phases 3 and 4.** The step says "System Administrator screens", but the [Administration area](modules/core.md#administration-area) table has no master data entries. Is it System Administrator only (not HR)? Which sidebar entries, routes and breadcrumbs? Should the services take an actor check that later accepts Engage Owners (products) and Supply Write/Owner (suppliers, catalog items)?
4. **Retire and delete.** Are clients, products, catalog items and suppliers retired with a soft delete and restore, like departments? What is blocked from retiring (for example a product with catalog items)? Can sites and contacts be removed?
5. **Uniqueness.** Are names (client, supplier, product) unique, and ignoring case? Is a catalog item's part number unique per product or across all products?
6. **Client fields.** VAT treatment and price display are fixed enums; is credit terms a whole number of days (range)? Is industry free text or a list? The owning Account Manager: required, and must they be an active user with Engage access, which nobody has a reason to hold yet?
7. **Site and contact fields.** Is the site contact free text or a link to one of the client's contacts? Must a client have exactly one primary contact, or at most one? Are mobile and email validated (format, PH mobile)?
8. **TIN.** Format and validation for client and supplier TINs. Are they company data (not sensitive), like the company TIN in 1.4?
9. **Catalog item fields.** Is the unit free text or a list? Is default warranty months required, with what range and default, and is it ignored or zero for non-stock items? Can the item kind or product change after creation?
10. **Supplier fields.** Is payment terms days or free text? Are products supplied required (one or more)?
11. **Screens in scope.** "Basic screens": all four record types, or only clients and products as the Done-when line tests? Is the product list read-only apart from the seed, or can the System Administrator add and retire products now (spec: Engage Owners do it from Engage settings)?
12. **Audit and tests.** Audit record types and labels (for example `core.client`), and does a site or contact change audit as an update of its client? Does `pnpm test` add master data suites (TESTING.md, ADR 0010 and AGENTS.md updated first, as in earlier steps)?
13. **Seeding "General".** Is the "General" product protected from retiring, since it holds items with no brand?

### Workflow reminder

Dispatch sub-agents for all work (CLAUDE.md). Read the Spec docs, show the plan with recommendations for the open questions, and **wait for the user's approval before writing any code**. Change the docs first, then build, then verify (typecheck, lint, `pnpm test`, review, browser checks in light, dark and phone width) on a throwaway database. Don't commit without asking.

## Approved 1.8 plan

Step 1.8 plan approved by the user (2026-10-08). The spec was updated first (docs first; reviewed, built and committed with the step on 2026-10-08): [ADR 0013](adr/0013-master-data-schemas-in-core.md) and its row in the ADR index; [ARCHITECTURE](ARCHITECTURE.md#modules-and-packages) (packages and repository layout); BUILD_PLAN step 1.8 text and Spec line, and decisions 81–98; [DATA_MODEL](DATA_MODEL.md#collection-ownership); core.md ([Bootstrap](modules/core.md#bootstrap-system-administrator-account), [Administration area](modules/core.md#administration-area), [Shared master data](modules/core.md#shared-master-data) and the new [Managing master data](modules/core.md#managing-master-data)); [engage.md](modules/engage.md#clients-sites-and-contacts) (client, site, contact and product rules, VAT label without the rate); [supply.md](modules/supply.md#suppliers) (supplier and catalog item rules); desk.md (warranty link); SECURITY.md ([Rules](../SECURITY.md#rules), System Administrator, [Sensitive data](../SECURITY.md#sensitive-data), [Audit logging](../SECURITY.md#audit-logging)); [DESIGN_SYSTEM › Feedback & motion](DESIGN_SYSTEM.md#feedback--motion) (non-blocking warning); [Master data tests](TESTING.md#master-data-tests), ADR 0010, AGENTS.md, README.md; CHANGELOG; CODE_STYLE fixed sets; GLOSSARY ("retire, restore"). Build agents read those sections; this section records the decisions.

### The user's decisions

1. **Where the code lives.** Schemas and services in `packages/core`, like every other Core schema; Core never exports the models; other modules use Core services only. Supersedes the 1.1 note (CHANGELOG), ARCHITECTURE's `packages/db` lines and the old step 1.8 text. `packages/db` = connection, transactions, model helpers.
2. **Screens.** Basic System Administrator screens for all four record types: `/admin/clients` (with sites and contacts), `/admin/products`, `/admin/catalog-items`, `/admin/suppliers`. System Administrator only (`requireAdminPage('systemAdministrator')`, `adminOnly('systemAdministrator')`); HR has no access; sidebar links in the Administration group for the System Administrator only; breadcrumbs "Administration › Clients" etc.
3. **Service access** (the System Administrator always passes). Clients, sites, contacts: Engage Write, except retiring or restoring a client needs Engage Owner (soft delete = Owner); list and get need Engage Read. Products: create, update, retire, restore Engage Owner; list Engage Read. Suppliers and catalog items: create, update, retire, restore Supply Owner; list Supply Read. Picker option lists (id + name, live records only): any signed-in user.
4. **Client names** aren't unique. Warn when another client (retired included) has the same name ignoring case; the user confirms with "Save anyway"; the server enforces the same check.
5. **VAT treatment labels** carry no rate: "VAT-registered", not "VAT-registered at 12%".
6. **Collections:** `clients`, `clientSites`, `clientContacts`, `brands`, `catalogItems`, `suppliers`. Supplier contacts embedded in the supplier (max 20): name, position, email, mobile; no primary flag.
7. **Retire and restore** (soft delete; audit `delete` and `restore`) for clients, products, catalog items and suppliers. A product can't be retired while it has live catalog items (later phases add blockers, e.g. deals from Phase 3). Sites and contacts are soft-removed and restorable; removing the primary contact clears its flag. Retired records can't be picked for new records; existing links are kept and shown "Retired". No site or contact can be added to a retired client.
8. **Uniqueness** ignoring case (collation `en`, strength 2), retired and removed included (re-adding a retired name is refused, the message points to Restore): product names, supplier names, part number per product, site name per client. Client names and TINs not unique. Partial unique index: one primary contact per client.
9. **TIN** (clients and suppliers): optional; input may contain dashes and spaces, normalized to digits; 9, 12 or 14 digits; displayed `000-000-000-000(00)`; company data, not sensitive (shown in full, in audit snapshots).
10. **Client fields:** name (required), TIN, billing address, VAT treatment (`vatRegistered`/`zeroRated`/`vatExempt`, default `vatRegistered`), price display (`vatExclusive`/`vatInclusive`, default `vatExclusive`), credit terms (optional whole days 0–365; empty = the Fiscal default credit term), industry (free text ≤ 100), owning Account Manager (optional; when set, an employee with an active account, never the system account; an unchanged one who later goes inactive is kept with an Inactive badge), notes.
11. **Site:** name required, unique per client; address, city, site contact as free text. **Contact:** name required, position, email (format checked, lowercased), mobile (lenient PH: after stripping spaces, dashes and parentheses, `+63`/`63`/`0` then `9` and 9 digits; stored as entered), primary flag (at most one; marking a new primary clears the old one in the same transaction).
12. **Catalog item:** product, part number, description, unit, item kind required. Unit free text with suggestions (pc, unit, set, lot, box, roll, m, license, service). Item kind `serialized`/`bulk`/`nonStock`. Default warranty months whole number 0–120, default 12 (the form sets 0 for `nonStock`, still editable). Product and item kind fixed after creation.
13. **Supplier:** name (unique), TIN, address, payment terms (optional whole days 0–365), contacts (embedded), products supplied (optional; newly picked must be live), supplier type (`distributor`/`brandPrincipal`/`subcontractor`/`other`, default `distributor`), notes.
14. **Seed** the 13 products (Extreme Networks, Barracuda Networks, Palo Alto Networks, i-PRO, Luxriot, Cradlepoint, Verifone, Docusign, Airedale, Oper8 Global, ebm-papst, Ziehl-Abegg, General) with a stable `seedKey`, inserting only missing ones (a hand-added same-name product counts as kept; renaming a seeded one doesn't re-add it). "General" not protected.
15. **Audit:** record types `core.client`, `core.clientSite`, `core.clientContact`, `core.brand`, `core.catalogItem`, `core.supplier` (module `core`). Labels: client = name; site = `<client> · <site>`; contact = `<client> · <contact>`; product = name; catalog item = `<product> · <part number>`; supplier = name. Every mutation audited in the same transaction.
16. **Tests:** new `pnpm test` suites for master data (access, audit, retire/restore and blockers, uniqueness, duplicate-name warning, primary contact, TIN and mobile helpers, seed loader, navigation).

Mapped to BUILD_PLAN decisions 81–98.

### Added by the docs agent (built as written)

- Overlapping-change guards as in 1.4: adding or restoring a catalog item writes its product, adding or restoring a site or contact (and marking a primary) writes its client, and saving a supplier writes each newly picked product, inside the transaction.
- A retired record can't be edited until restored; a catalog item can't be restored under a retired product; no site or contact is restored on a retired client; retiring a client leaves its sites and contacts as they are.
- TIN display read as groups of three with the remaining digits last (`000-000-000`, `000-000-000-000`, `000-000-000-00000`).
- Supplier contacts' email and mobile are checked like a client contact's.
- The warning pattern: changing the field clears the warning and restores the button label.
- Test file locations in TESTING.md are a proposal; the build may place them differently and update the doc.
- Later callers outside Engage and Supply (Ops creating rollout sites in Phase 4, Desk fleet imports in Phase 6) settle their access check in their own step.

## 1.8 build status (2026-10-08)

Built by parallel agents per the [Approved 1.8 plan](#approved-18-plan) (decisions 81–98), then verified and fixed by a verify agent. **Committed** on `phase-1` as "feat(core,web): step 1.8 shared master data" and pushed (2026-10-08). `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md` are in the same commit, at the user's request.

**Checks:** `pnpm typecheck`, `pnpm lint`, `prettier --check .` and `pnpm test` (37 files, 671 tests) pass. The production build of `apps/web` succeeds, with `/admin/clients`, `/admin/products`, `/admin/catalog-items` and `/admin/suppliers` as dynamic routes and no `/dev` routes.

### What was built

- **Fixed sets, helpers and form schemas** (browser-safe) in `packages/core/src/master-data.ts`: VAT treatment, price display, item kind, supplier type, unit suggestions, the TIN and mobile helpers. Exported from `@pulse/core`.
- **Services** in `packages/core/src/server/`: `clients/` (`service.ts`, `sites.ts`, `contacts.ts`, with the `clients`, `clientSites` and `clientContacts` models), `brands/`, `catalog-items/` and `suppliers/`. Shared files: `master-data-access.ts` (the Engage and Supply checks, `MasterDataActor`, `MasterDataOption`), `master-data-audit.ts` (`auditLabel`, `auditActor`), `master-data-claims.ts` (the overlapping-change guards) and `master-data-collation.ts`. The models aren't exported. `@pulse/core/server` exports only the services and view types.
- **Active-employee rule** moved from the departments service to `employees/active-employees.ts`, so the department head picker and the client's Account Manager share it. Departments behave as before: the queries and limits are the same, and the departments tests pass.
- **Seed:** `brandsLoader` adds the 13 products, each with a `seedKey`, and inserts only the missing ones.
- **Web:**
  - Server Actions in `apps/web/lib/actions/{clients,brands,catalog-items,suppliers}.ts`, all `adminOnly('systemAdministrator')`.
  - Pages `/admin/clients`, `/admin/products`, `/admin/catalog-items` and `/admin/suppliers`, each calling `requireAdminPage('systemAdministrator')` first. The client sheet has sites and contacts sections and the duplicate-name "Save anyway" warning.
  - `components/employee-picker.tsx` replaces `departments/department-head-picker.tsx`.
  - Sidebar Administration entries and the `/admin` overview grouping (`lib/navigation.ts`, `admin/page.tsx`).
- **Tests:** see [Master data tests](TESTING.md#master-data-tests). Its "Where" line now names the actual files.

### Fixes made in verification

1. **Audit label limit.** A catalog item's audit label (`<product> · <part number>`) could reach 203 characters (a 100-character product and a 100-character part number), over the audit log's 200-character limit, so the longest valid item couldn't be saved. `auditLabel`, which cuts a label to 200 characters ending in "…", moved from `clients/shared.ts` to `server/master-data-audit.ts` together with `auditActor`. Every master data service now uses it: catalog items, products, suppliers, clients, sites and contacts. The picker option name isn't cut. New tests: `master-data-audit.test.ts`, and a longest-label case in `catalog-items.test.ts`.
2. **Picker option functions** now match: none takes an actor. `listBrandOptions()` and `listCatalogItemOptions({ brandId })` now match `listClientOptions()`, `listSupplierOptions()`, `listClientSiteOptions(clientId)`, `listClientContactOptions(clientId)` and `searchActiveEmployees`. The caller's sign-in check is the only one ([Rules](../SECURITY.md#rules)), and the `eslint-disable` is gone. `MasterDataOption` moved to `master-data-access.ts`. `BrandOption` and `SupplierOption` are aliases of it, and `CatalogItemOption` extends it.
3. **Test locations.** [TESTING.md › Master data tests](TESTING.md#master-data-tests) "Where" now names the actual test files.
4. **Leftover comment.** Removed the placeholder "Master data services (build step 1.8): export them here." from `server/index.ts`.

### Deviations from the plan

- **Test files.** The client tests are split into `clients.test.ts`, `client-sites.test.ts` and `client-contacts.test.ts`. The form schema and TIN and mobile helper tests are in `packages/core/src/master-data.test.ts`, and the loader test is `seed/brands-loader.test.ts`. TESTING.md is updated to match.
- **Duplicate-name lookup.** `findClientsNamed`, the lookup behind the warning, needs Engage Write, not Read. Only someone saving a client sees the warning.

### Judgement calls left for the user

All left as built; ask the user next session.

1. `findClientsNamed` (the duplicate-name lookup) needs Engage Write, not Read (see [Deviations](#deviations-from-the-plan)).
2. An edit that changes nothing still writes an `update` audit entry, as the 1.4 services do.
3. `listClientSiteOptions` and `listClientContactOptions` return an empty list for a retired client (live records only).

Also for the user:

- HR's `/admin` overview now shows a "People and organization" heading over its cards (from the new grouping). The user may prefer no heading there.
- `modules/ops.md` (line 46) says Ops creates rollout sites through Core, but the site services need Engage Write. To settle in Phase 4.
- Older lines in this file and in [BUILD_SUMMARY.md](BUILD_SUMMARY.md) mention `packages/db` for master data; [ADR 0013](adr/0013-master-data-schemas-in-core.md) supersedes them (master data lives in `packages/core`).

### Browser check

Agents had no browser tools, so no page was clicked through. These checks ran instead (seed, HTTP checks and the Done-when flow at service level), on the production build and a throwaway database, `xtreme-pulse-verify-18`, dropped afterwards:

- **Seed.** `pnpm seed:admin` printed "brands: added 13, kept 0" on the first run and "brands: added 0, kept 13" on the second.
- **Pages.** Signed in as the System Administrator through the Auth.js credentials endpoint. To skip `/change-password`, the temporary-password flag was cleared in the throwaway database. `/admin/products`, `/admin/clients`, `/admin/catalog-items`, `/admin/suppliers` and `/admin/audit` answer HTTP 200, and `/admin/products` lists all 13 products.
- **Client flow.** Run through the services the Server Actions call, not the UI. A client with two sites and one primary contact was added. `/admin/clients` shows it, and `/admin/audit` shows its four entries: one `core.client`, two `core.clientSite` labelled `<client> · <site>`, and one `core.clientContact`. Adding a client with the same name in another case was refused with the "Save anyway" message.

### Manual checks still needed (by a person, signed in)

First thing next session, with the 1.7 check.

1. The "Done when" flow in the UI, through the client sheet. On `/admin/clients`, add a client, then two sites and one contact marked primary in the sheet. Check that `/admin/products` shows all 13 products and that `/admin/audit` shows the entries.
2. The duplicate-name warning. Type an existing name in another case and leave the field: the warning and "Save anyway" appear. Editing the name clears them.
3. **Products:** retiring is refused while live catalog items exist; otherwise retire and restore work. **Catalog items:** choosing non-stock sets the warranty to 0, and the product and kind are locked (read-only) on edit. **Suppliers:** contacts (up to 20), and the products picker.
4. HR (not a System Administrator) gets the 403 no-access state on the four pages and sees no sidebar entries for them.
5. Departments: the head picker, now `EmployeePicker`, still searches and saves a head.
6. Light and dark appearance and phone width on the four pages and the client sheet.
7. Still open from 1.7: its browser check by a person ([Not done](#not-done)).
