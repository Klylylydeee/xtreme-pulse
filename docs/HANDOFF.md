# Build handoff

**Date:** 2026-10-08 · **Branch:** `phase-1` · **For:** the next Claude Code session and the project owner

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

`phase-1` is pushed (2026-10-08, with step 1.8): `origin/phase-1` exists and is its upstream. No pull request is open yet. `phase-0` is not pushed.

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
| | "feat(core,web): step 1.8 shared master data" | Step 1.8 shared master data, with `docs/HANDOFF.md` and `docs/BUILD_SUMMARY.md`. Pushed (2026-10-08) |

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
| 1.9 Approvals engine | Not started. **Next build step** ([Next: step 1.9](#next-step-19)) |
| 1.10 Holiday calendar | Not started |
| 1.11 Directory, org chart, command bar and Home tiles | Not started |

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
12. **Step 1.9**, "Approvals engine": read its Spec docs, then show a plan and **wait for the user's approval before any code**. See [Next: step 1.9](#next-step-19).

## Next: step 1.9

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
