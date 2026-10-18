# Build summary

**As of:** 2026-10-19 · **Branch:** `phase-1` · **For:** the project owner and anyone picking the work up

What has been built, what the user decided, and what is waiting. For the session-by-session detail, see [HANDOFF.md](HANDOFF.md). The specs in [BUILD_PLAN.md](BUILD_PLAN.md), [SECURITY.md](../SECURITY.md) and the [ADRs](adr/README.md) win over this file.

## Status by step

| Step | Status | Commit |
|---|---|---|
| Phase 0, 0.1–0.7 | Done | `73a73a7` |
| 0.8 Sensitive data helper | Done. Finished and committed on `phase-1`. Phase 0 is complete | `2b7c959` |
| 1.1 Core schemas and seed script | Done | `78d22b6` |
| 1.2 Sign-in, password change and status check | Done, plus a follow-up. The user did the browser checks | `54cbe7a`, `8cddb26` |
| Dev fix: LAN dev origins | Done | `823a8d2` |
| 1.3 Audit log, notifications and sensitive reveal | Done, verified and committed on `phase-1`. Open items settled and the changed-sensitive-field fix done ([Open items](#open-items-settled-2026-10-03)) | `84667ff` |
| 1.4 Departments, positions and company settings | Done, verified, with the review fixes (decisions 20–30). See [HANDOFF.md](HANDOFF.md#approved-14-plan) | `238a9f0` |
| 1.5 User accounts and employee numbers | Done, verified, with the review fixes (decisions 31–49) | `45f1dc4` |
| 1.6 Module access and the signed-in shell | Done, verified, with the review follow-ups (decisions 50–64) | `61c2ccb` |
| 1.7 User access page | Done and committed (decisions 65–80). Typecheck, lint and `pnpm test` pass. **Open:** the browser check by a person ([Step 1.7 summary](#step-17-summary-committed-as-be19cda)) | `be19cda` |
| 1.8 Shared master data services | Done: built, verified and committed (decisions 81–98), pushed. Typecheck, lint, Prettier, `pnpm test` (37 files, 671 tests) and the production build pass. **Open:** the browser check by a person and three judgement calls ([HANDOFF › 1.8 build status](HANDOFF.md#18-build-status-2026-10-08)) | `c1fba4f` |
| UI: Administration sidebar sub-groups | Done and committed (2026-10-09). Not pushed | `89296fb` |
| 1.9 Approvals engine | Done and committed (decisions 99–110), 2026-10-11. Not pushed | `42e64f1` |
| 1.10 Holiday calendar | Done and committed (decisions 111–132), 2026-10-12. Not pushed | `5f283bb` |
| 1.11 Directory, org chart, command bar and Home tiles | Done and committed (decisions 133–153), 2026-10-12. Not pushed. Typecheck, lint, Prettier, `pnpm test` (52 files, 910 tests) and the production build pass; the review confirmed no code bug. **Open:** the user's hands-on checks in the browser ([HANDOFF › 1.11 build](HANDOFF.md#111-build-2026-10-12)) | `2d2d3ca` |
| 2.1 Employee record and sensitive fields | Done (decisions 154–172), 2026-10-12. Typecheck, lint, Prettier, `pnpm test` (57 files, 976 tests) and the production build pass. A review focused on sensitive data found no value or last-4 leak, and fixed one "has a value" leak in the "Not filled in" badge ([HANDOFF › 2.1 review](HANDOFF.md#21-review-2026-10-12)). **Open:** the user's hands-on checks ([HANDOFF › 2.1 hands-on checks](HANDOFF.md#21-hands-on-checks-by-the-user-signed-in)), and the assumptions in [HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check) | `cd2a5a6` (not pushed) |
| 2.2 201 file, profile photo, e-signature and certifications | Done and committed (decisions 173–190), 2026-10-12. Not pushed. Typecheck, lint, `pnpm test` (65 files, 1059 tests) and the production build pass. **Open:** the user's hands-on checks ([HANDOFF › 2.2 hands-on checks](HANDOFF.md#22-hands-on-checks-by-the-user-signed-in)) | `58e3971` |
| 2.3 Payroll settings and seeded configuration | Done and committed (decisions 191–212), 2026-10-12. Not pushed. Typecheck, lint, `pnpm test` (69 files, 1126 tests) and the production build pass. The review confirmed the seed figures against COMPLIANCE.md, fixed the minimum wage warning's rounding and pinned the clock in the date-dependent tests ([HANDOFF › 2.3 review](HANDOFF.md#23-review-2026-10-12)). NCR minimum wage is ₱755 from 2026-09-26 (Wage Order NCR-28), and the de minimis limits follow RR 29-2025. Every rate is an assumption for HR or the accountant to confirm ([Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23); HANDOFF items 27–45). **Open:** the user's hands-on checks ([HANDOFF › 2.3 hands-on checks](HANDOFF.md#23-hands-on-checks-by-the-user-signed-in)) | `fffefd7` (not pushed) |
| 2.4 Work schedules and daily time entries | Built and verified 2026-10-13, not committed (decisions 213–234, [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24)): effective-dated schedules with the seeded company default, one timesheet per cut-off storing the type, Time in and Time out with manual times flagged, and overtime by kind or offset hours computed for display from the 2.3 settings and confirmed holidays. The review fixed two bugs (overlaps now compared in whole minutes; the timesheet touch now always serializes concurrent saves). Assumptions 46–61 in [HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check). Committed as `1e1cb41`, not pushed. Waiting for the user's [hands-on checks](HANDOFF.md#24-hands-on-checks-by-the-user-signed-in) | `1e1cb41` |
| 2.5 Reimbursements | Built and verified 2026-10-13 (decisions 235–255, [Reimbursements (build step 2.5)](modules/talent.md#reimbursements-build-step-25)): reimbursement types and the filing window as the versioned setting `talent.reimbursementSettings`, reimbursement lines on the timesheet with a required receipt, and one register of claimed receipts (`receiptClaims`) that rejects a merchant TIN and receipt number claimed before, by anyone, with Talent's `claimReceipt` and `releaseReceiptClaim` ready for Fiscal's petty cash in step 5.11 and "Check a receipt" for Talent Read. The review needed no code fixes ([HANDOFF › 2.5 review](HANDOFF.md#25-review-2026-10-13)). Assumptions 62–75 in [HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check). Committed 2026-10-13, not pushed. Waiting for the user's [hands-on checks](HANDOFF.md#25-hands-on-checks-by-the-user-signed-in) | `d1847a5` |
| 2.6 Onboarding checklist and change requests | Built and verified 2026-10-18 (decisions 256–276, [Onboarding checklist and change requests (build step 2.6)](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26)): a derived onboarding checklist, required but not enforced, with the assets item a placeholder; the `ONBOARDING_GATES` map with the e-signature gate wired in `applyESignature`; HR verification of government IDs and bank details; and self-service change requests through the approvals engine (`talent.changeRequest`, new collection `changeRequests`). Every Approvals read and decide registers the approval types and the signer through the new `apps/web/lib/approval-types.ts`, and `packages/ui`'s shell gained an optional `status` slot for the onboarding pill. Typecheck, lint, Prettier, `pnpm test` (82 files, 1394 tests), the production build and `pnpm seed:admin` twice pass; the security review found nothing to fix ([HANDOFF › 2.6 review](HANDOFF.md#26-review-2026-10-18)). Assumptions 84–122 in [HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check). Committed 2026-10-18, not pushed. Waiting for the user's [hands-on checks](HANDOFF.md#26-hands-on-checks-by-the-user-signed-in) | `066ce27` |
| 2.7 Timesheet approval and the DTR | Built and verified 2026-10-18 (decisions 277–298, [Timesheet approval, the DTR and the offset balance (build step 2.7)](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27)): timesheet statuses and submission with a 1-day deadline (late accepted), reminders (`talent.timesheetReminders`, with `pnpm dev:timesheet-reminders`) and the `/talent/timesheets` list behind a "Timesheets" button on `/talent`, approval by any one supervisor then HR (`talent.timesheet`), the lock, offset `credit` and `adjustment` entries (`offsetEntries`), the DTR derived when read, and the `talent.recomputeDtr` holidays-changed listener, registered by the worker at start-up. No Core change. Typecheck, lint, Prettier, `pnpm test` (88 files, 1499 tests), the production build and `pnpm seed:admin` twice pass; the review made one fix (the reconcile touches a timesheet only when it writes an adjustment) ([HANDOFF › 2.7 review](HANDOFF.md#27-review-2026-10-18)). Assumptions 123–149 in [HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check). Committed 2026-10-18, not pushed. Waiting for the user's [hands-on checks](HANDOFF.md#27-hands-on-checks-by-the-user-signed-in) | `f0ec950` |
| 2.8 Leave and offset time off | Built and verified 2026-10-19, committed as `d05d7aa`, not pushed (spec `dc7333d`; decisions 299–324, [Leave, offset time off and opening balances (build step 2.8)](modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28)): leave types as the versioned setting `talent.leaveSettings` (VL, SL and eight statutory types; days stored as text, the go-live date locked after the first opening entry) with a Leave segment in Payroll settings, leave balances from `leaveEntries` with the daily `talent.leaveCredits` job (regularization proration, January 1 credit and carry-over; `pnpm dev:leave-credits`), leave and offset time off requests (`timeOffRequests`, `LV-` and `OFS-`, approval types `talent.leave` and `talent.offsetTimeOff` on the record `talent.timeOffRequest`, serialized per employee through `timeOffFilingLocks`) on `/talent/time-off` and `/talent/time-off-requests/<id>`, time off on the DTR, offset openings, adjustments and usage, and opening entries at go-live on `/talent/opening-balances`, with year-to-date pay encrypted (`payrollOpeningEntries`, reveal category `salary`). No Core change. Verification fixed one leak of a confidential request's remarks ([HANDOFF › 2.8 build](HANDOFF.md#28-build-2026-10-19)). Assumptions 150–224 in [HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check). Then the user's [hands-on checks](HANDOFF.md#28-hands-on-checks-by-the-user-signed-in) | — |
| 2.9 Payroll run computation | **Spec written, not built** (2026-10-19; decisions 325–349, [Payroll run computation (build step 2.9)](modules/talent.md#payroll-run-computation-build-step-29)): draft payroll runs per cut-off (`payrollRuns`, `PAY-` numbers, and `payrollRunEmployees`, every amount encrypted as category `payslip`) computed from the DTR, time off, reimbursements, compensation, allowances and the payroll settings, with the new versioned setting `talent.payrollRunSettings` (contribution bases, the monthly-rated special day, the adjustment lookback); provisional basic pay for a timesheet not fully approved and settlements by difference in later runs; recomputed by HR, the nightly `talent.payrollDraftRuns` job and the holidays-changed listener; `/talent/payroll` with an audit-logged "Show amounts". No Core change. Build order in [HANDOFF › 2.9 notes](HANDOFF.md#29-notes). Assumptions 225–257 in [HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check) | — |

**Phase 1.** Every build step of Phase 1 is built and committed. Phase 1 is complete apart from the [Phase check](BUILD_PLAN.md#phase-1-pulse-core) after step 1.11, which the user runs by hand on a fresh database, and the hands-on browser checks still open for 1.7, 1.8 and 1.11.

**Phase 2.** Started 2026-10-12, on `phase-1`, built fully autonomously at the user's request: the agents' plan recommendations are approved as written, and every assumption a person must confirm is listed in [HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check).

**Pushed (2026-10-08, with step 1.8).** `phase-1` is pushed up to step 1.8: `origin/phase-1` exists and is its upstream. `89296fb`, `42e64f1` (step 1.9), `5f283bb` (step 1.10) and `2d2d3ca` (step 1.11) are not pushed yet. No pull request is open yet.

**1.2 follow-up (`8cddb26`).** Users with a temporary password land on `/change-password` in the address bar. The `callbackUrl` is carried through and sanitized again.

**Dev fix (`823a8d2`).** In dev, `allowedDevOrigins` is this machine's IPv4 addresses plus `DEV_ALLOWED_ORIGINS`. Before this, a page opened from a phone or tablet through the LAN IP never hydrated, so the nav did nothing. Production is unaffected.

## Step 0.8 summary

- **Validator.** Every collection with sensitive paths gets a `$jsonSchema` validator using the `encrypt` keyword, which works on Community 8.3 at every placement. It is installed in the index-readiness step and is idempotent.
- **Guard refusals.** `null` in a sensitive leaf (an absent field is fine; clear a value with `$unset`; null containers are allowed), `strict: false` (on the schema and per write), and `bypassDocumentValidation`.
- **Upserts.** Filters are followed through `$in`, `$nin`, `$all` and `$elemMatch`.
- **`$out` and `$merge`.** Keep the validator and validate.
- **Tests.** Vitest against a `mongodb-memory-server` replica set (the x64 binary on Windows on Arm). `PULSE_TEST_MONGODB_URI` is an explicit override. The dev database and `.env.local` are never used. See [TESTING.md](TESTING.md#sensitive-data-guard-tests).

**Accepted limitation.** The user chose to document this, not fix it. Mongoose's `middleware: false` and `connection.bulkWrite` skip the guard:

- `middleware: false` with `bypassDocumentValidation` stores plain text.
- `middleware: false` alone, or `connection.bulkWrite`, stores a silent empty placeholder.

Mitigation: an ESLint ban on `middleware` and `bypassDocumentValidation` keys and on `connection.bulkWrite`, plus review. Recorded in [ADR 0012](adr/0012-fail-closed-sensitive-fields.md#consequences) and [Sensitive data](../SECURITY.md#sensitive-data). Tests named "known limitation" pin today's behaviour.

## Step 1.3 summary (committed as `84667ff`)

### Stage 1: server

- **`auditLogs`.** Append-only through `guardWrites`, with immutable fields and full redacted before/after snapshots.
  - Sensitive paths become `$hidden: 'sensitive'`. `select: false` fields are left out.
  - Password-like keys, encrypted values and binaries become `$hidden: 'redacted'`. Booleans and `null` are kept.
  - Size caps: strings 2,000 characters, arrays 100 items, depth 20, snapshot 64 KB.
- **`recordAudit`** runs inside the caller's transaction. A failed audit write blocks the change.
- **`notifications`.** `notify`, `countUnread`, `listNotifications`, `markRead` and `markAllRead`. A user sees and marks only their own. Links must be internal.
- **`MODULES`** constant added early (module access itself is step 1.6).
- **Change password** writes one `passwordChange` entry with no password or hash.
- **Sensitive reveal.** A registry, policy and service. Who can reveal:
  - the System Administrator, HR and Accounting;
  - the employee, on their own record;
  - the Board, for HR-department subjects (salary, allowances, government IDs, bank accounts).

  Context-based reveals are denied for now. The audit entry is committed before the value is decrypted. Revealing on `/dev/ui` now needs a sign-in.
- **Tests.** `pnpm test` now covers the audit, notification and reveal rules: 165 tests at stage 1, 170 after the follow-up fix, all passing. See [TESTING.md](TESTING.md#audit-notification-and-reveal-tests).
- **Docs.** Updated first, including [TESTING.md](TESTING.md), [ADR 0010](adr/0010-manual-verification-before-automated-tests.md), [AGENTS.md](../AGENTS.md) (test scope) and [DATA_MODEL.md](DATA_MODEL.md#retention) (`## Retention`).

### Stage 2: UI

- **Toolbar bell.** An accent unread badge, capped at "99+". It refreshes on navigation, window focus and popover open, with no polling. The popover shows the latest 20, "Mark all as read", "See all", and the designed empty state "No notifications yet".
- **`/notifications`.** 30 per page, with All and Unread.
- **`/admin/audit`.** System Administrator only. URL filters, 50 per page with keyset Newer/Older paging, and an inspector with a before → after comparison.
- **Shared UI.** Inline variants of EmptyState and ErrorState, and `formatRelativeTime`.
- **Checked live** in Chromium and WebKit, light and dark, at 375 px.

### Follow-up: changed sensitive fields

- **`snapshotsForAudit(model, before, after)`** snapshots both sides of an update. A sensitive field whose stored encrypted bytes differ from `before`, or that is new, becomes `{ "$hidden": "sensitive", "changed": true }` in `after`. Unchanged ones and `before` keep `{ "$hidden": "sensitive" }`.
- Only the stored bytes are compared, in memory. Neither the ciphertext nor the value goes into the entry. Re-saving the same value also counts as changed (encryption is randomized).
- The audit page shows the marker as "Hidden (sensitive), changed" in the changed fields list.
- Five new tests in `audit.test.ts`. Docs: [Audit logging](../SECURITY.md#audit-logging), [Audit log](modules/core.md#audit-log), BUILD_PLAN decision 19, CHANGELOG.

## Step 1.7 summary (committed as `be19cda`)

Committed on `phase-1` as `be19cda` "feat(core,ui,web,worker): step 1.7 user access" (57 files) on 2026-10-06, and pushed. At the commit, typecheck, lint and `pnpm test` (28 files, 495 tests) pass, and the production build of `apps/web` succeeds with no `/dev` routes.

### What was built

- **Access service** (`packages/core/src/server/access/service.ts`): `listUserAccess`, `getUserAccess`, `saveUserAccess`, `countUsersNeedingAccessFor` and `countUsersNeedingAccess`. A save is refused when `moduleAccessChangedAt` moved since the sheet loaded, and writes one `accessChange` audit entry per changed module.
- **`/admin/access`.** The page and sheet: stat tiles, the pinned "Needs access" group, search and filters, the System Administrator switch, read-only rows, and `?user=` to open a user's sheet.
- **Needs-access count** in the sidebar and on the `/admin` overview.
- **Notifications.** `notify()` takes a `dedupeKey`, so a notification can't be sent twice. New-user and position-change notifications leave out both the actor and the user being changed.
- **Daily access reminder** at 8:00 AM Manila, in the worker.
- **System account Disable and Enable** on `/admin/users`.
- **`pnpm recover:admin`** (`scripts/recover-admin.ts`), with tests.

### Assumptions made in the build

1. While a user is, or is becoming, a System Administrator, the module levels sent with a save are ignored. Turning the switch on discards unsaved level edits, and the dialog warns about it.
2. The stat tiles leave out the system account, count System Administrators as having access, and count a module as in use at Read or above.
3. Filters apply to the "Needs access" group, but the count and the tiles are unfiltered.
4. The `/admin` overview "card" is a row in the existing list.
5. Cancel reads "Set access later" whenever the user still needs access.
6. The "Waiting since" line on the Needs access tile wasn't built.
7. The sidebar count always uses the accent colour. The reference design shows a white pill on the current item.
8. The Overview icon changed to `LayoutGrid`.
9. The agent wrote the wording for the system account Disable and Enable dialogs.
10. A disabled system account is listed only under "Show separated".

### Not done

- **Browser check by a person.** Agents couldn't sign in. Still to check: light and dark appearance, phone width, the sheet's dialogs, and the full "Done when" flow: HR sets Talent Write for a user, Talent shows in that user's sidebar, `/admin/audit` shows both levels (None → Write), and HR's own row is read-only.

## User decisions

### Step 0.8

| Topic | Decision |
|---|---|
| `null` in a sensitive leaf | Refused. An absent field is fine |
| `bypassDocumentValidation` | Refused |
| Validator | Use the `encrypt` keyword |
| Test framework | Vitest |
| Test database | `mongodb-memory-server` |
| `$setOnInsert` on a sensitive field | Refused |
| Existing plain text in the database | An ADR note only |
| `middleware: false` and `connection.bulkWrite` | Document as a known limitation, don't fix |
| Commits | On `phase-1` |
| HANDOFF.md | Stays untracked |

### Step 1.3

| # | Decision |
|---|---|
| 1 | Collections are `auditLogs` and `notifications` |
| 2 | Add the `MODULES` constant now |
| 3 | Keep everything forever, no deletion. Philippine-law retention and erasure are set aside for this internal app. The redaction rules still apply |
| 4 | Full before/after snapshots, not diffs |
| 5 | A failed audit write blocks the change |
| 6 | The audit page is System Administrator only; everyone else gets not-found until 1.6 |
| 7 | The dev sample can be revealed by the System Administrator, HR and Accounting |
| 8 | Context-based reveals are denied until their phases |
| 9 | No reason is required to reveal |
| 10 | Viewing the audit log and marking notifications read are not logged |
| 11 | The badge refreshes without polling |
| 12 | A full `/notifications` page |
| 13 | An accent badge; no reference design exists |
| 14 | No `notify` dedupe until 1.7 |
| 15 | Automated tests extend beyond the guard |
| 16 | 1.3 may change 0.8's reveal code |

### Step 1.4 (plan approved 2026-10-03; BUILD_PLAN decisions 20–30)

| # | Decision |
|---|---|
| 1 | System-wide settings are only the upload limits (`core.fileUploads`), versioned from today in Manila |
| 2 | A narrow public `/company-logo` route serves only the current logo (PNG, JPEG, WebP), a module access exception |
| 3 | A weekly reminder job (Mondays 08:00 Manila) notifies active HR and System Administrators while any detail is a placeholder, at most once per recipient per Manila day; a banner on Home and `/admin` lists the missing details |
| 4 | Retire is blocked while a department has live positions or active employees, or a position has active employees. `HR`, `ACCT` and `BOD` are not protected. Retire is a soft delete; restore is allowed; codes are never reused |
| 5 | A position's department is fixed; a timesheet type change takes effect from the next cut-off |
| 6 | One upload settings change per Manila day; a second is refused |
| 7 | Re-adding a removed email domain restores it; removing the last domain or the acting admin's own domain is refused |
| 8 | The logo counts as a company detail |
| 9 | A department head is any active employee, optional |
| 10 | Automated tests for the 1.4 services |
| 11 | Not-found with HTTP 200 on the new pages, deferred to 1.6 |

Access until 1.6: departments and positions for HR and the System Administrator; everything on `/admin/settings` for the System Administrator only. The implementation plan and build order are in [HANDOFF.md](HANDOFF.md#approved-14-plan).

## Open items (settled 2026-10-03)

| # | Item | Decision |
|---|---|---|
| 1 | When a sensitive field changes, both snapshots showed "Hidden" | Approved and **fixed**: the changed field is marked "Hidden (sensitive), changed" ([Follow-up](#follow-up-changed-sensitive-fields)) |
| 2 | Non-admins on `/admin/audit` get the not-found page with HTTP 200 (streaming loading boundary) | **Deferred to step 1.6**, no code change now |
| 3 | The audit page breadcrumb shows "Administration" | **Kept** as it is |
| 4 | Spec readings: an employee can reveal every category on their own record; HR can reveal other HR staff's values; booleans under password-like keys are kept in snapshots | **Confirmed.** The docs say so explicitly ([Sensitive data](../SECURITY.md#sensitive-data), [Audit logging](../SECURITY.md#audit-logging), BUILD_PLAN decision 19) and the code matches |

Verified and committed as `84667ff` (2026-10-03). Not pushed.

## Known issues and notes

| Issue | Status |
|---|---|
| `packages/db/src/define-model.ts`'s `insertMany` pre hook reads `options.session`, but Mongoose 9 passes only `[arr]`. An `insertMany` in a transaction waits for indexes | Not fixed |
| Leftover local database `xtreme-pulse-verify12` | Safe to drop |
| The lint rule flags any object key named `middleware` in `apps/`, `packages/` and `scripts/` | By design (0.8 mitigation) |
| Audit append-only is enforced in Mongoose only. Raw driver calls can bypass it | Accepted |
| Reveal registrations are in-process. A module must register before its reveals are used | Note for later modules |
| `/admin/audit` returns HTTP 200 with the not-found page for non-admins; the 1.4 pages will too | Fixed in 1.6 (`61c2ccb`): HTTP 403 with the no-access state |
| Step 1.7 not yet browser-checked by a person | Open ([Not done](#not-done)) |
| Step 1.8 not yet browser-checked by a person (agents had no browser tools; seed, HTTP and service-level checks passed) | Open ([HANDOFF › Manual checks still needed](HANDOFF.md#manual-checks-still-needed-by-a-person-signed-in)) |
| A logo file saved before a failed transaction is left orphaned in `storage/` | Accepted (1.4) |

## Next steps

1. ~~Settle the [open items](#open-items-settled-2026-10-03).~~ Done.
2. ~~Fix the changed-sensitive-field gap.~~ Done.
3. ~~Verify all of 1.3 (typecheck, lint, `pnpm test`, review, browser checks).~~ Done.
4. ~~Commit 1.3, with the user's go-ahead.~~ Done: `84667ff`.
5. ~~Step 1.4, "Departments, positions and company settings".~~ Done: `238a9f0`. Steps 1.5 (`45f1dc4`), 1.6 (`61c2ccb`) and 1.7 (`be19cda`) followed; details in [HANDOFF.md](HANDOFF.md#phase-1-status).
6. **Browser-check steps 1.7 and 1.8 by hand**, first thing next session ([Not done](#not-done), [HANDOFF › Manual checks still needed](HANDOFF.md#manual-checks-still-needed-by-a-person-signed-in)).
7. ~~Step 1.8, "Shared master data services".~~ Done: built, committed and pushed (2026-10-08). The user still has three judgement calls to settle ([HANDOFF › Judgement calls](HANDOFF.md#judgement-calls-left-for-the-user)).
8. ~~Step 1.9, "Approvals engine".~~ Done: committed as `42e64f1` (2026-10-11), not pushed.
9. ~~Step 1.10, "Holiday calendar".~~ Done: committed as `5f283bb` (2026-10-12), not pushed.
10. ~~Step 1.11, "Directory, org chart, command bar and Home tiles".~~ Done: committed as `2d2d3ca` (2026-10-12), not pushed. Still open: **the user's hands-on checks** ([HANDOFF › 1.11 manual checks](HANDOFF.md#111-manual-checks-by-the-user-signed-in)).
11. **The Phase 1 check** ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core)), run by the user by hand on a fresh database. With it, Phase 1 is complete.
12. ~~Step 2.1, "Employee record and sensitive fields".~~ Done: committed as `cd2a5a6` (2026-10-12), not pushed. Still open: **the user's hands-on checks** ([HANDOFF › 2.1 hands-on checks](HANDOFF.md#21-hands-on-checks-by-the-user-signed-in)).
13. ~~Step 2.2, "201 file, profile photo, e-signature and certifications".~~ Done: committed as `58e3971` (2026-10-12), not pushed. Still open: **the user's hands-on checks** ([HANDOFF › 2.2 hands-on checks](HANDOFF.md#22-hands-on-checks-by-the-user-signed-in)).
14. ~~**Step 2.3, "Payroll settings and seeded configuration".**~~ Done: committed as `fffefd7` (2026-10-12), not pushed. Still open: **the user's hands-on checks** ([HANDOFF › 2.3 hands-on checks](HANDOFF.md#23-hands-on-checks-by-the-user-signed-in)). Before the first real payroll, HR and the accountant check every seeded rate ([Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23)).
15. **Step 2.4, "Work schedules and daily time entries".** Built and verified (2026-10-13, decisions 213–234), with two review fixes ([HANDOFF › 2.4 review](HANDOFF.md#24-review-2026-10-13)), committed as `1e1cb41`, not pushed. Next: the user's [hands-on checks](HANDOFF.md#24-hands-on-checks-by-the-user-signed-in). HR checks assumptions 46–61 (the break, how overtime is measured, rest-day and holiday marking, local holidays, entries past midnight, what a supervisor can infer) before real time entries.
16. **Step 2.5, "Reimbursements".** Built and verified (2026-10-13, decisions 235–255), reviewed ([HANDOFF › 2.5 review](HANDOFF.md#25-review-2026-10-13)), committed as `d1847a5`, not pushed. Next: the user's [hands-on checks](HANDOFF.md#25-hands-on-checks-by-the-user-signed-in). The accountant checks assumptions 62–65 and 73 (the TIN branch code, receipt number matching, invoices as receipts, receipts made out to the company), and HR and counsel 66–72, 74 and 75, before real claims.
17. **Step 2.6, "Onboarding checklist and change requests".** Built and verified (2026-10-18, decisions 256–276), reviewed ([HANDOFF › 2.6 review](HANDOFF.md#26-review-2026-10-18)), committed as `066ce27`, not pushed. Next: rerun `pnpm seed:admin` on existing development databases (it adds `talent.onboardingSettings`), then the user's [hands-on checks](HANDOFF.md#26-hands-on-checks-by-the-user-signed-in). The user confirms assumptions 88, 89, 96–98 and 100–101 (the gate map in code, the system account exemption, supervisors approving rather than editing, the routing and module access, no withdraw, who sees the onboarding filter); HR and counsel the rest of 84–101; the build's own choices are 102–122.
18. **Step 2.7, "Timesheet approval and the DTR".** Built and verified (2026-10-18, decisions 277–298), reviewed with one fix ([HANDOFF › 2.7 review](HANDOFF.md#27-review-2026-10-18)), committed as `f0ec950`, not pushed. Next: the user's [hands-on checks](HANDOFF.md#27-hands-on-checks-by-the-user-signed-in). HR and counsel check assumptions 128–130 and 138 (lates, undertime, holidays) before real attendance is deducted; the user checks 125, 135 and 137; the build's own choices are 138–149.
19. **Step 2.8, "Leave and offset time off".** Spec written (2026-10-18, decisions 299–324, `dc7333d`) and built and verified (2026-10-19, [HANDOFF › 2.8 build](HANDOFF.md#28-build-2026-10-19)), committed as `d05d7aa`, not pushed. Next: rerun `pnpm seed:admin` on existing development databases (it adds `talent.leaveSettings`); then the user's [hands-on checks](HANDOFF.md#28-hands-on-checks-by-the-user-signed-in). Counsel checks assumptions 152, 153, 165, 175, 206 and 210 (Service Incentive Leave, the statutory leave figures, VAWC confidentiality, service months, who opens an attachment, the confidential label in messages; 152, 206 and 210 are marked Legal), and the user 164 (an HR requester's time off goes to the System Administrator); the build's own choices are 181–221, and verification's 222–224.
20. **Step 2.9, "Payroll run computation".** Spec written, not built (2026-10-19, decisions 325–349). Next: build it in the chunks in [HANDOFF › 2.9 notes](HANDOFF.md#29-notes), verify and commit, not push. The accountant and counsel check the **Legal** assumptions 225, 228–230, 234–236, 238, 243, 250 and 254 (contribution bases, withholding, minimum wage earners, de minimis, holiday pay, night differential, maternity pay, payslip encryption, basic salary earned) before the first real payroll; the user checks 241, 242 and 248 (no automatic back pay, settlements against finalized runs only, how drafts are created and refreshed).

## Step 1.8 brief (done)

Kept for the record. Where it says `packages/db`, [ADR 0013](adr/0013-master-data-schemas-in-core.md) supersedes it: master data lives in `packages/core`.

**Shared master data services** ([BUILD_PLAN.md](BUILD_PLAN.md#phase-1-pulse-core), Phase 1 step 8). Full detail, the Spec links and the open questions are in [HANDOFF.md](HANDOFF.md#step-18-brief-done).

- **Goal.** Master data schemas in `packages/db` (superseded: `packages/core`, ADR 0013) and their services in `packages/core`: clients with sites and contacts, products (`brands`), catalog items and suppliers. Seed the products. Basic System Administrator screens under `/admin`. Engage (Phase 3) and Supply (Phase 4) build the full screens on these services later.
- **Done when:** the System Administrator adds a client with two sites and a contact, and the products list shows all 13 seeded brands.
- **Workflow.** Read the Spec docs, show a plan, and wait for the user's approval before any code. Spec changes go in the docs first.
