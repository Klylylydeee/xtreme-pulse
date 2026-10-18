# Data model

How data is stored, owned, numbered and changed in Xtreme Pulse. The business meaning of each record is in the [module specs](modules/README.md). This file holds the rules every collection follows.

## Data rules (critical)

### Money
- Never use floating point for money. Store amounts as integers in centavos (`amountCentavos`) or `Decimal128`. Currency default: PHP.
- Round only at the line level (half-up to the centavo), never on intermediate values.
- Any operation touching more than one collection (e.g. posting an invoice → ledger + AR + the billing milestone's status) runs inside a MongoDB transaction (`session.withTransaction`).

### Ledger (Pulse Fiscal)
- Journal entries are append-only. Never update or delete a posted entry; correct with a reversal entry.
- Debits must equal credits; validate before commit.
- VAT is 12% unless the client is zero-rated or VAT-exempt (set per client; see [Clients, sites and contacts](modules/engage.md#clients-sites-and-contacts)). Support EWT and BIR Form 2307 generation.

### Inventory (Pulse Supply)
- Stock is tracked as movement documents (receipt, transfer, issue-to-project, issue-to-ticket, issue-to-employee, delivery to client, return, RMA). On-hand quantity is derived, never edited directly.
- Serialized items live in their own collection with a status history: supplier (or the client, for client-owned units received without a PO) → office stock → project / employee → client site (delivered → installed) → RMA / retired.
- The serial number is the cross-module thread: it must be traceable to supplier, PO, project, client site, assigned employee, warranty and tickets.

### General
- Soft delete (`deletedAt`) for business records; no hard deletes outside admin tooling.
- All documents have `createdAt`, `updatedAt`, `createdBy`, `updatedBy`.
- Index frequent lookups: serial number, client, project, ticket status, renewal/due dates, employee + cut-off period, merchant TIN + receipt number (the unique register `receiptClaims`, build step 2.5).
- Store dates in UTC; display in Asia/Manila.

## Collection ownership

Each module owns its collections, and no module writes to another module's collections (see [Architecture rules](ARCHITECTURE.md#architecture-rules)). The owner of each record below comes from the spec section that defines it. Collection names in `code` are the ones the spec or build plan already fixes. Name the rest when they're built, following [Naming](#naming), and add them here.

| Module | Owns |
|---|---|
| Core | User accounts (`users`), employee identity (`employees`), departments (`departments`), positions (`positions`), allowed email domains (`allowedEmailDomains`), employee number counters (`employeeNumberCounters`), document number counters (`documentNumberCounters`), versioned configuration (`configVersions`), stored file records (`storedFiles`, the metadata of every uploaded and generated file; see [File storage](ARCHITECTURE.md#file-storage)), the field encryption key vault (`encryptionKeys`, in MongoDB's key vault format, so without the base fields; see [ADR 0005](adr/0005-field-level-encryption.md)), company settings (`companySettings`), clients (`clients`) with sites (`clientSites`) and contacts (`clientContacts`), products (`brands`), catalog items (`catalogItems`), suppliers (`suppliers`), holidays (`holidays`), approval requests (`approvalRequests`), notifications (`notifications`), audit log (`auditLogs`) |
| Talent | Employee records (`employeeRecords`, from build step 2.1: personal, employment, government IDs, bank account), compensation history (`compensationEntries`, build step 2.1), 201 documents (`employeeDocuments`, build step 2.2), e-signatures (`eSignatures`) and their uses (`signatureApplications`, build step 2.2), certifications (`certifications`, build step 2.2), work schedules (the company default as the versioned setting `talent.workSchedule`, and employees' own schedules in `workScheduleAssignments`, build step 2.4), timesheets (`timesheets`, one per employee per cut-off, and their time entries in `timeEntries`, build step 2.4; their reimbursement lines in `reimbursements`, build step 2.5; their submission and approval status, build step 2.7), offset entries (`offsetEntries`, build step 2.7), leave types (the versioned setting `talent.leaveSettings`, build step 2.8), leave entries (`leaveEntries`, build step 2.8), leave and offset time off requests (`timeOffRequests`, build step 2.8), year-to-date pay at go-live (`payrollOpeningEntries`, build step 2.8), payroll settings and allowance types (versioned configuration, build step 2.3), allowance assignments (`allowanceAssignments`, build step 2.3), payroll runs and payslips, remittances, HR documents, due-process cases, onboarding (derived, never stored, build step 2.6: its required documents as the versioned setting `talent.onboardingSettings`, and its verifications and "No supervisor" confirmation on `employeeRecords`), change requests (`changeRequests`, build step 2.6), the register of claimed receipts (`receiptClaims`, build step 2.5; Fiscal's petty cash vouchers claim through it from step 5.11) |
| Engage | Deals and deal teams, deal registrations, pre-sale site surveys, BOQs, quotations, sales quotas and assignments, Engage settings (stages, business lines, lost reasons, payment term templates) |
| Ops | Projects and project teams, project site surveys, billing milestones, assignments (the calendar), daily site reports, checklist templates and results, rollout sites, acceptance records, manual subcontractor cost rows |
| Supply | Purchase requests, purchase orders (`purchaseOrders`), receiving records, stock movements, serial items (`serialItems`), stock locations, delivery receipts, RMAs |
| Fiscal | Chart of accounts, journal entries, accounting periods, sales invoices, collections, supplier bills, disbursement vouchers, bank accounts and statements, petty cash funds and vouchers |
| Desk | Tickets, queues, SLA targets and timers, warranties, support contracts, subscriptions, POS terminals, service reports, chargeable work |
| Insight | Targets, month-end snapshots |

Core and Talent describe the same person under one `employeeId` (see [People data ownership](modules/core.md#people-data-ownership)). Two Core fields that sign-in depends on (build step 1.5): `employees.separationDate`, the separation date (the Manila day at 00:00, stored as UTC; null unless the employee is separated), and `users.sessionsValidFrom`, set by a password reset, before which no session counts (see [Account status](../SECURITY.md#account-status), [Sign-in and passwords](../SECURITY.md#sign-in-and-passwords)). From build step 1.6 the account also holds `users.moduleAccess`, a subdocument (no `_id`) with one key per module (`engage`, `ops`, `supply`, `desk`, `fiscal`, `talent`: `none`, `read`, `write` or `owner`; `insight`: `none` or `read`), each defaulting to `none`; a missing key or subdocument reads as `none` (see [Resolving and enforcing](../SECURITY.md#resolving-and-enforcing-build-step-16)). From build step 1.7 the account also holds `users.moduleAccessChangedAt` (a date) and `users.moduleAccessChangedBy` (the acting user's id), both null until the first access change on the [User access page](modules/core.md#user-access-page), which shows them as "Last changed", and `notifications` gains `dedupeKey`, an optional string of up to 200 characters, fixed once stored, with a unique index on `{ recipientUserId, dedupeKey }` only where a key is set, so one recipient never gets the same keyed notification twice (see [Notifications](modules/core.md#notifications)). The shared master data (build step 1.8, schemas in `packages/core`, see [ADR 0013](adr/0013-master-data-schemas-in-core.md)) links by id: `clientSites.clientId` and `clientContacts.clientId` to the client, `clients.accountManagerEmployeeId` to the owning Account Manager (optional), `catalogItems.brandId` to the product, and `suppliers.brandIds` to the products supplied. Supplier contacts are embedded in the supplier (at most 20), not a collection. Seeded products carry a stable `seedKey`. Unique indexes, ignoring case (collation `en`, strength 2) and counting retired or removed records: `brands` name, `suppliers` name, `catalogItems` `{ brandId, partNumber }` and `clientSites` `{ clientId, name }`; a partial unique index allows one primary contact per client (`clientContacts` `{ clientId }` where the primary flag is set; removing a contact clears its flag). Client names and TINs aren't unique ([Managing master data](modules/core.md#managing-master-data)). The approvals engine (build step 1.9) keeps one `approvalRequests` record per submission, written only by the engine and never deleted (no soft delete): the type (`<module>.<name>`, registered), the module, the record it is about (`record.type`, `record.id`, `record.label`), title, summary, `href`, `requesterUserId`, `requesterEmployeeId`, `status` (`pending`, `approved`, `returned` or `rejected`), `currentStep`, `previousRequestId` (the returned or rejected request a resubmission follows), `submittedAt`, `settledAt`, `settledBy` and `version` (optimistic concurrency), and `steps`, each with its `kind` (`reportingTo`, `anyOf` or `allOf`), `label`, `rule` (`any` or `all`), `approvers` (`userId`, `nameSnapshot` and `asSystemAdministrator`, fixed at submit), `routedToSystemAdministrator`, `status` (`waiting`, `pending`, `approved`, `returned`, `rejected` or `skipped`) and `decisions` (`userId`, `decision`, `remarks`, `decidedAt`). Three denormalized arrays, kept by the engine, serve the lists: `pendingApproverIds` (who may decide now), `approverIds` (everyone asked, once their step became pending) and `decidedFor` (`userId`, `decidedAt`; one entry per approver per decision that ended their part in a step: the decider, and the approvers that decision took the item from), which drives the Decided list and its order (the user's latest `decidedAt`, then `_id`, newest first). Indexes: `{ pendingApproverIds, submittedAt }`, `{ decidedFor.userId }`, `{ record.type, record.id, submittedAt }`, `{ requesterUserId, submittedAt }`, and a partial unique index on `{ record.type, record.id }` where the status is `pending`, so a record has at most one pending request ([Approvals](modules/core.md#approvals)). The holiday calendar (build step 1.10) keeps one `holidays` record per holiday, with the base fields and soft delete (`deletedAt`): `name` (up to 100 characters), `date` (the Manila day at 00:00, stored as UTC, like `employees.separationDate`; it can change only within its year), `year` (derived from `date`, so fixed once created), `type` (`regular`, `specialNonWorking` or `specialWorking`), `scope` (`nationwide` or `local`), `location` (up to 100 characters, required when the scope is local, else null: saving a nationwide holiday clears it), `legalBasis` (up to 200 characters or null; required to confirm, and a confirmed holiday can't lose it), `status` (`draft` or `confirmed`), `source` (`manual`, `rule` or `online`, fixed once created), `sourceKey` (null, `rule:<key>` or `online:<YYYY-MM-DD>`, fixed once created), `declared` (true for an ad-hoc declaration), `confirmedAt` and `confirmedBy`. Indexes: `{ year, date }`, `{ status, date }`, and a partial unique index on `{ year, sourceKey }` where `sourceKey` is a string, deleted records included, so an auto-draft or online draft is never made twice ([Holiday calendar](modules/core.md#holiday-calendar)). The directory (build step 1.11) adds an index on `employees` `{ lastName, firstName, _id }` for its sort; it adds no collection or field ([Company directory](modules/core.md#company-directory)). The serial number links Supply, Ops and Desk records (see [Inventory](#inventory-pulse-supply)).

**The Talent employee record** (build step 2.1, schemas in `packages/talent`; [The employee record](modules/talent.md#the-employee-record-build-step-21)). `employeeRecords` holds one record per employee, keyed by `employeeId` (Core's employee, fixed once created, with a **unique index**). It is created on the first Talent save and has the base fields and no soft delete: it is never deleted, and deletes and replacements are refused.

- **Personal:**
  - `dateOfBirth` (the Manila day at 00:00, stored as UTC)
  - `sex` (`SEXES`: `male`, `female`)
  - `civilStatus` (`CIVIL_STATUSES`: `single`, `married`, `widowed`, `separated`, `annulled`)
  - `nationality` (up to 100 characters)
  - `presentAddress` and `permanentAddress` (up to 500 characters each)
  - `mobileNumber` (11 digits) and `personalEmail`
  - `emergencyContact`, a subdocument with no `_id`: `name`, `relationship`, `mobileNumber`

  Each is null until entered.
- **Employment:**
  - `workRegion` (`WORK_REGIONS`, default `NCR`). The values are `NCR`, `CAR`, `I`, `II`, `III`, `IV-A`, `MIMAROPA`, `V`, `VI`, `NIR`, `VII`, `VIII`, `IX`, `X`, `XI`, `XII`, `XIII` and `BARMM`. *Assumption, to be confirmed by HR or counsel.*
  - `contractEndDate` and `regularizationDate` (Manila days, or null)
  - `separationRemarks` (up to 1,000 characters, or null)
- **`governmentIds`** (a nested object): `tin`, `sss`, `philhealth` and `pagibig`, each a `sensitiveField()` holding a digit string; and `rdoCode` (3 digits, plain, or null).
- **`bankAccount`** (a nested object): `bank` (`PAYROLL_BANKS`: `unionbank`, `rcbc`), `accountNumber` (a `sensitiveField()` holding a digit string) and `accountName` (up to 200 characters, plain).
- **`version`**: a number raised by every save, for the stale-form check.

The collection has the `$jsonSchema` validator for its sensitive paths ([Sensitive data](../SECURITY.md#sensitive-data)).

`compensationEntries` holds the append-only salary history:

- **Fields:**
  - `employeeId`
  - `effectiveDate` (the Manila day at 00:00, stored as UTC)
  - `basicSalaryCentavos` (a `sensitiveField()` holding a whole number of centavos)
  - `rateType` (`RATE_TYPES`: `monthly`, `daily`)
  - `minimumWageEarner` (true or false)
  - `reason` (1 to 1,000 characters)
  - `minimumWageWarningConfirmed` (true when HR chose "Save anyway" on the minimum wage warning; build step 2.3. Entries saved before step 2.3 lack it and read as false)
  - the base fields
- **Insert-only:** every update, replacement and delete is refused.
- **Index:** `{ employeeId, effectiveDate: -1, createdAt: -1 }`.
- **Current entry:** the latest effective date on or before today in Manila; on a tie, the latest created wins.

The formats are in [The employee record](modules/talent.md#the-employee-record-build-step-21).

**Documents, photo, e-signature and certifications** (build step 2.2, [the spec](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22)). Every date below is a Manila day at 00:00, stored as UTC.

- **Core additions:**
  - `employees.photoFileId`: the stored file of the current profile photo, or null.
  - `approvalRequests.steps[].decisions[].signature`: a subdocument with no `_id`, `{ applicationId, signatureId, version }`, set on an approve decision when an e-signature was applied, else null.
- **`employeeRecords.skills`:** an array of up to 30 strings of up to 50 characters, unique ignoring case, default empty.
- **`employeeDocuments`**, the 201 file. Base fields, no soft delete, never deleted (deletes and replacements are refused):
  - `employeeId` and `fileId`, both fixed once set
  - `type` (`DOCUMENT_201_TYPES`: `employmentContract`, `regularizationEvaluation`, `governmentIdCopy`, `nbiClearance`, `medicalCertificate`, `diplomaTor`, `other`)
  - `title` (up to 200 characters; required for `other`, else optional)
  - `issueDate` (required, not in the future) and `expiryDate` (or null; after `issueDate`)
  - `archivedAt`, `archivedBy` and `archiveReason` (up to 500 characters), all null until archived. An archived document is never changed again; a renewal archives the one it replaces with the reason "Replaced by a renewed document."
  - `version`, raised by every save
  - Indexes: `{ employeeId, createdAt: -1 }`, and `{ expiryDate }` limited to unarchived documents with an expiry date.
- **`eSignatures`.** Insert-only, no soft delete:
  - `employeeId`, `version` (1, 2, 3…), `fileId` and the base fields
  - Unique index: `{ employeeId, version }`. The current signature is the highest version.
- **`signatureApplications`.** Insert-only, no soft delete. One row per use of an e-signature:
  - `employeeId`, `userId`, `signatureId`, `signatureVersion` and `fileId` (copied, so the use stays pinned)
  - `target` (`type`, `id`, `label`; for example `core.approvalRequest`), `purpose` (`approval` in step 2.2) and `appliedAt`
  - Indexes: `{ employeeId, appliedAt: -1 }` and `{ target.type, target.id }`.
- **`certifications`.** Base fields with soft delete:
  - `employeeId`
  - `name` and `issuer` (each required, up to 200 characters)
  - `brandId` (a Core product, or null)
  - `licenseNumber` (up to 100 characters, plain, or null)
  - `issueDate` (required; may be in the future), `expiryDate` (or null; after `issueDate`) and `attachmentFileId` (or null)
  - `version`
  - Indexes: `{ employeeId }`, `{ brandId }`, `{ expiryDate }`.

**Allowances** (build step 2.3, [the spec](modules/talent.md#payroll-settings-and-allowances-build-step-23)). The allowance types are the versioned setting `talent.allowanceTypes` ([Versioned configuration](#versioned-configuration)). An automatic type (the internet allowance) is derived from Core's date hired and never stored.

- **`allowanceAssignments`.** Insert-only, no soft delete, never deleted (updates, replacements and deletes are refused):
  - `employeeId`
  - `typeKey` (a key from `talent.allowanceTypes`; a new assignment needs an active type)
  - `effectiveDate` (the Manila day at 00:00, stored as UTC; on or after the date hired, at most a year ahead)
  - `kind` (`ALLOWANCE_ASSIGNMENT_KINDS`: `set`, `end`)
  - `amountCentavos` (a `sensitiveField()` holding a whole number of centavos above zero, in the type's basis; absent for `end`)
  - `reason` (1 to 1,000 characters)
  - the base fields
  - Index: `{ employeeId, typeKey, effectiveDate: -1, createdAt: -1 }`.
  - The collection has the `$jsonSchema` validator for its sensitive path.
- **In effect on a day:** for each type, the latest entry with an effective date on or before that day, the latest created on a tie; `end` means none. An automatic type with no such entry applies from the date hired at the default amount in effect that day, while it is active in that day's version. Before the date hired, nothing applies.

## Naming

- Collections: plural camelCase (`purchaseOrders`, `serialItems`)
- Fields: camelCase; references end in `Id` (`clientId`, `projectId`)

## Document numbers

- Human-readable document numbers per module with a prefix: `DL-` deals, `QT-` quotes, `PRJ-` projects, `PR-` purchase requests, `PO-` purchase orders, `RCV-` receiving records, `DR-` delivery receipts, `RMA-` returns, `INV-` invoices (the actual series is a setting so it can follow the BIR-registered series), `CR-` collections, `DV-` disbursement vouchers, `JE-` journal entries, `PCV-` petty cash vouchers, `TKT-` tickets, `SC-` support contracts, `SR-` service reports, `CTR-` contracts, `EVL-` evaluations, `COE-` certificates of employment, `CLR-` clearances, `NTE-` notices to explain, `NOD-` notices of decision, `TN-` termination notices, and from build step 2.8 `LV-` leave requests and `OFS-` offset time off requests (`timeOffRequests`; *Assumption*, decision 309)
- Employee numbers use `YYYY-NN` (see [Employee number](modules/core.md#employee-number-company-id))
- Business documents use the format `PREFIX-YYYY-NNNN`, for example `QT-2026-0012`. Quotation revisions add `Rev N` (see [Quotations](modules/engage.md#quotations)), and HR documents use the same pattern (for example `COE-2027-0001`).
- Numbers come from atomic per-prefix, per-year counters (build step 0.6), so two records can never share a number.

## Versioned configuration

Rates and tables that change by law or policy are stored as versioned, effective-dated configuration, never hardcoded. A calculation uses the version in effect on the date it applies to. A change is a new version with its own effective date, never an edit to an old one. The configuration store is built in step 0.6.

The spec calls for versioning for:

| Configuration | Spec |
|---|---|
| SSS, PhilHealth and Pag-IBIG contribution tables (with EC), BIR withholding tax tables, holiday and overtime premium rates, de minimis limits | [Pay computation per cut-off](modules/talent.md#pay-computation-per-cut-off) |
| 13th month and other benefits tax-exempt ceiling | [13th month pay](modules/talent.md#13th-month-pay) |
| Regional minimum wage rates | [Minimum wage check](modules/talent.md#minimum-wage-check) |
| VAT rate | [Quotations](modules/engage.md#quotations) |
| BIR ATC codes and EWT rates, tax forms, tax due dates | [Supplier bills (AP)](modules/fiscal.md#supplier-bills-ap), [BIR tax reports](modules/fiscal.md#bir-tax-reports) |
| Salary and allowance history, work schedules | [Compensation](modules/talent.md#compensation), [Work schedule](modules/talent.md#work-schedule) |
| Holiday auto-draft rules (`core.holidayRules`, build step 1.10) | [Holiday calendar](modules/core.md#holiday-calendar) |
| Expiry alert lead days (`talent.expiryAlerts`: `documentLeadDays`, `certificationLeadDays`, 1 to 180, default 30; build step 2.2) | [Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22) |
| Onboarding required documents (`talent.onboardingSettings`: `requiredDocumentTypes`, unique types from `DOCUMENT_201_TYPES` other than `employmentContract`, `regularizationEvaluation` and `other`, possibly empty; build step 2.6). Seeded by `pnpm seed:admin` from 2000-01-01 with `governmentIdCopy` and `nbiClearance`, source "Company policy (spec)". A new version takes effect today in Manila, at most one per day | [Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| Leave types, the go-live date and the offset time off minimum (`talent.leaveSettings`, build step 2.8; below) | [Leave, offset time off and opening balances](modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28) |
| Payroll settings (build step 2.3): the ten `talent.*` settings below, plus `talent.workSchedule` and `talent.timesheetSettings` from build step 2.4, and `talent.reimbursementSettings` from build step 2.5 (thirteen in all) | [Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23), [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24), [Reimbursements](modules/talent.md#reimbursements-build-step-25) |

**Payroll settings** (build step 2.3). Each is declared with `defineConfigSetting` in `packages/talent`. Every number is a whole number (centavos, days, counts); rates are decimal strings of up to 6 digits before and after the point (`"0.05"`, `"1.30"`), read exactly with `ratio`. A cut-off that doesn't wrap and ends on day 28 runs to the month's last day.

| Key | Value |
|---|---|
| `talent.payrollSettings` | `cutOffs`: exactly two `{ key: 'midMonth' \| 'endOfMonth', startDay, endDay, payDay }` (days 1–28; pay day 1–31, moved to the month's last day; together they cover the month with no overlap; the pay date is in the month the cut-off ends, after its end day). `dailyRateFactor` (261), `hoursPerDay` (8). `contributionSplit`: for each of `sss`, `philhealth`, `pagibig`, `{ midMonth, endOfMonth }` as decimal strings adding up to exactly 1. A new version must take effect on a cut-off start day of its own schedule |
| `talent.sssContributions` | `rows`: ascending, the first starting at 0, each `{ minCompensationCentavos, regularMscCentavos, mpfMscCentavos, employee: { regularCentavos, mpfCentavos }, employer: { regularCentavos, mpfCentavos }, ecCentavos }`, with regular + MPF = the MSC |
| `talent.philhealthContributions` | `{ premiumRate, employeeShare, floorCentavos, ceilingCentavos }` |
| `talent.pagibigContributions` | `brackets`: ascending `{ upToCentavos (null for the last), employeeRate, employerRate }`; `maxFundSalaryCentavos` |
| `talent.withholdingTaxSemiMonthly` | `brackets`: ascending `{ overCentavos, baseTaxCentavos, rate }`, the first `{ 0, 0, '0' }` |
| `talent.premiumRates` | `regularHolidayWorked`, `regularHolidayUnworked`, `specialDayWorked`, `specialDayUnworked`, `restDayWorked`, `specialDayOnRestDay`, `regularHolidayOnRestDay`, `overtimeOrdinaryAddOn`, `overtimeRestDayHolidayAddOn`, `nightDifferentialAddOn` (decimal strings), `nightStart`, `nightEnd` (`HH:MM`) |
| `talent.deMinimisLimits` | `items`: `{ key, label, period: 'month' \| 'semester' \| 'year' \| 'day', limitCentavos, rateOfMinimumWage }`, exactly one of the last two set, keys unique |
| `talent.thirteenthMonthExemption` | `{ exemptCeilingCentavos }` |
| `talent.minimumWages` | `regions`: `{ region (WORK_REGIONS), wageOrder, dailyRateCentavos }`, one per region (the general, non-agriculture rate) |
| `talent.allowanceTypes` | `types`: `{ key, name, taxTreatment: 'taxable' \| 'nonTaxable' \| 'deMinimis', deMinimisKey (required exactly for de minimis), basis: 'perCutOff' \| 'perDayPresent', defaultAmountCentavos, autoAssign (per cut-off types only), active }`. A key, once added, stays in every later version |
| `talent.workSchedule` (build step 2.4) | The company default schedule: `workDays` (ISO weekdays 1–7, unique, at least one), `start`, `end` (`HH:MM`; an end at or before the start ends the next day), `breakStart` (`HH:MM`), `breakMinutes` (0–180, inside the span), `graceMinutes` (0–60). Scheduled minutes (span less break) run from 60 to 1,440. Unlike `payrollSettings`, a version may take effect on any day. Seeded from 2000-01-01: `[1,2,3,4,5]`, 08:00–17:00, break 12:00 for 60, grace 15 |
| `talent.timesheetSettings` (build step 2.4) | `offsetRatio` (decimal string, above 0; seeded `"1"`), `extraHours`: `{ overtime: 'overtime' \| 'offset', standard: 'overtime' \| 'offset' }` (seeded `overtime` and `offset`). From build step 2.7, `submissionDeadlineDays` (1–10): the deadline is the end of the Manila day that many days after the period end, read from the version in effect on the period end. A version stored without it reads as 1, so no new version is seeded. Seeded from 2000-01-01 |
| `talent.leaveSettings` (build step 2.8) | `goLiveDate` (a Manila day, or null; can't change once an opening entry exists), `offsetTimeOff`: `{ minimumMinutes, stepMinutes }` (whole minutes, 15–480; seeded 60 and 30), `types`: `{ key, name, shortName, active, paid, balance: 'credited' \| 'perEvent' \| 'perYear', days (whole or half days above 0), countDays: 'workDays' \| 'calendarDays', halfDays, crediting: null \| { annualCreditOn ('MM-DD'), prorateFromRegularization, carryOverCapDays (null or ≥ 0) } (exactly for `credited`), eligibility: { employmentStatuses (non-empty, of Probationary, Regular, Contractual), sex: null \| 'female' \| 'male', minServiceMonths (null or 1–120), maxRequests (null or ≥ 1) }, filing: { minNoticeDays (null or 0–90), allowFuture, allowPast } (at least one allowed), attachment: null \| { label (1–100), required }, confidential, legalBasis (null or up to 200) }`, keys unique; a key, once added, stays in every later version. A request uses the version in effect on its filing day; the credit job the version in effect on the credit date. Seeded from 2000-01-01 with `goLiveDate` null and the ten types in [Leave, offset time off and opening balances](modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28) |
| `talent.reimbursementSettings` (build step 2.5) | `filingWindowPreviousCutOffs` (0–6), `types`: `{ key, name, active, requiresRoute, requiresDescription, requiresClient, limit: null \| { amountCentavos (above 0), per: 'line' \| 'day' } }`, keys unique. A key, once added, stays in every later version. A line uses the version in effect on its receipt date, and the filing window the version in effect today. Seeded from 2000-01-01: window 1; `meal`, `transportation` (route required) and `other` (description required), client optional, no limits |

**Timesheet collections** (build step 2.4, [Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24)). Each has the base fields.

| Collection | Fields | Indexes and rules |
|---|---|---|
| `workScheduleAssignments` | `employeeId`, `effectiveFrom` (a Manila day at 00:00, stored in UTC), `schedule` (the `talent.workSchedule` shape, or null for "back to the company default"), `reason` (1–300) | `{ employeeId, effectiveFrom, createdAt }`. Insert-only (`guardWrites`) |
| `timesheets` | `employeeId`, `periodStart`, `periodEnd`, `payDate` (Manila days), `cutOffKey` (`midMonth` \| `endOfMonth`), `timesheetType` (`TIMESHEET_TYPES`), `typeReadOn` (the Manila day the type was read), `status` (`open`; from build step 2.7 `TIMESHEET_STATUSES`: `open`, `pendingSupervisor`, `pendingHr`, `returned`, `approved`). From build step 2.7: `submittedAt`, `approvalRequestId`, `supervisorApprovedAt`, `supervisorApprovedBy`, `approvedAt`, `approvedBy`, `returnedAt`, `returnedBy`, `returnRemarks` (up to 1,000), each null until set | Unique `{ employeeId, periodStart }`; from step 2.7 also `{ periodStart, status }` for the timesheets list and the reminders. The type is never changed, and a timesheet is never deleted. The write guard allows the time entry and reimbursement saves' touch (`$set` of `updatedBy` and `updatedAt` with `$inc` of `__v`, which serializes an employee's concurrent saves) and, from step 2.7, `$set` of the status fields above, written only by the timesheet service and its approval hooks. Entries and reimbursement lines change only while the status is `open` or `returned`; `approved` is final. A period shortened by a later `payrollSettings` version keeps its cut-off's pay date |
| `timeEntries` | `employeeId`, `timesheetId`, `date` (the Manila day of the time in), `timeIn`, `timeOut` (null while open), `timeInSource`, `timeOutSource` (`clock` \| `manual`), `activity` (1–500, required once the entry has a time out), `clientId` (null or a Core client), `extraHours` (null or `{ reason }`, 1–300), `version`, `deletedAt` | `{ employeeId, date }`, `{ timesheetId }`. At most one open entry per employee; no overlaps, compared in whole minutes (seconds dropped); soft delete only. A retired client stays on the entry and shows as "Removed client". No project or ticket field until Phases 4 and 6 |
| `reimbursements` (build step 2.5, [Reimbursements](modules/talent.md#reimbursements-build-step-25)) | `employeeId`, `timesheetId` (both never changed), `receiptDate` (a Manila day), `typeKey`, `merchant` (1–120), `merchantTin` (the canonical 14 digits), `receiptNumber` (1–40, as typed), `amountCentavos` (a positive integer), `receiptFileId` (required), `clientId` (null or a Core client), `pickUp`, `dropOff` (1–200, or null), `description` (1–300, or null), `receiptClaimId`, `version`, `deletedAt` | `{ employeeId, receiptDate }`, `{ timesheetId }`. Soft delete only, which releases the line's claim in the same transaction. Not encrypted: nothing here is sensitive. No project field until Phase 4 |
| `receiptClaims` (build step 2.5) | `merchantTin` (14 digits), `receiptKey` (capitals, letters and digits only, leading zeros dropped), `claimType` (`talent.reimbursement`; `fiscal.pettyCashVoucher` from step 5.11), `claimId`, `employeeId` (null for a voucher), `deletedAt` | Unique `{ merchantTin, receiptKey }` among live claims (`partialFilterExpression: { deletedAt: null }`), so a receipt is claimed once across employees and modules. Insert and soft delete only (`guardWrites`); the keys never change. Written only through Talent's `claimReceipt` and `releaseReceiptClaim`, in the caller's transaction |

Computed hours (worked, extra, overtime by kind, night differential, offset) are derived when read and never stored. So is the Daily Time Record (build step 2.7): its day statuses, late and undertime minutes are computed from the timesheet, the schedule and confirmed holidays every time it is read ([Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27)).

**Offset entries** (build step 2.7). Base fields, no soft delete:

| Collection | Fields | Indexes and rules |
|---|---|---|
| `offsetEntries` | `employeeId`, `kind` (`OFFSET_ENTRY_KINDS`: `opening`, `credit`, `adjustment`, `usage`; step 2.7 writes `credit` and `adjustment`, step 2.8 the others), `minutes` (a signed whole number; a credit and an opening are 0 or more), `effectiveOn` (the Manila day it counts from), `timesheetId` (a credit or a timesheet's adjustment; null otherwise), `sourceType` and `sourceId` (null in step 2.7; from step 2.8 `talent.timeOffRequest` and its id on a usage, and on a usage the listener writes for it), `reason` (up to 300, or null; required on HR's adjustment) | `{ employeeId, effectiveOn }`; a partial unique index on `{ timesheetId }` where `kind` is `credit`, so a timesheet is credited once; from step 2.8 a partial unique index on `{ employeeId }` where `kind` is `opening`, and `{ sourceType, sourceId }`. Insert-only (`guardWrites`). The balance is the sum of an employee's `minutes` and is never stored. Written only by Talent's offset service: the credit in the timesheet approval hook's transaction, adjustments by the holidays-changed listener and (from step 2.8) HR with a reason, openings by HR, usage by the time off approval hook, cancelling and the listener |

**Leave, time off and opening entries** (build step 2.8, [Leave, offset time off and opening balances](modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28)). Each has the base fields and no soft delete; every date is a Manila day at 00:00, stored as UTC.

| Collection | Fields | Indexes and rules |
|---|---|---|
| `leaveEntries` | `employeeId`, `typeKey` (a `credited` type of `talent.leaveSettings`), `kind` (`LEAVE_ENTRY_KINDS`: `opening`, `credit`, `carryOver`, `usage`, `adjustment`), `halfDays` (a signed whole number of half days: an opening 0 or more, a credit above 0, a carry-over 0 or less), `effectiveOn`, `year` (the credit or carry-over's year; null otherwise), `sourceType` and `sourceId` (`talent.timeOffRequest` and its id on a usage, or on the listener's adjustment; null otherwise), `reason` (up to 300, or null; required on HR's adjustment) | `{ employeeId, typeKey, effectiveOn }`; partial unique indexes on `{ employeeId, typeKey }` where `kind` is `opening`, and on `{ employeeId, typeKey, kind, year }` where `kind` is `credit` or `carryOver`, so the credit job is idempotent; `{ sourceType, sourceId }`. Insert-only (`guardWrites`). A type's balance is the sum of its `halfDays`, never stored. Written only by Talent's leave service |
| `timeOffRequests` | `number` (`LV-YYYY-NNNN` or `OFS-YYYY-NNNN`, fixed), `employeeId` and `requesterUserId` (fixed), `kind` (`TIME_OFF_KINDS`: `leave`, `offset`; fixed), `leaveTypeKey` (leave; null for offset), `startDate`, `endDate` (at most 366 days apart), `portion` (`TIME_OFF_PORTIONS`: `whole`, `firstHalf`, `secondHalf`, `part`; a half or part only when the two dates are the same), `fromTime`, `toTime` (`HH:MM`, `part` only, else null), `chargeableHalfDays`, `paidHalfDays`, `unpaidHalfDays` (leave; the last two for `credited` types, else null), `minutes` (offset; else null), `reason` (up to 500, or null), `attachmentFileId` (or null), `status` (`TIME_OFF_STATUSES`: `pending`, `returned`, `approved`, `rejected`, `cancelled`), `approvalRequestId`, `submittedAt`, `decidedAt`, `decidedBy`, `remarks` (up to 1,000), `cancelledAt`, `cancelledBy`, `cancelReason` (up to 500), `version` | Unique `{ number }`; `{ employeeId, startDate }`, `{ employeeId, status }`, `{ status, startDate }`. Never deleted. `rejected` and `cancelled` are final; `approved` changes only to `cancelled` (before the first day) or through the listener's new split. Written only by Talent's time off service and its approval hooks. Overlap is checked in a transaction serialized per employee. Not encrypted: only the attachment file is sensitive (category `medical`) |
| `payrollOpeningEntries` | `employeeId`, `year` (of `goLiveDate`), `asOf` (`goLiveDate`), `grossCentavos`, `basicSalaryEarnedCentavos`, `taxableCompensationCentavos`, `taxWithheldCentavos`, `sssEmployeeCentavos`, `philhealthEmployeeCentavos`, `pagibigEmployeeCentavos` (each a `sensitiveField()` holding a whole number of centavos, 0 or more), `supersedesId` (the entry it corrects, or null), `reason` (1–300; required on a correction, else null) | `{ employeeId, year, createdAt: -1 }`; the latest for an employee and year wins. Insert-only (`guardWrites`). The collection has the `$jsonSchema` validator for its sensitive paths. Written only by Talent's opening balance service |

**Onboarding and change requests** (build step 2.6, [Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26)). The checklist's item states are derived when read and never stored.

- **`employeeRecords` additions**, each absent or null on records saved before step 2.6:
  - `governmentIdsVerification` and `bankAccountVerification`: null (not verified) or a subdocument with no `_id`, `{ verifiedAt, verifiedBy }` (a user id). Cleared by the employee's own entry to that group; set by a verifier's save, an approved change request or "Mark verified"
  - `noSupervisorConfirmation`: null or `{ confirmedAt, confirmedBy }`. Counts only while `reportingTo` has no active supervisor
- **`changeRequests`.** Base fields, no soft delete, never deleted:
  - `employeeId` and `requesterUserId`, fixed once set
  - `section` (`CHANGE_REQUEST_SECTIONS`: `contact`, `skills`, `personal`, `governmentIds`, `bankAccount`), fixed once set
  - `changedFields`: the field names that change, at least one, all of that section
  - `proposed`: a subdocument with no `_id`, holding only the changed fields, in the employee record's shapes: `presentAddress`, `permanentAddress`, `mobileNumber`, `personalEmail`, `emergencyContact`; `skills`; `dateOfBirth`, `sex`, `civilStatus`, `nationality`; `tin`, `sss`, `philhealth`, `pagibig` (each a `sensitiveField()`), `rdoCode`; `bank`, `accountNumber` (a `sensitiveField()`), `accountName`. A field cleared is stored as null (a sensitive one can't be cleared, as on the record)
  - `previous`: the same shape, set once on approval with the values replaced (sensitive values copied as their stored ciphertext)
  - `note` (up to 500 characters, or null)
  - `status` (`CHANGE_REQUEST_STATUSES`: `pending`, `returned`, `approved`, `rejected`, `cancelled`); `approved`, `rejected` and `cancelled` are final
  - `approvalRequestId` (the current Core approval request), `decidedBy` and `decidedAt` (null until settled), `remarks` (the approver's, or null)
  - `version`, raised by every save
  - Indexes: `{ employeeId, createdAt: -1 }`, and a partial unique index on `{ employeeId, section }` where `status` is `pending` or `returned`, so a section has at most one open request
  - The collection has the `$jsonSchema` validator for its sensitive paths. Written only by Talent's change request service and its approval hook

The seeded values, with their sources, are in [Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23).

Who checks these against official issuances, and when, is in [Keeping rates current](COMPLIANCE.md#keeping-rates-current).

## Derived values

These values are always computed from their source records and never edited directly. To correct one, change or reverse the source record.

| Value | Derived from | Spec |
|---|---|---|
| On-hand stock | Stock movements | [Inventory](#inventory-pulse-supply) |
| Where a serial is and its status | The serial's status history | [Inventory](#inventory-pulse-supply) |
| Ledger and bank balances | Posted journal entries | [Ledger](#ledger-pulse-fiscal), [Bank accounts and reconciliation](modules/fiscal.md#bank-accounts-and-reconciliation) |
| Leave balances | Opening, credit, carry-over, usage and adjustment entries (`leaveEntries`, from build step 2.8, `credited` types only). The available balance also subtracts pending requests | [Leave](modules/talent.md#leave), [Leave, offset time off and opening balances](modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28) |
| Offset balances | Opening, credit, adjustment and usage entries (`offsetEntries`; credit and adjustment from build step 2.7, opening and usage from build step 2.8) | [Offset balance & offset time off](modules/talent.md#offset-balance--offset-time-off) |
| Daily Time Record | Approved timesheets, schedules, leave, offset time off, confirmed holidays. From build step 2.7 computed when read (`computeDtr`), never stored; a timesheet not yet approved gives a preview. From build step 2.8 approved time off is part of it | [Daily Time Record (DTR)](modules/talent.md#daily-time-record-dtr) |
| A request's chargeable days and its paid and unpaid split | The request's dates and portion, the schedule in effect and confirmed holidays; the split is fixed at approval and changed only by the holidays-changed listener or a cancel (build step 2.8) | [Leave, offset time off and opening balances](modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28) |
| Account status | Employment status, with the separation date (`employees.separationDate`) that a separated status (Resigned, Terminated, Retired) requires. The one exception is the bootstrap system account (`isSystemAccount`), which has no employment status: it is active unless `systemAccountDisabled` is set | [Account status](../SECURITY.md#account-status), [Bootstrap System Administrator account](modules/core.md#bootstrap-system-administrator-account) |
| Org chart | `reportingTo` | [Org chart](modules/core.md#org-chart) |
| Onboarding checklist and its progress (build step 2.6) | The employee record, its verifications, 201 documents, e-signatures, compensation entries, the profile photo, account and module access facts from Core, and `talent.onboardingSettings` | [Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26) |
| Delivery status | Accepted quotation, POs, receipts and signed delivery receipts | [Delivery receipts](modules/supply.md#delivery-receipts) |

## Locked and append-only records

Some records can't be edited once they reach a certain state. Corrections go through a new record instead:

- Posted journal entries: reversal entries ([Ledger](#ledger-pulse-fiscal))
- Finalized payroll runs, and approved timesheets after the run: adjustments in the next cut-off ([Payroll run & payslips](modules/talent.md#payroll-run--payslips))
- Closed accounting periods: postings in the current open period ([Chart of accounts and ledger](modules/fiscal.md#chart-of-accounts-and-ledger))
- Salary and allowance history: new effective-dated entries. From build step 2.1, `compensationEntries` are insert-only, and a correction is a new entry with the same effective date. From build step 2.3, `allowanceAssignments` are insert-only too ([Compensation](modules/talent.md#compensation), [The employee record](modules/talent.md#the-employee-record-build-step-21))
- Sent quotations and BOQ versions: a new revision or version ([Quotations](modules/engage.md#quotations), [Presales and BOQ](modules/engage.md#presales-and-boq))
- Audit log entries: never changed or deleted ([Audit log](modules/core.md#audit-log))
- Notifications: never deleted; only `readAt` changes, when the recipient marks one read (`dedupeKey` is fixed once stored) ([Notifications](modules/core.md#notifications))
- Employee records: never deleted. That covers Core's `employees` and, from build step 2.1, Talent's `employeeRecords` ([Record retention](COMPLIANCE.md#record-retention))
- 201 documents (`employeeDocuments`, build step 2.2): never deleted. They are archived with a reason, and the file never changes; a renewal is a new document
- E-signatures and their uses (`eSignatures`, `signatureApplications`, build step 2.2): insert-only. A replaced signature is a new version, so a signed record keeps the version it was signed with
- Work schedule assignments (`workScheduleAssignments`, build step 2.4): insert-only. A correction is a new entry; the latest one on or before a day wins
- Change requests (`changeRequests`, build step 2.6): never deleted. An approved, rejected or cancelled request is final; a returned one is edited and sent again as a new approval request linked to the old one
- Approved timesheets (`timesheets.status` `approved`, build step 2.7): locked for good; their entries and reimbursement lines never change again, and there is no reopen. A holiday change becomes an offset `adjustment` entry, and a pay change an adjustment in the next cut-off ([Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27))
- Offset entries (`offsetEntries`, build step 2.7): insert-only. A correction is a new entry
- Leave entries (`leaveEntries`) and year-to-date pay at go-live (`payrollOpeningEntries`, build step 2.8): insert-only. A leave correction is an `adjustment`; a pay correction is a new entry that supersedes the old one
- Time off requests (`timeOffRequests`, build step 2.8): never deleted. A rejected or cancelled request is final; an approved one can only be cancelled before its first day, which gives its balance back with a new entry
- Timesheet types (`timesheets.timesheetType`, build step 2.4): stored when the timesheet is created and never changed, so later position changes never alter a past timesheet ([Timesheet types](modules/talent.md#timesheet-types))

## Retention

Decided by the project owner on 2026-10-03 (build step 1.3): **audit log entries (`auditLogs`) and notifications (`notifications`) are kept forever.** Nothing deletes or archives them, and neither collection has a TTL (expiry) index. The owner chose this for an internal app and set aside Philippine-law retention limits and erasure requests for these two records (see [Record retention](COMPLIANCE.md#record-retention)).

This doesn't relax what goes into them: an audit entry never holds a password, a hash or a sensitive value ([Audit logging](../SECURITY.md#audit-logging)).
