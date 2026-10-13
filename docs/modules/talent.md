# Pulse Talent (People & Culture)

Pulse Talent owns each employee's employment, government, payroll, timesheet and document details. Pulse Core owns the account and the org structure (see [People data ownership](core.md#people-data-ownership)).

Built in [Phase 2](../BUILD_PLAN.md#phase-2-pulse-talent). Route: `/talent`. Package: `packages/talent`.

Much of this module is sensitive personal information. The [Sensitive data](../../SECURITY.md#sensitive-data) rules apply on top of module access, and the labor and tax laws behind these rules are listed in [COMPLIANCE.md](../COMPLIANCE.md).

## Employee information

### Personal
- Full name (first, middle, last, suffix), date of birth, sex, civil status, nationality
- Present and permanent address, mobile number, personal email
- Emergency contact (name, relationship, mobile number)

### Employment
- Employee number (company ID), login email (allowed domains only), department, position, `reportingTo`
- Employment status: Probationary, Regular, Contractual, Resigned, Terminated, Retired (see [Account status](../../SECURITY.md#account-status))
- Work schedule and timesheet type (the type comes from the position; see [Timesheet types](#timesheet-types))
- Work region, for the minimum wage check (defaults to NCR, the company's region)
- Date hired, probation end date (Probationary), contract end date (Contractual), regularization date
- Separation date and remarks (Resigned, Terminated, Retired). The separation date is stored on Core's employee identity (`employees.separationDate`), because account status depends on it ([People data ownership](core.md#people-data-ownership), [Account status](../../SECURITY.md#account-status))

### Compensation
- Basic salary (the basis for payroll), stored in centavos
- Rate type: monthly-rated or daily-rated
- Allowances assigned to the employee (see [Allowances](#allowances))
- Minimum wage earner flag (exempt from income tax)
- Salary and allowance history is append-only with effective dates; never overwrite the current values

### Government IDs (Philippines)
- TIN (BIR), plus RDO code
- SSS number
- PhilHealth Identification Number (PIN)
- Pag-IBIG (HDMF) MID number
- Store IDs as strings, digits only; format for display (e.g. TIN `000-000-000-000`)

### Payroll bank account
- Bank: **UnionBank** or **RCBC** only
- Account number, account name
- Store account numbers as strings (preserve leading zeros)
- No bank upload file is generated; the account is shown on the payroll register so HR can credit salaries

### The employee record (build step 2.1)

Built in step 2.1. The record holds the five groups above. Documents, the profile photo and the e-signature are added in step 2.2 ([Documents, photo, e-signature and certifications](#documents-photo-e-signature-and-certifications-build-step-22)), allowances in step 2.3 ([Payroll settings and allowances](#payroll-settings-and-allowances-build-step-23)) and the work schedule in step 2.4; until then the record shows each one as "Added in a later step". Who may see, reveal and change each part is in [Sensitive data](../../SECURITY.md#sensitive-data).

**Where each field lives.** Talent never writes Core's `employees` or `users` ([Architecture rules](../ARCHITECTURE.md#architecture-rules)).

| Fields | Owner | Stored in |
|---|---|---|
| Employee number, name, login email, department, position, `reportingTo`, employment status, date hired, separation date | Core | `employees`, `users`. Talent reads them through Core's identity service ([People data ownership](core.md#people-data-ownership)) and shows them read-only, marked "Managed in Users". HR and the System Administrator get an "Edit in Users" link to `/admin/users?q=<employee number>` |
| Timesheet type | Core (the position) | Shown read-only from the position ([Timesheet types](#timesheet-types)) |
| Personal: date of birth, sex, civil status, nationality, present and permanent address, mobile number, personal email, emergency contact (name, relationship, mobile number) | Talent | `employeeRecords` |
| Employment: work region, contract end date, regularization date, separation remarks | Talent | `employeeRecords` |
| Government IDs: TIN, RDO code, SSS, PhilHealth PIN, Pag-IBIG MID | Talent | `employeeRecords.governmentIds` |
| Payroll bank account: bank, account number, account name | Talent | `employeeRecords.bankAccount` |
| Compensation: basic salary, rate type, minimum wage earner flag, each with its effective date | Talent | `compensationEntries`, append-only |

The fields, fixed sets and indexes are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership).

- **One record per employee, created on the first save.** The employee list is built from Core's employees, so a new user appears in Pulse Talent straight away, with a "Not filled in" badge until someone saves a section. A salary change counts as a save only for viewers who may see the Compensation section; for anyone else the badge stays until another section is saved, so it never tells them a salary is stored ([Sensitive data](../../SECURITY.md#sensitive-data)). The first save creates the `employeeRecords` record in its transaction; two first saves at once can't make two (unique `employeeId`), and the second gets the stale-form message below.
- **Never deleted.** Employee records and compensation entries stay forever, separated employees included ([Record retention](../COMPLIANCE.md#record-retention)). Nothing offers a delete, and the models refuse one.
- **Derived, not stored.** The probation end date shows as the date hired + 6 months while the status is Probationary ([Probation & contract tracking](#probation--contract-tracking) adds the alerts in step 2.13). A Contractual employee with no contract end date shows a "Contract end date missing" flag.
- **Work region** defaults to NCR. It is one of a fixed list of Philippine regions (`WORK_REGIONS`; the codes are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership)). *Assumption, to be confirmed by HR or counsel:* the list is the 18 current regions, Negros Island Region included.
- **Formats.** Government IDs and the bank account number are stored as digit strings, leading zeros kept, and shown formatted. *Assumption, to be confirmed by HR or counsel:*

  | Field | Digits | Shown as |
  |---|---|---|
  | TIN | 9, 12 or 14 (no branch code, a 3-digit branch code, or BIR's 5-digit branch code) | `000-000-000`, `000-000-000-000`, `000-000-000-00000` |
  | RDO code | 3 | `000` |
  | SSS number | 10 | `00-0000000-0` |
  | PhilHealth PIN | 12 | `00-000000000-0` |
  | Pag-IBIG MID | 12 | `0000-0000-0000` |
  | Bank account number (UnionBank or RCBC) | 10 to 16 | the digits as entered |
  | Mobile numbers | 11, starting with `09` | `0917 123 4567` |

- **Compensation is effective-dated and append-only.** Each salary change is a new compensation entry: effective date, basic salary in centavos, rate type (monthly-rated or daily-rated: for a daily-rated employee the amount is the daily rate), the minimum wage earner flag and a required reason. An entry is never edited or deleted. The **current** entry is the latest one whose effective date is today or earlier in Manila; a later effective date shows as "Scheduled". To correct a mistake, add a new entry with the **same effective date** and a reason: the newer entry (by creation time) wins that date, and the old one stays in the history marked "Superseded". The effective date is on or after the date hired and at most one year ahead. The salary is entered in pesos with up to 2 decimals, converted to centavos without floating point, and must be more than zero ([Money](../DATA_MODEL.md#money)). The minimum wage warning is added in step 2.3 ([Payroll settings and allowances](#payroll-settings-and-allowances-build-step-23)).
- **Editing.** Each section (Personal, Employment, Government IDs, Payroll bank account) has its own Edit sheet, and Compensation has "Add salary change". Saving one section leaves the others unchanged. Each form sends back the record's `version` it loaded; if someone else saved first, the save is refused with "Someone else changed this record. Reload to see it." A save that changes nothing still raises the `version` and writes an `update` entry. "Add salary change" sends no `version`: it only ever adds an entry, so there is nothing to overwrite. A sensitive input is never filled in with the stored value: it starts empty with the hint "Ends in 1234", and leaving it empty keeps the stored value. A stored government ID or account number can be replaced but not cleared in step 2.1.
- **Nobody edits their own record in Pulse Talent in step 2.1**, the System Administrator included. Employees change their own details through change requests in step 2.6 ([Self-service & record changes](#self-service--record-changes)). Supervisors in `reportingTo` editing a record also comes with step 2.6. Until then, editing needs Talent Write.
- **Audit.** Record type `talent.employeeRecord`, labelled `<employee number> · <first name> <last name>`: the first save is a `create` entry, later saves are `update` entries with both sides snapshotted (`snapshotsForAudit`), so a changed sensitive value shows only as "Hidden (sensitive), changed". Record type `talent.compensationEntry`, labelled `<employee number> · <effective date YYYY-MM-DD>`: one `create` entry per entry. Reveals are `reveal` entries on these record types, module `talent` ([Audit logging](../../SECURITY.md#audit-logging)). Nothing in step 2.1 sends a notification.

**Screens.**

- **`/talent`, the employee list** (Talent Read). Page title "Employees". Stat tiles count active employees by employment status. A data table on a desktop and a list of cards on a phone: Avatar initials, name, employee number, department, position, employment status and date hired. No sensitive field, date of birth or civil status ever appears in the list. Search by name or employee number, and filter by department and employment status; separated employees are hidden unless "Show separated" is on. Sorted by last name, then first name, with no paging. The URL keeps `?q=`, `?department=`, `?status=`, `?separated=1` and `?employee=<employeeId>`, which opens that record in the inspector.
- **The inspector** (a full-height sheet on a phone) shows the record in inset grouped sections: Personal, Employment, Compensation (current salary, rate type, minimum wage earner flag and the history), Government IDs and Payroll bank account. A section the viewer may not see isn't sent at all; the record shows one line instead: "Pay, government IDs and bank details are visible to HR, Accounting and the System Administrator." Sensitive values use the masked field: government IDs and the account number show their last 4 digits, and salary amounts show `••••` with no digits, until revealed.
- **Manage access.** HR and the System Administrator see a "Manage access" action on an active employee's record. It links to the employee's sheet on the User access page (`/admin/access?user=<userId>`), which keeps its own checks ([User access page](core.md#user-access-page)). It shows on their own record too, where the access page opens that row read-only and says why.
- **`/talent/me`, the employee's own record** (self-service, outside module access). Every signed-in user with an employee record opens it from "My record" in the Pulse Core sidebar group, with no Pulse Talent access needed. It shows the same sections, read-only, with Reveal on the employee's own sensitive values (each reveal is audit-logged). The bootstrap system account has no employee record, so it doesn't get the entry, and the page shows an empty state.

### Documents (201 file)
- Employment contract, regularization evaluations, government ID copies, NBI clearance, medical certificate, diplomas/TOR, and other HR documents
- Each document: type, file (in [file storage](../ARCHITECTURE.md#file-storage)), issue date, expiry date (if applicable), uploaded by
- Documents generated by the system (see [HR documents](#hr-documents)) are filed here automatically
- Expiry alerts to HR and the employee before a document lapses (default 30 days)
- 201 file documents follow the [Sensitive data](../../SECURITY.md#sensitive-data) rules

### Profile photo & e-signature
- Profile photo: shown across all modules (directory, org chart, assignments, tickets, approvals)
- E-signature: image stored in file storage, applied to approvals, quotations, purchase orders, delivery receipts, service reports, HR documents and handover/acceptance documents
- An e-signature is only ever applied by its owner's own action; one user can never sign as another
- Changing or applying an e-signature is audit-logged; signed documents keep the signature version used at signing time

### Documents, photo, e-signature and certifications (build step 2.2)

Built in step 2.2, with [Skills & certifications](#skills--certifications). Decisions 173–190 in [BUILD_PLAN.md](../BUILD_PLAN.md#decisions-added-to-the-spec). The fields and indexes are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership), and who sees what in [Sensitive data](../../SECURITY.md#sensitive-data).

**Where each part lives.**

| Part | Owner | Stored in |
|---|---|---|
| Profile photo | Core, because Core's directory, org chart, access page, approvals and command bar show it | `employees.photoFileId` |
| 201 documents | Talent | `employeeDocuments` |
| E-signature versions | Talent | `eSignatures`, insert-only |
| Each use of an e-signature | Talent | `signatureApplications`, insert-only |
| Certifications | Talent | `certifications` |
| Skills | Talent | `employeeRecords.skills` |

**201 file.**

- **Each document** has a type, an optional title, the file, an issue date (required, not in the future), an optional expiry date (after the issue date), and who uploaded it and when.
  - The types (`DOCUMENT_201_TYPES`) are employment contract, regularization evaluation, government ID copy, NBI clearance, medical certificate, diploma or TOR, and other.
  - "Other" needs a title.
  - *Assumption, to be confirmed by HR:* the type list, and that the issue date is required.
- **Never deleted.** HR archives a document with a reason, and it moves under "Show archived". The file can't be changed, but the details can be edited (with the record's `version`, like the employee record). An archived document can't be edited or archived again.
- **Renewals.** A renewed document (a new NBI clearance, say) is uploaded as a new document. The upload sheet can archive the one it replaces in the same save, with the reason "Replaced by a renewed document."
- **Who adds, edits and archives:** Talent Write **and** HR or the System Administrator, never on one's own record. HR may manage other HR staff's documents. Employees upload their own from step 2.6 onboarding.
- **Who sees them.**
  - A medical certificate is category `medical`; every other document is `file201`.
  - Others' documents show for Talent Read plus the reveal rule for that category, so HR, the System Administrator and, except for medical certificates, Accounting.
  - The employee always sees their own on `/talent/me`.
  - Anyone else gets none of them, not even the list, only the line "201 file documents are visible to HR, Accounting and the System Administrator." Accounting gets "Medical certificates are visible to HR and the System Administrator."
  - *Assumption, to be confirmed by HR or counsel:* medical certificates are hidden from Accounting.
- **Opening a document is audit-logged.** Every open writes a `reveal` entry with the field `file`, the employee's own opens included, before the file is sent.
- **Kept forever.** Archived documents are kept forever, separated employees' included ([Record retention](../COMPLIANCE.md#record-retention)). *Assumption, to be confirmed by counsel* (Data Privacy Act proportionality).

**Profile photo.**

- **Who sets it.** The employee on `/talent/me`, and HR and the System Administrator in the inspector, can change or remove it, through Core's `setEmployeePhoto` and `removeEmployeePhoto`. Never on the system account. The inspector's photo actions need Talent Read, like the inspector itself; Core's service then checks the person.
- **Who sees it.** Every signed-in user, wherever a person's avatar appears. A replaced photo no longer opens.
- **Re-encoded.** The image is auto-rotated, stripped of metadata such as GPS, and stored as WebP of at most 1024 px.
- *Assumption, to be confirmed by HR or counsel:* showing photos to every employee needs no more than the company's privacy notice.

**E-signature.**

- **Upload.** Only the employee uploads their own signature, on `/talent/me`.
  - Each upload is a new version (1, 2, 3…). Nothing removes one: a signature is replaced, never cleared.
  - The image is re-encoded as PNG of at most 1200 px, metadata stripped.
  - The bootstrap system account has no employee, so it has no signature.
- **Who sees the image.** Only the owner (every version) and the System Administrator. Others see "E-signature on file, version N" or "Not uploaded".
- **Applying.** One owner-only service, `applyESignature`, applies a signature for the signed-in user only: it takes no employee id. Each use records which version and file was applied, to what, and when (`signatureApplications`). Versions and their files are never changed or deleted, so a signed record keeps the version it was signed with, even after a replacement.
- **Approvals** (from this step). An approve decision applies the approver's current signature, and the approvals inspector shows "Signed with e-signature, version N". Return and reject sign nothing.
  - An approver with no signature on file can still approve until step 2.6 adds the gate; the decision shows "Approved without an e-signature". *Assumption, to be confirmed by the user.*
  - Quotations, purchase orders and the other documents call the same service in their own steps.
- *Assumption, to be confirmed by counsel:* an uploaded signature image is enough for approvals now, and for HR documents and contracts later (RA 8792, the E-Commerce Act, and the Rules on Electronic Evidence).

**Skills and certifications.** See [Skills & certifications](#skills--certifications).

**Expiry alerts.**

- **The job.** Daily at 8:00 AM Manila, `talent.expiryAlerts`.
- **When it alerts.** Each 201 document and certification with an expiry date gets an "expiring" alert once it is within the lead days (default 30), and an "expired" alert on or after its expiry date, each once per expiry date.
- **Skipped:** archived documents, removed certifications and separated employees.
- **Recipients.**
  - Documents: HR (linking to the record) and the employee (linking to `/talent/me`).
  - Certifications: also the employee's `reportingTo` supervisors, linking to the directory card.
  - When no HR user is active, the HR alerts go to the System Administrators.
  - Each person gets each alert once, even with two roles: the employee gets the `/talent/me` one, and an HR user who is also a supervisor gets the record link.
- **Wording.** The text names the type and the person, never a file name, document title or certification name. Others get "NBI clearance expiring: <name>" or "Certification expired: <name>", with "It expires on <date>." The employee gets "Your NBI clearance expires on <date>", with "Send HR the renewed copy so they can update your record."
- **The lead days** are a setting a Talent Owner changes from Settings on `/talent`.
- *Assumption, to be confirmed by HR:* the 30-day default, the second "expired" alert and the recipients.

**Audit.** All in module `talent`, except the photo:

| Change | Entry |
|---|---|
| A 201 document added, edited or archived | `create` or `update` on `talent.employeeDocument`, labelled `<employee number> · <type label>` |
| A new e-signature version | `create` on `talent.eSignature`, labelled `<employee number> · version <n>` |
| An e-signature applied | `create` on `talent.signatureApplication`, labelled `<employee number> · <what was signed>` |
| A certification added, edited or removed | `create`, `update` or `delete` on `talent.certification`, labelled `<employee number> · <name>` |
| Skills changed | `update` on `talent.employeeRecord` |
| The photo changed | `update` on `core.employee`, module `core` |
| The expiry setting changed | `create` on `core.configVersion`, module `core` |

**Screens.**

- **The inspector.**
  - The Documents section shows the profile photo, the e-signature status and the 201 file list, with expiry badges that carry text ("Expired", "Expires in N days", "Valid"), Open, Edit, Archive and "Show archived".
  - A Skills & certifications section lists the skills and the certifications, each with its expiry badge.
  - A Talent Owner gets a Settings button on `/talent` for the expiry alert lead days.
- **`/talent/me`** adds:
  - the photo (Change, Remove)
  - the e-signature: a preview, Upload or Replace, and version history with how often each version was applied
  - the 201 file, skills and certifications, read-only

## Onboarding (first sign-in)

- On first sign-in, a new user is guided to an onboarding checklist. It is **required but not enforced**: the user can skip it and use most of the ERP, with a persistent reminder and progress indicator until it is complete.
- **Employee items:** change temporary password, personal info and addresses, emergency contact, government IDs, payroll bank account, 201 documents, profile photo, e-signature.
- **HR items** (completed by HR or the System Administrator, shown to the employee as status only): module access, department, position, `reportingTo`, employment status, work schedule, work region, salary and allowances, company-issued assets. `reportingTo` can also be set by any Board of Directors member.
- Only specific actions are blocked until the items they depend on are complete. Define these gates in one config map (action → required items); when an action is blocked, tell the user exactly which item to complete. Initial gates:
  - Applying an e-signature (approvals, quotations, purchase orders, delivery receipts, service reports, HR and handover documents) → e-signature uploaded
  - Filing leave or offset time off, or submitting a timesheet → `reportingTo` set (not required for employees with an empty `reportingTo`)
  - Inclusion in a payroll run → government IDs and payroll bank account (HR sees incomplete employees flagged before finalizing payroll)
- Government IDs and bank details entered during onboarding are verified by HR before the first payroll. After onboarding, changes to them follow the [Self-service](#self-service--record-changes) rules.

## Self-service & record changes

- Employees can view their full record and submit change requests for their own details.
- **HR and any supervisor in the employee's `reportingTo`** can edit the employee's record and approve change requests.
- Exceptions:
  - Salary, allowances, government IDs and bank account changes are HR and System Administrator only, per the [Sensitive data](../../SECURITY.md#sensitive-data) rules.
  - For employees in the HR department, those changes are made only by the System Administrator (normally the Web Administrator – Developer) or a Board of Directors member, never by HR. No one in HR changes their own or a colleague's pay or bank details.
  - `reportingTo` changes are HR, Board of Directors and System Administrator only (see [Reporting lines](core.md#reporting-lines)).
- Every change stores the old value, new value, requester, approver and timestamp.

## Skills & certifications

- Owned by Pulse Talent as part of the employee record. Pulse Ops (technician assignment) and Pulse Engage (presales, bids, product partner requirements (e.g. how many certified engineers a brand requires)) read it through Talent's service functions.
- Fields: certification name, issuing vendor/body (e.g. Cisco, Fortinet, TESDA, PRC), certificate/license number, issue date, expiry date, attachment.
- Expiry alerts to the employee, their `reportingTo` and HR before a certification lapses.

Built in step 2.2 ([Documents, photo, e-signature and certifications](#documents-photo-e-signature-and-certifications-build-step-22)):

- **Each certification** has a name, an issuer, an optional product from Core's products (so Pulse Engage can count how many employees hold a current certification for a brand), an optional certificate or license number, an issue date (required), an optional expiry date and an optional attachment.
  - The attachment opens for the employee, Talent Read and the System Administrator.
- **Who changes them.** Adding and editing need Talent Write, never on one's own record. Removing one is a soft delete and needs Talent Owner, also never on one's own record. Employees add their own from step 2.6.
- **Dates.** Unlike a 201 document, a certification's issue date may be in the future (a certificate dated ahead). The expiry date, when given, must be after it.
- **Skills** are free-text tags on the employee record: up to 30, of up to 50 characters each, with duplicates refused (ignoring case). They are changed with Talent Write, never on one's own record. *Assumption, to be confirmed by HR:* the spec names skills but gives no fields.
- **Read services for Pulse Ops and Pulse Engage:** `listCertifications` and `countCertifiedEmployeesByBrand`.
  - They need Talent, Engage or Ops Read, or the System Administrator, and leave out separated employees. They use the directory's idea of active, so an employee whose account doesn't resolve to active (separated, or with no user) is left out too.
  - They return the employee, the certification's name, issuer, product, dates and status (current, expiring, expired), and the skills. They never return the license number or the attachment.

## Timesheets & attendance

Every employee keeps **one timesheet per payroll cut-off**. It holds their daily time entries, extra hours and reimbursements, and is the basis for their pay.

### Timesheet types

There are two timesheet types, each with its own UI and its own computation. They differ only in how extra hours (time worked beyond the schedule) are treated:

| Type | Positions (default) | Extra hours become |
|---|---|---|
| **Overtime timesheet** (`overtime`) | Lead HVAC Technician, HVAC Technician, Driver | Paid overtime, with premiums per [Payroll](#payroll) |
| **Standard timesheet** (`standard`) | All other positions | Offset hours (including all rest day and holiday work) credited to the employee's offset balance and used as paid time off; never paid |

- The type is a setting on the **position** (data, not code). HR or the System Administrator can change a position's type; the change takes effect from the next cut-off, never in the middle of one.
- Each timesheet stores the type that applied when its cut-off started, so later changes never alter past timesheets.
- Build both on shared components for daily time entries, reimbursements and the approval flow. Only the extra-hours section of the UI and the extra-hours computation differ.

```typescript
export const TIMESHEET_TYPES = ["overtime", "standard"] as const;
export type TimesheetType = (typeof TIMESHEET_TYPES)[number];
```

### Work schedule
- HR sets a company default schedule (work days, rest days, start and end time, break, grace period for lates). Employees with different hours get their own schedule.
- **Company default (seeded):** Monday to Friday, 8:00 AM – 5:00 PM, with a 1-hour break (8 working hours) and a 15-minute grace period for lates. Saturday and Sunday are rest days.
- Schedules are effective-dated; each day is evaluated against the schedule in effect on that day.

### Daily time entries
- For each day worked: date, **time in**, **time out**, and the **activity performed** (required, free text). Client, project and ticket are optional (the project comes from Pulse Ops and the ticket from Pulse Desk; picking either fills in its client). A scheduled assignment pre-fills them.
- "Time in" / "Time out" buttons fill in the current time. Employees can also type times manually (e.g. for site work away from the office or VPN); manual entries are marked as such so approvers can see them.
- A day can have more than one entry (e.g. office in the morning, client site in the afternoon).
- Days covered by approved leave or offset time off need no time entry.

### Extra hours: Overtime timesheet
- Time worked beyond the schedule counts as overtime only if the employee marks it as overtime and gives a reason.
- The UI shows each day's overtime hours by kind (ordinary day, rest day, holiday, night differential) and the cut-off's total overtime hours.
- Overtime is approved as part of the timesheet. Only approved overtime is paid, using the premium rates in [Payroll](#pay-computation-per-cut-off).

### Extra hours: Standard timesheet (offset)
- Time worked beyond the schedule counts as offset only if the employee marks it as offset and gives a reason.
- The UI shows each day's offset hours, the cut-off's total, and the employee's current offset balance. It has no overtime fields.
- Offset is approved as part of the timesheet. On final (HR) approval, the approved hours are credited to the employee's offset balance at 1 hour of extra work = 1 offset hour (ratio configurable).
- All work on rest days and confirmed holidays also becomes offset hours (same ratio), under the same rule: the employee marks it as offset and gives a reason. Standard-timesheet employees get no overtime, rest day or holiday work premiums. Keep this as a setting per timesheet type so it can change.
- Offset hours are never paid as overtime or converted to cash. See [Offset balance & offset time off](#offset-balance--offset-time-off).
- Offset in place of overtime and premiums is part of the employment contract for Standard-timesheet positions. Implement it as specified.

### Reimbursements

A separate table on the same timesheet.

- Each line: date, type (meal, transportation, other), **merchant**, **merchant TIN** and **receipt (OR) number** printed on the receipt, **client** the expense was for, the **project** (optional, from Pulse Ops), **amount** (centavos), and a photo or file of the receipt.
- Transportation (e.g. Grab, taxi or similar rides): **pick-up (start)** and **drop-off (end)** locations are also required.
- Reimbursement types are configurable data, each defining its required fields and an optional limit (e.g. a maximum meal amount per day). Lines over the limit are highlighted for approvers.
- **No duplicates:** the same merchant TIN + receipt number can never be claimed twice, by anyone, across both reimbursements and petty cash vouchers. Reject it on submission.
- **Filing window:** a receipt must be dated within the current or previous cut-off (configurable).
- The client field is for tracking and reporting only. **Reimbursements are never billed or charged to the client.**
- Approved reimbursements are paid with the cut-off as a separate non-taxable line (substantiated business expenses), never mixed into salary.

#### Submission & approval
1. The employee submits the timesheet after the cut-off ends (deadline configurable; default: 1 day after the cut-off). Reminders go out before the deadline; HR sees who hasn't submitted.
2. **Any one supervisor** in `reportingTo` approves (skipped for employees with an empty `reportingTo`).
3. **HR** approves.
- Either approver can return the timesheet to the employee with remarks; the employee revises and resubmits, and approval starts again from step 2.
- An approved timesheet is locked. Changes after the payroll run is finalized become adjustments in the next cut-off.
- If a timesheet is not fully approved when HR prepares the payroll run, the employee still receives their basic pay for the cut-off. Overtime, reimbursements and any absence, late or undertime deductions from that timesheet are settled in the next cut-off once approved. Offset hours from that timesheet are credited to the balance only when it is fully approved.

#### Daily Time Record (DTR)
- Computed per employee per day from the approved timesheet, schedule, approved leave, approved offset time off and confirmed holidays.
- Day statuses: present, **on leave (paid)**, **offset (paid)**, **leave without pay**, **absent (unpaid)**, holiday, rest day. Plus late minutes, undertime minutes, night differential hours (10:00 PM – 6:00 AM), and either overtime hours (Overtime timesheet) or offset hours earned (Standard timesheet).
- A scheduled work day with no time entry and no approved paid leave or offset time off is **absent (unpaid)**.
- Leave without pay and unpaid absences are deducted from pay at the daily rate (half the daily rate for a half day).
- The DTR is derived; never edit it directly. Confirmed holidays are never counted as absences.

### Work schedules and daily time entries (build step 2.4)

Built in step 2.4. Decisions 213–234 in [BUILD_PLAN.md](../BUILD_PLAN.md#decisions-added-to-the-spec). The collections and setting shapes are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership). Step 2.4 stores schedules, timesheets and time entries, and computes hours **for display only**. It computes no pay and stores no computed hours. Submission, approval, the DTR, the holidays-changed listener and crediting offset hours come in step 2.7; reimbursements in step 2.5.

Each item marked *Assumption* is listed in [HANDOFF › Assumptions to check](../HANDOFF.md#assumptions-to-check) (items 46–61), to be confirmed by HR, the accountant or counsel.

**Work schedules.**

- **A schedule** has:
  - its work days (ISO weekdays 1 to 7, at least one)
  - a start and an end time (`HH:MM`; an end at or before the start means the schedule ends the next day)
  - a break: its start time and its length (0 to 180 minutes), inside the span
  - a grace period for lates (0 to 60 minutes; used by the DTR in step 2.7)

  Its **scheduled minutes** are the span less the break, from 60 to 1,440.
- **The company default** is the versioned setting `talent.workSchedule`, added to the payroll settings in the [configuration store](../DATA_MODEL.md#versioned-configuration). `pnpm seed:admin` seeds it once, effective 2000-01-01 (the seed policy date of step 2.3), with the source "Company policy (spec)": Monday to Friday, 08:00 to 17:00, a 60-minute break from 12:00 (*Assumption:* the spec gives only "a 1-hour break"), and a 15-minute grace period. Saturday and Sunday are rest days.
  - It is edited on the Payroll settings page, in a new **Work schedule** segment, under the step 2.3 rules: Talent Owner **and** HR or the System Administrator, an effective date later than every existing version and at most a year ahead, a required source, and a `create` audit entry on `core.configVersion`.
  - Unlike `payrollSettings`, a new version may take effect on any day, because each day is evaluated against the schedule in effect on that day.
- **An employee's own schedule** is an entry in the new insert-only collection `workScheduleAssignments`: the employee, the effective date, a schedule (or none, meaning "back to the company default") and a required reason (up to 300 characters).
  - The schedule for a day is the latest entry on or before that day (on a tie, the newest). With no entry, the company default in effect that day applies.
  - Entries are never edited or deleted (`guardWrites`). A correction is a new entry.
  - The effective date is on or after the date hired and at most a year ahead.
  - **Who sets it:** Talent Write **and** HR or the System Administrator, never on one's own record. HR may set HR staff's schedules: a schedule isn't pay.
  - **Who sees it:** the employee (on `/talent/me` and their timesheet), Talent Read, and the employee's `reportingTo` supervisors (on the timesheet). It isn't sensitive.
  - **Audit:** a `create` entry on `talent.workScheduleAssignment`, labelled `<employee number> · <YYYY-MM-DD>`, in the same transaction.

**Timesheet settings.** The versioned setting `talent.timesheetSettings`, seeded effective 2000-01-01:

- `offsetRatio`: offset hours per hour of claimed extra work, a decimal string (seeded `"1"`; *Assumption:* 1:1)
- `extraHours`: how each timesheet type treats claimed extra hours, `{ overtime: 'overtime', standard: 'offset' }`. This is the spec's "setting per timesheet type"; the computation reads it, never the type name.

Step 2.7 adds the submission deadline in a later version. It is edited in the same Work schedule segment, under the same rules.

**Timesheets.**

- **One per employee per cut-off**, in the collection `timesheets`: the employee, the period start and end, the cut-off key, the pay date, the **timesheet type**, the date the type was read (`typeReadOn`) and a status. Step 2.4 has one status, `open`; step 2.7 adds the others. The pair (employee, period start) is unique.
- **The period** for a day is `cutOffFor(day, …)` with the `talent.payrollSettings` version in effect on that day. If a later version takes effect inside that period, the period ends the day before it; the shortened period keeps the pay date of the cut-off it was cut from. A period never starts before the version it uses took effect.
- **The type at cut-off start.** Core keeps no history of a position's type, so Talent records it when the cut-off starts. The daily job `talent.openTimesheets` (00:05 Asia/Manila, cron `5 0 * * *`) creates the current cut-off's timesheet for every active employee who doesn't have one yet, reading their position's type at that moment. It is idempotent through the unique index, and it runs every day, not only on a cut-off's first day, so a missed run is made up.
  - A timesheet the job hasn't created yet (a new hire, or a missed run) is created on first use, with the position's type on that day (*Assumption*).
  - The stored type is never changed. A position change, or a type change on a position, applies from the next timesheet created.
  - A position record that can't be found is refused with "Your position can't be found. Ask HR to check your employee record."
- **Open timesheets.** Every timesheet stays `open` in step 2.4.

**Time entries** (collection `timeEntries`).

- **Each entry** has:
  - the date: the Manila day of its time in
  - the time in, and the time out (none while the entry is open)
  - for each of the two, its source: `clock` or `manual`
  - the activity performed: required, 1 to 500 characters
  - the client: optional, any live client, picked from Core's client options. An entry keeps its client after the client is retired: the timesheet shows it as "Removed client", and the entry sheet keeps it as an option
  - the extra-hours mark: none, or a reason (1 to 300 characters) that marks the entry's extra hours as overtime or offset
- **Project and ticket** pickers show in the entry sheet, disabled, with "Available when Pulse Ops is set up" and "Available when Pulse Desk is set up". No project or ticket field is stored until Phases 4 and 6.
- **Time in** is one tap with no fields. It creates an open entry with the **server's** current time and the source `clock`. An employee has at most one open entry.
- **Time out** closes the open entry with the server's current time and the source `clock`. When the entry has no activity yet, Time out opens the entry sheet and asks for it first.
- **Manual times.** Typing a time, or changing a clocked one, sets that side's source to `manual`. The browser never sends a time as `clock`. Manual times show a "Manual" badge to everyone who sees the timesheet.
- **Checks**, on the server, in the save's transaction:
  - the time out is after the time in, and an entry lasts at most 24 hours
  - neither time is in the future
  - the date is on or after the date hired, on or before the separation date, and no later than today
  - the employee's entries never overlap, on any day. They are compared in whole minutes, as the hours are: seconds are dropped on both ends, so an entry clocked out at 17:00:42 and one typed from 17:00 only touch
  - the entry's timesheet is `open`
  - every saved entry with a time out has an activity
  - each form sends back the entry's `version`; a stale save is refused with "Someone else changed this entry. Reload to see it."
- **Two saves at once.** Each save first touches the employee's existing timesheets for the cut-offs of the entry's day, the day before and the day after. The touch sets `updatedBy` and `updatedAt` and increments `__v`, so it is always a real write. Two saves of the same employee then write the same timesheet: one transaction conflicts and retries with the other's entry visible, so the no-overlap rule holds. The timesheets' write guard allows only that touch. When the cut-off has no timesheet yet, two first saves both insert it and conflict the same way. One case is left open: two saves at once of entries on either side of a cut-off boundary, when neither cut-off has a timesheet yet. The daily job creates each cut-off's timesheet first, so this needs a missed run.
- **Deleting** an entry is a soft delete (`deletedAt`), after a confirmation ("Delete entry").
- **Audit:** `create`, `update` and `delete` entries on `talent.timeEntry`, labelled `<employee number> · <YYYY-MM-DD>`, in the same transaction. No notification is sent.

**Who may do what.**

- **The employee** opens their own timesheet, and clocks, adds, edits and deletes their own entries. This is self-service, outside module access ([Exceptions to module access](../../SECURITY.md#exceptions-to-module-access)). The page and its services take no employee id from the request.
- **Talent Read** opens any employee's timesheet, read-only.
- **A supervisor** in the employee's `reportingTo` opens that employee's timesheet read-only, whatever their module access, because they approve it in step 2.7.
- **Nobody edits another person's entries** in step 2.4, HR and the System Administrator included (*Assumption*). Corrections come through "return with remarks" in step 2.7.
- Anyone else gets the no-access state (HTTP 403). Each Server Action reloads the actor and the service checks again.

**How hours are computed** (pure functions, for display; step 2.7's DTR and step 2.9's payroll build on them).

- **Units.** Everything is in whole minutes; Manila is UTC+8 with no daylight saving. An instant counts from its minute: seconds are dropped on both ends (a clocked 08:00:42 counts as 08:00), here and in the overlap check. Hours show as minutes ÷ 60 rounded half-up to one decimal, and totals are added in minutes before rounding. There is no minimum overtime block (*Assumption*).
- **The settings for a day:** the schedule in effect that day, the night window (`nightStart`, `nightEnd`) of the `talent.premiumRates` version in effect that day, `talent.timesheetSettings` in effect that day, and `hoursPerDay` from the `talent.payrollSettings` version in effect on the cut-off's start date.
- **The kind of day:**
  - a **regular holiday** or a **special day** (special non-working day) when a confirmed, live, **nationwide** holiday falls on it; either may also be **on a rest day**
  - otherwise a **rest day** when the schedule doesn't list its weekday
  - otherwise an **ordinary day**

  A special working day is an ordinary day. Draft holidays never count. Local holidays show on the day as information but aren't applied, because no employee has a work location yet (*Assumption*). Two holidays on one date count as one holiday (decision 210): a regular holiday when either is regular, otherwise a special day. Both names show.
- **An entry belongs to its time-in date** and takes that day's kind, even when it ends after midnight (*Assumption*).
- **Worked minutes** are the closed entries' minutes, less any overlap with the schedule's break window (*Assumption:* the break is unpaid even when worked through). An open entry counts nothing and shows "No time out".
- **Extra minutes:**
  - on an ordinary day: the worked minutes beyond the scheduled minutes, if any. They are the day's **last** worked minutes in time order, so a late start made up at the end of the day earns none (*Assumption*)
  - on a rest day or a holiday: every worked minute (*Assumption:* for both timesheet types)
- **Claimed or not.** Extra minutes inside an entry with the extra-hours mark are **claimed**. The rest are **not claimed**: they show as "Not claimed" with the hint "Mark it as overtime (or offset) and give a reason", and count for nothing.
- **Overtime timesheet** (`extraHours.overtime` is `overtime`). Each day shows its claimed hours by kind, and the cut-off shows each kind's total:
  - **Ordinary day**: claimed extra minutes on an ordinary day
  - **Rest day**: claimed minutes on a rest day
  - **Holiday**: claimed minutes on a holiday, labelled "Regular holiday" or "Special day", with "on a rest day" when it is one
  - **Night differential**: paid minutes inside the night window, which wraps past midnight. Paid minutes are the scheduled worked minutes plus the claimed extra minutes. They overlap the kinds above, and the card says so. Under the offset treatment the computation counts the scheduled worked minutes only, since claimed minutes become offset, not pay. The Standard timesheet doesn't show it; the DTR uses it from step 2.7

  On a rest day or a holiday the claimed minutes also split into the first `hoursPerDay` hours and those beyond, shown as a sub-line ("8.0 h + 2.0 h beyond 8") for the payroll step. **Total overtime** is ordinary day + rest day + holiday; night differential isn't added in.
- **Standard timesheet** (`extraHours.standard` is `offset`). Each day's offset is its claimed extra minutes × `offsetRatio`, rounded half-up to the minute. The page shows each day's offset, the cut-off total and the current offset balance, and no overtime or night differential fields. The balance's opening, credit and usage entries come in steps 2.7 and 2.8, so until then it reads "0.0 h", with "+X h this cut-off, credited when HR approves your timesheet".

**Hand-checked cases.** With the seeded schedule (08:00–17:00, break 12:00–13:00), `hoursPerDay` 8, the night window 22:00–06:00 and `offsetRatio` 1 unless a case says otherwise. Each extra-hours entry is marked unless it says "unmarked".

| # | Case | Expected |
|---|---|---|
| 1 | Overtime, Friday 2026-09-11, 08:00–19:00 | Worked 10.0 h; ordinary day 2.0 h; night differential 0 |
| 2 | Case 1, unmarked | Overtime 0; not claimed 2.0 h |
| 3 | Overtime, Saturday 2026-09-12 (rest day), 09:00–12:00 | Rest day 3.0 h |
| 4 | Overtime, ordinary day, 09:00–18:00 | Worked 8.0 h; extra 0 |
| 5 | Overtime (a Driver), ordinary day, 08:00–23:30 | Worked 14.5 h; ordinary day 6.5 h (17:00–23:30); night differential 1.5 h |
| 6 | Overtime, Sunday 2026-09-13, 20:00 to 02:00 the next day | Rest day 6.0 h (on 2026-09-13); night differential 4.0 h |
| 7 | Overtime, Monday 2026-11-30 (Bonifacio Day, confirmed regular holiday), 08:00–19:00 | Holiday 10.0 h: 8.0 h + 2.0 h beyond 8 |
| 8 | Case 7 with the holiday a draft, or local | An ordinary day: ordinary day 2.0 h |
| 9 | Overtime, Saturday 2026-10-31 with a confirmed special non-working day, 09:00–13:00 | Holiday 3.0 h, "Special day on a rest day" (the break is deducted) |
| 10 | Standard, Monday 2026-09-14, 07:55 (manual) to 19:30 | Worked 635 min (10.6 h); offset 155 min (2.6 h). With `offsetRatio` "1.5": 233 min (3.9 h) |
| 11 | Standard, a rest day, 09:00–12:00, unmarked | Offset 0; not claimed 3.0 h |
| 12 | Two entries, 08:00–12:00 unmarked and 13:00–19:00 marked | Claimed 2.0 h. With the first marked and the second not: not claimed 2.0 h |
| 13 | An own schedule 10:00–19:00 (break 14:00, 60 minutes) from Wednesday 2026-09-16 | Tuesday 2026-09-15 uses the default. On 2026-09-16, 08:00–19:00 gives extra 2.0 h |
| 14 | Cut-offs | 2026-09-26 → 2026-09-26 to 2026-10-10, paid 2026-10-15. 2026-02-20 → 2026-02-11 to 2026-02-25, paid 2026-02-28. 2026-02-27 → 2026-02-26 to 2026-03-10, paid 2026-03-15 |

**Screens** (phone first; see [Timesheets on a phone](../DESIGN_SYSTEM.md#layout--components)).

- **`/talent/timesheet`**, the employee's own timesheet. A "Timesheet" entry in the Pulse Core sidebar group, after My record, listed for every user with an employee (never the bootstrap system account). The Talent item isn't current there, and the breadcrumb reads "Pulse Core › Timesheet".
  - `?cutOff=YYYY-MM-DD` (a period start) picks the cut-off, with previous and next buttons; the default is today's cut-off. A cut-off before the date hired, or after today's, is refused as not found.
  - The header reads "Cut-off Sep 11 – 25, 2026 · Overtime timesheet" (or "Standard timesheet").
  - **Today card:** worked against scheduled hours, "Timed in 7:58 AM", and one primary button, Time in or Time out. It shows only on today's cut-off.
  - **Extra-hours card:** "Overtime by kind" (Overtime) or "Offset" with the balance line (Standard). This is the only part that differs between the two types.
  - **Segmented control** "Daily entries | Reimbursements". Reimbursements is an empty state until step 2.5.
  - **Day list:** one row per day of the cut-off, from the date hired (or the cut-off's start) up to today (or the separation date), newest first. Each row shows the times with a "Manual" badge on each manual side, the activity and client, the day's overtime by kind ("OT 2.0 h · Ordinary day") or offset ("Offset 2.6 h"), and "Not claimed" or "No time out" where they apply. Rest days and holidays are labelled, and a run of rest days with no entries folds into one row.
  - **Day sheet:** the day's entries, "Add entry", and each entry's edit sheet: time in, time out with a "Next day" switch, activity, client, the disabled project and ticket pickers, and the switch "Count extra hours as overtime" (or "as offset") with its required reason.
  - A sticky footer shows the cut-off's total overtime or offset. There is no Submit button in step 2.4.
  - **My team.** A user with direct reports also gets a "My team" list on the page, each person linking to their timesheet.
- **`/talent/timesheets/<employeeId>`** with `?cutOff=`: the same view read-only, titled with the employee's name, for Talent Read or the employee's supervisors. Opened from "Timesheet" in the employee inspector and from My team. Its breadcrumb reads "Pulse Talent › Timesheet". The page loads the view before it renders, with no skeleton, so a refusal is a real HTTP 403 and an unknown employee or cut-off a real 404. Supervisors without Talent Read get only directory fields about the employee: the date hired and status are used on the server and never sent. The day list still starts at the date hired, and the previous cut-off button stops at the cut-off that holds it, so a supervisor can work out the date hired when it falls in a cut-off they open (*Assumption*: acceptable, as the supervisor works with the employee).
- **The inspector and `/talent/me`** get a Work schedule section: the schedule in effect, a scheduled one and the history. The inspector has "Set schedule" for those who may set it; `/talent/me` is read-only.

**Choices made for step 2.4** (also decisions 213–234):

- Hours are derived when read and never stored, so a holiday change needs no recompute in step 2.4; the DTR listener comes in step 2.7.
- Leave and offset time off days (step 2.8) need no entry; until then such days show as days with no entry.

## Leave

Leave is fully integrated with timesheets and payroll: approved paid leave shows on the DTR as paid, and every day not covered becomes a pay deduction.

- Leave types are configurable data, each with entitlement, eligibility, crediting, filing and carry-over rules.
- **Company leave (initial values, editable by HR):**
  - Vacation Leave (VL): 5 days per year
  - Sick Leave (SL): 5 days per year
  - Credits start on the **regularization date** (prorated for the rest of that year), then are credited in full every January 1 (configurable)
  - Unused VL and SL **carry over** to the next year (carry-over cap configurable; default: no cap)
  - Leave is **never converted to cash**
- **Probationary employees cannot use VL or SL.** Any absence during probation is unpaid and deducted from pay.
- **Filing rules:**
  - **VL** must be filed at least **2 weeks (14 days)** before the first day of leave (configurable). The system rejects later filings.
  - **SL** requires a **medical certificate** (uploaded with the request). It is filed on or after the sick day, no later than the timesheet deadline for that cut-off.
- **Insufficient balance:** days not covered by the balance become **leave without pay** and are deducted from pay. The employee sees how many days will be unpaid before submitting.
- **Service Incentive Leave:** the 5 days of paid VL satisfy the Labor Code's 5-day SIL, so SIL is not a separate leave type. If VL is ever set below 5 days, SIL must be added back.
- **Statutory special leaves** (seeded) follow the eligibility set by law, not the company probation rule (e.g. maternity leave applies regardless of employment status):
  - Maternity leave: 105 days (RA 11210)
  - Paternity leave: 7 days (RA 8187)
  - Solo parent leave: 7 days (RA 11861)
  - VAWC leave: 10 days (RA 9262)
  - Special leave for women: up to 2 months (RA 9710)
- Leave can be filed as whole or half days.
- Leave balances are derived from opening, credit, carry-over and usage entries (see [Opening balances at go-live](#opening-balances-at-go-live)); never edit a balance directly.
- Rest days and confirmed holidays inside a leave period are not deducted from the balance.
- Leave requests are approved by any one supervisor in `reportingTo`. When the requester has an empty `reportingTo` (for example top-level Board of Directors members), HR approves instead; an HR requester's own request goes to the System Administrator (see [Reporting lines](core.md#reporting-lines)).
- Leave approved after a payroll run is finalized is applied as an adjustment in the next cut-off.

## Offset balance & offset time off

Applies to employees on the Standard timesheet.

- The offset balance is derived from opening entries (see [Opening balances at go-live](#opening-balances-at-go-live)), credit entries (approved offset hours) and usage entries (approved offset time off); never edit a balance directly.
- Employees use offset hours by filing an **offset time off** request, in hours (minimum 1 hour, configurable), approved by any one supervisor in `reportingTo`, or by HR when the requester has an empty `reportingTo` (as for leave). A request cannot exceed the current balance.
- Offset hours are used **only as time off**. They never cover lates, undertime or absences.
- Approved offset time off shows on the DTR as **offset (paid)**; those hours are not deducted from pay.
- Rest days and confirmed holidays inside an offset time off request are not deducted from the balance.
- Offset hours never expire.
- Offset hours are never converted to cash, including at separation (company policy; keep as a setting).
- If an employee moves to a position on the Overtime timesheet, their remaining offset balance stays usable.
- Offset time off approved after a payroll run is finalized is applied as an adjustment in the next cut-off.

## Opening balances at go-live

- When Pulse Talent goes live, HR enters opening figures once for each existing employee, as of the go-live date:
  - opening VL, SL and offset balances
  - year-to-date pay: gross pay, basic salary earned (for 13th month pay), taxable income, tax withheld and contributions
- They are dated, audit-logged opening entries, never edits to a balance. Leave and offset balances, payslip year-to-date figures, 13th month pay and BIR Form 2316 build on them.

## Probation & contract tracking

- **Probationary:** probation end date = date hired + 6 months (Labor Code maximum). Alert HR and the employee's `reportingTo` 30 days before it ends (lead time configurable).
- **Regularization evaluation:** completed by a `reportingTo` supervisor and reviewed by HR (see [HR documents](#hr-documents)). Outcome: Regular, or end of employment. The completed evaluation is filed in the 201 file.
- If probation ends with no decision recorded, escalate daily to HR and the supervisors: by law, an employee allowed to work past probation is deemed Regular.
- On regularization, VL and SL credits start (see [Leave](#leave)).
- **Contractual:** contract end date is required. Alert HR and `reportingTo` 30 days before it ends. Outcome: renew (new end date), convert to Regular, or end of contract.

## Payroll

### Pay schedule
- Semi-monthly, two cut-offs per month:
  - 11th – 25th, paid on the 30th (last day of February)
  - 26th – 10th of the next month, paid on the 15th
- Cut-off days and pay days are configurable settings.

### Rates
- Monthly-rated: basic pay per cut-off = monthly salary ÷ 2.
- Daily rate = monthly salary × 12 ÷ **261** (daily rate factor, configurable). Hourly rate = daily rate ÷ 8.
- Daily-rated: basic pay = days worked in the cut-off × daily rate.
- **Prorating:** for a hire, separation or salary change in the middle of a cut-off, basic pay is prorated by working days using the daily rate in effect on each day.

### Pay computation per cut-off
- Earnings: basic pay, approved overtime (Overtime timesheet only), night differential, rest day and holiday premiums, allowances, approved reimbursements (non-taxable, separate line), manual adjustments.
- Standard timesheet: approved extra hours, including all rest day and holiday work, go to the offset balance and add nothing to pay. No overtime, rest day or holiday work premiums apply. Night differential applies only to paid hours; offset hours carry no premium. Pay for unworked holidays is unchanged.
- Deductions: leave without pay, unpaid absences, lates and undertime (from the DTR), SSS, PhilHealth and Pag-IBIG employee shares, withholding tax (BIR semi-monthly table), manual adjustments.
- How each government contribution is split across the two cut-offs is configurable (default: half in each cut-off).
- Contribution tables, tax brackets, premium rates, de minimis limits and minimum wage rates change over time: store them as versioned, effective-dated configuration. **Never hardcode rates.**
- Seed premium rates with the current DOLE defaults, for example:
  - Regular holiday: 200% of the daily rate if worked; 100% if unworked (when present or on paid leave the workday before)
  - Special non-working day: 130% if worked; no pay if unworked unless company policy says otherwise
  - Rest day work: 130%; special non-working day on a rest day: 150%; regular holiday on a rest day: 260%
  - Overtime: +25% of the hourly rate on ordinary days; +30% of the day's hourly rate on rest days and holidays
  - Night differential (10:00 PM – 6:00 AM): +10% of the hourly rate

### Allowances
- Allowance types are configurable data (e.g. rice, transportation, communication, meal). Each type has a tax treatment (taxable, non-taxable, or de minimis) and a basis: a fixed amount per cut-off, or an amount per day present.
- Each employee is assigned allowance types with an amount and effective dates.
- **Seeded allowance:** Internet allowance, ₱1,000 per month for every employee, non-taxable, paid as ₱500 in each cut-off. It is assigned automatically to every new employee from their date hired.
- De minimis amounts above the BIR limit are taxed on the excess.

### Manual inputs & adjustments
- In a **draft** payroll run, HR can manually add or edit any line for any employee: extra earnings, extra deductions, or an override of a computed value (e.g. back pay for a salary increase, correcting an error).
- Every manual entry requires a reason, is marked as manual on the run, and is audit-logged (old value, new value, reason, entered by).
- Manual entries appear on the payslip as adjustment lines with their description, and are highlighted for the Board of Directors when approving the run.
- Only draft runs can be edited; finalized runs are locked.

### Payroll run & payslips
1. Once timesheets for the cut-off are approved, pay is computed automatically into a draft payroll run.
2. **HR** reviews the run, makes any manual inputs, resolves flagged employees (incomplete onboarding, unapproved timesheets, below minimum wage) and submits it.
3. **Any one Board of Directors member** approves or returns it to HR with remarks. There is no Accounting review step.
4. On approval, the run is finalized and a **payslip is generated automatically** for every employee in it, available in their self-service as a PDF.
- Payslip shows: employee name and number, department, position, cut-off period, pay date, each earning and deduction line (including adjustments), gross pay, total deductions, net pay, and year-to-date gross, tax and contributions.
- A finalized payroll run is locked. Corrections are adjustments in the next run, never edits.
- A finalized run is posted to Pulse Fiscal through Fiscal's service functions (salary expense, employer contribution expense, withholdings and contributions payable, reimbursements).

### Employer contributions & monthly remittances
- Each finalized run also computes the **employer shares**: SSS employer share and EC (Employees' Compensation) contribution, PhilHealth employer share, and Pag-IBIG employer share, from the same versioned contribution tables.
- Employer shares never reduce the employee's pay. They appear in the run totals, the reports and the Fiscal posting.
- At month end, HR generates the monthly remittance reports from that month's finalized runs:
  - SSS contributions (employee + employer + EC)
  - PhilHealth premiums (employee + employer)
  - Pag-IBIG contributions (employee + employer)
  - BIR Form 1601-C data (monthly withholding tax on compensation)
  - Exportable as PDF and Excel, and in each agency's upload format where one exists
- Due dates per agency are configurable. HR is reminded before each due date.
- Each remittance is paid as a disbursement in Pulse Fiscal, without a second approval since its amounts come from Board-approved payroll runs; HR or Accounting records the payment date and reference number, and the report shows the status per agency per month.

### 13th month pay
- 1/12 of the total basic salary earned in the calendar year (excludes overtime, premiums, allowances and reimbursements).
- Paid in full in December, on or before December 24 (PD 851), as its own payroll run with the same HR → Board of Directors approval and an automatic payslip.
- Tax-exempt up to the ceiling for 13th month and other benefits (keep the ceiling in versioned configuration); the excess is taxable.
- Separated employees receive it prorated in their final pay.

### Minimum wage check
- Regional minimum wage rates are versioned, effective-dated configuration per region (seed **NCR**, the company's region; add others as needed).
- When HR saves a salary, warn if the employee's daily rate is below the minimum wage for their work region. Such employees are also flagged in every draft payroll run.
- When a new wage order takes effect, HR sees a list of employees who fall below it.

### Year-end
- BIR Form 2316 per employee, the annual 1604-C and the alphalist (Pulse Talent owns these; Pulse Fiscal lists them with its BIR reports).

### Payroll settings and allowances (build step 2.3)

Built in step 2.3. Decisions 191–212 in [BUILD_PLAN.md](../BUILD_PLAN.md#decisions-added-to-the-spec). The setting shapes and the new collection are in [DATA_MODEL.md](../DATA_MODEL.md#versioned-configuration). The seeded issuances, with their sources and how far each was verified, are in [COMPLIANCE.md](../COMPLIANCE.md#seeded-payroll-rates-build-step-23). Step 2.3 stores the settings and the allowances and adds the minimum wage warning. It computes no pay: the payroll run, payslips and remittances come in later Phase 2 steps.

**Every seeded rate, table and amount is an *Assumption, to be confirmed by HR or the accountant*.** Before the first real payroll, HR checks each one against the current SSS, PhilHealth, Pag-IBIG, BIR and DOLE issuances ([Keeping rates current](../COMPLIANCE.md#keeping-rates-current)).

**The settings.** Each is a versioned setting in the [configuration store](../DATA_MODEL.md#versioned-configuration). A change is a new version with its own effective date; old versions are never edited or deleted. Amounts are whole centavos, and rates are decimal strings (`"0.05"`), read exactly with the money helpers.

| Setting | What it holds | Seeded |
|---|---|---|
| `talent.payrollSettings` | The two cut-offs (start day, end day, pay day), the daily rate factor, the hours per day, and how each government contribution is split across the two cut-offs | 26th–10th paid on the 15th; 11th–25th paid on the 30th (the last day of a shorter month); factor 261; 8 hours; SSS, PhilHealth and Pag-IBIG half in each cut-off |
| `talent.sssContributions` | The SSS schedule, one row per monthly salary credit (MSC): the lowest compensation in the row, the regular SS and MPF parts of the MSC, the employee and employer shares (each split into regular SS and MPF) and the EC contribution | SSS Circular No. 2024-006, from January 2025 |
| `talent.philhealthContributions` | The premium rate, the employee's share of it, and the income floor and ceiling | 5%, half each, floor ₱10,000, ceiling ₱100,000 |
| `talent.pagibigContributions` | Brackets (up to an amount: employee rate, employer rate) and the maximum fund salary | 1% employee and 2% employer up to ₱1,500; 2% and 2% above; maximum fund salary ₱10,000 |
| `talent.withholdingTaxSemiMonthly` | BIR's semi-monthly brackets: the amount the bracket starts over, the base tax and the rate on the excess | RR 11-2018 Annex E, from January 2023 |
| `talent.premiumRates` | The holiday, rest day, overtime and night differential rates of [Pay computation per cut-off](#pay-computation-per-cut-off), and the night window | The values listed there, night 10:00 PM to 6:00 AM |
| `talent.deMinimisLimits` | Each de minimis benefit: a key, a label, the period (month, semester, year or day) and either an amount or a share of the regional minimum wage | RR 29-2025, from January 6, 2026 |
| `talent.thirteenthMonthExemption` | The tax-exempt ceiling for 13th month pay and other benefits | ₱90,000 (RA 10963) |
| `talent.minimumWages` | Per region: the wage order and the daily minimum wage (the general, non-agriculture rate) | NCR only: Wage Order NCR-26 (₱695, from July 18, 2025) and NCR-28 (₱755, from September 26, 2026) |
| `talent.allowanceTypes` | The allowance types (below) | The internet allowance only |

- **Seeded once.** `pnpm seed:admin` adds a setting's seeded versions only when the setting has no version at all, so a later run never adds or replaces one ([Bootstrap System Administrator account](core.md#bootstrap-system-administrator-account)). Seed writes are system writes and aren't audit-logged. Every version records its source: the issuance's name and, where there is one, its link.
- **Seeded effective dates.** A legal table takes effect on its issuance's own effective date. Company policy (`payrollSettings`, `allowanceTypes`) and the premium rates take effect on 2000-01-01, so that they cover every date hired.
- **Cut-offs.** Exactly two. Their days run from 1 to 28 and together cover every day of the month with no overlap. A pay day runs from 1 to 31 and moves to the month's last day in a shorter month. The pay date falls in the month the cut-off ends, after its end day. A new `payrollSettings` version must take effect on a cut-off start day of its own schedule, so a schedule never changes in the middle of a cut-off.
- **The contribution split** for each agency must add up to exactly 1. Splitting a month's share gives the end-of-month cut-off the remainder, so the two parts always add up to the share.
- **Withholding tax** isn't split: each cut-off uses the semi-monthly table. **Minimum wage earners** stay exempt ([Compensation](#compensation)).
- **De minimis.** RR 29-2025 also raised monetized unused vacation leave to 12 days. It isn't seeded, because leave is never converted to cash ([Leave](#leave)).
- **Which version a payroll applies.** Later steps use, and store on each finalized run, the version in effect:
  - for SSS, PhilHealth and Pag-IBIG, on the first day of the contribution month (the month of the pay date)
  - for the withholding table, the de minimis limits and the 13th month ceiling, on the pay date
  - for the premium rates, the minimum wage and the allowance types, on each day
  - for `payrollSettings`, on the cut-off's start date

  Which pay counts as compensation for each contribution is decided in the payroll run step. *Recommendation, to be confirmed by the accountant:* PhilHealth on the monthly basic salary; SSS and Pag-IBIG on the month's total taxable compensation.

**Payroll settings page.** `/talent/payroll-settings` (Talent Read), opened from a "Payroll settings" button on `/talent`. The Talent item in the sidebar stays current, and the breadcrumb reads Pulse Talent › Payroll settings.

- **Layout.** A segmented control switches between Pay schedule, Contributions (SSS, PhilHealth, Pag-IBIG), Withholding tax, Premiums and benefits (premium rates, de minimis limits, 13th month ceiling), Minimum wage and Allowance types, and from build step 2.4 Work schedule (`talent.workSchedule` and `talent.timesheetSettings`, [Work schedules and daily time entries](#work-schedules-and-daily-time-entries-build-step-24)). Each setting shows the version in effect ("In effect since <date>", with its source), a scheduled version if there is one, and the history of versions, read-only. A seeded version carries the note "Seeded: check against the current issuance before the first payroll."
- **Adding a version** needs Talent Owner **and** HR or the System Administrator. "Add version" opens a sheet filled in with the version in effect. The SSS and withholding tables are editable grids with rows to add and remove; on a phone a grid scrolls inside its own region, and the page itself never scrolls sideways. The sheet asks for:
  - the effective date: later than every existing version of that setting (it may be in the past, for an issuance published late) and at most one year ahead
  - the source (required, up to 300 characters, for example "SSS Circular No. 2024-006")

  Saving asks for confirmation: "Versions can't be changed or withdrawn once added. Check every figure against the issuance." A version taking effect on the same day as another is refused.
- **Audit.** Each version added from the page is a `create` entry on `core.configVersion` (module `core`, labelled `<key> from <date>`), in the same transaction, as for the expiry alert setting.
- **A wrong version** can't be withdrawn. A newer version replaces it from its own effective date; a wrong version that is already scheduled stays in effect until then. See [RUNBOOK](../RUNBOOK.md#a-wrong-payroll-settings-version-was-added).

**Allowance types** are the versioned setting `talent.allowanceTypes`. Each type has:

- a key (fixed once added, and never removed: a type no longer used is marked inactive) and a name
- a tax treatment: taxable, non-taxable, or de minimis (which names its de minimis limit, so the excess over the limit is taxed)
- a basis: a fixed amount per cut-off, or an amount per day present
- a default amount, in centavos per cut-off or per day
- whether it is assigned automatically (only for a fixed amount per cut-off)
- whether it is active (an inactive type can't be newly assigned)

The seeded type is the **internet allowance**: ₱500 per cut-off (₱1,000 a month), non-taxable, assigned automatically. *Assumption, to be confirmed by the accountant:* the spec makes it non-taxable, but an internet allowance isn't on BIR's de minimis list.

**Allowance assignments.**

- **Automatic types apply from the date hired.** Every employee gets each automatic type from their date hired in Core, at the type's default amount in effect on each day, with nothing stored. A corrected date hired moves the start, a new default amount applies from its version's date, and employees hired before the setting existed get it too.
- **Explicit assignments.** HR adds an assignment to give a type to an employee, change their amount, or end it (an automatic type included). Each is a new entry in `allowanceAssignments`: the type, the effective date (on or after the date hired, at most a year ahead), set with an amount or end, and a required reason. Entries are never edited or deleted. For a type on a day, the latest entry on or before that day wins (on a tie, the newest); "end" means none. An automatic type with no entry on or before that day applies automatically.
- **Who assigns.** The same rule as salary: Talent Write and HR or the System Administrator; for an employee in the HR department, Talent Write and the System Administrator or a Board member, never HR. Accounting never changes them, and nobody changes their own.
- **Sensitive.** An assigned amount is encrypted and shown masked (`••••`) until revealed, and each reveal is audit-logged. The automatic line shows the company default unmasked, since it says nothing about one person. The allowances appear inside the Compensation section, only for a viewer who may reveal `allowances` for that employee ([Sensitive data](../../SECURITY.md#sensitive-data)).
- **On the record.** The Compensation section lists the allowances in effect, each with its basis and where it comes from, then the history. For example "Internet allowance · ₱500.00 per cut-off (₱1,000.00 a month) · Automatic from 3 Nov 2026", or "Starts 3 Nov 2026" for a future date hired. HR assigns from "Assign allowance". `/talent/me` shows the employee's own allowances read-only, with Reveal.
- **Audit.** A `create` entry on `talent.allowanceAssignment`, labelled `<employee number> · <type name> · <YYYY-MM-DD>`, with the amount hidden.

**Minimum wage warning.** This is a warning, never a block.

- **When.** Saving a salary change ("Add salary change") compares the employee's daily rate with the minimum wage for their work region (NCR when the record has none). It uses the versions in effect on the later of the entry's effective date and today.
- **The daily rate.** A daily-rated amount is the daily rate. A monthly-rated amount is compared exactly as monthly × 12 ÷ the daily rate factor, with no rounding. The warning shows that daily rate rounded down to the centavo, so a rate just under the minimum never reads as the minimum itself (₱16,421.24 a month shows ₱754.99, not ₱755.00).
- **No pay schedule on file** for the date (only possible before `pnpm seed:admin` has run): a daily rate is still checked, but a monthly salary is refused with "No pay schedule is on file for that date, so a monthly salary can't be compared with the minimum wage. Add one in Payroll settings."
- **Below the minimum.** The save is refused once, and a warning shows under the amount, for example "The daily rate ₱650.00 is below the NCR minimum wage of ₱755.00 (Wage Order NCR-28). It will be flagged in payroll." The button becomes "Save anyway" ([Non-blocking warnings](../DESIGN_SYSTEM.md#feedback--motion)). Changing the amount, rate type or effective date clears the warning. A confirmed save stores `minimumWageWarningConfirmed` on the entry.
- **No rate for the region.** The salary saves, with the note "No minimum wage on file for <region>. Add it in Payroll settings."
- **On the record.** A current salary below the minimum in effect today shows a "Below minimum wage" badge, with a warning icon and text, inside the Compensation section only.
- **When a new wage order takes effect.** On Payroll settings › Minimum wage, each version shows how many active employees in its region are paid below it, on the later of its effective date and today. "View list" opens their names, numbers, departments and positions, with no amounts, each linking to their record. The count and the list need Talent Read and HR, Accounting or the System Administrator. They aren't audit-logged, since they show no amount.
- **Scope.** The check uses the general (non-agriculture) rate only. No job or notification is added in step 2.3; the payroll run flags these employees in its own step.

**Choices made in the build** (step 2.3, checked in the review):

- **Before the date hired, no allowance applies,** automatic or assigned: the employee isn't employed yet. An automatic type applies only while it is active in that day's `talent.allowanceTypes` version. Nothing yet stops the automatic line at a separation date; the payroll and final pay steps decide that.
- **"Seeded".** A stored version is shown as seeded when its effective date and source match one of the seed's versions exactly. A version HR adds can't match, because a second version on the same date is refused.
- **PhilHealth rounding.** The premium on the basis is rounded half-up to the centavo once; the employee's share of it is rounded half-up, and the employer takes the remainder, so the two always add up to the premium. **Pag-IBIG:** each share is its own rate on the basis, rounded half-up separately.
- **The cut-off end day.** A cut-off that doesn't wrap and ends on day 28 runs to the month's last day. The pay day must come after the end day in every month, February included, so `min(pay day, 28)` must be later than the end day.
- **The "Add version" sheet** starts with the figures of the version in effect (or the latest one), and an empty effective date and source, so neither is added by accident.
- **Rates are typed as decimals** in the sheet ("0.05" is 5%, "1.3" is 130%) and shown as percentages on the page, converted by moving the decimal point, never through floating point. Amounts are typed in pesos and converted to centavos with `parsePesos`.

*Assumptions, to be confirmed by HR or the accountant:* no pay date moves for a weekend or holiday; double holidays (300%), special working days and the lower wage rates for small retail, service and manufacturing employers aren't seeded, since the spec doesn't list them.

## Separation

### Separation checklist

- **Separation:** when an employee becomes Resigned, Terminated or Retired, the account is deactivated on the separation date and the system lists everything they still own: open tickets, projects, deals they own or are on the team of, assigned client accounts and products, pending approvals, and company-issued assets. Final clearance cannot be completed until every item is reassigned or returned.
- An employee can only be set to **Terminated** after the due process in [Termination due process](#termination-due-process) is complete.

### Separation: final pay & Certificate of Employment

- **Pulse Talent** computes final pay and generates the Certificate of Employment (COE). **Pulse Fiscal** records the payable and the disbursement, called through Fiscal's service functions.
- Final pay is approved by any one Board of Directors member, or returned to HR with remarks, before it is released.
- Final pay includes: unpaid salary up to the separation date, approved but unpaid overtime and reimbursements, prorated 13th month pay, separation pay where required (see [Termination due process](#termination-due-process)), and tax annualization adjustments, less authorized deductions.
- Unused leave and offset hours are not converted to cash (company policy). Keep these as settings so they can change.
- Final pay is released after separation clearance and within 30 days of separation (DOLE Labor Advisory No. 06-2020). Track the due date and alert HR as it approaches.
- The COE is issued within 3 days of the employee's request (see [HR documents](#hr-documents)).
- Issue BIR Form 2316 upon separation.

## Termination due process

An employee can only be set to **Terminated** once the required process is complete and on file. HR runs each case; notices are signed by HR or a Board of Directors member.

**Just causes** (e.g. serious misconduct, willful disobedience, gross and habitual neglect, fraud; Labor Code Art. 297): the twin-notice rule.
1. **Notice to Explain** (`NTE-`): states the specific acts or omissions and the rule violated, and gives the employee at least **5 calendar days** to reply in writing.
2. **Employee's written explanation:** submitted through self-service (or uploaded by HR if given on paper).
3. **Administrative conference** (optional, or when the employee requests one): date, attendees and minutes are recorded.
4. **Notice of Decision** (`NOD-`): the findings and the decision. Outcomes: cleared, written warning, suspension (with dates), or dismissal. Only a dismissal decision allows the Terminated status, with the separation date set to the effective date in the notice.

**Authorized causes** (redundancy, retrenchment, closure, installation of labor-saving devices, disease; Labor Code Arts. 298–299):
- A **Termination Notice** (`TN-`) to the employee and a notice to DOLE, both at least **30 days** before the effective date. Record the DOLE filing date and reference.
- **Separation pay** is computed into final pay using configurable rates. Seed the Labor Code minimums: redundancy or labor-saving devices, 1 month's pay per year of service; retrenchment, closure or disease, ½ month's pay per year of service; at least 1 month's pay in either case; a fraction of at least 6 months counts as a full year.

### For every case
- The employee receives each notice in self-service and acknowledges receipt; the acknowledgment date is the proof of service. HR can upload a signed paper copy instead if the notice was served in person.
- Deadlines (reply period, 30-day notice) are tracked, and actions are blocked until they pass.
- All case documents are filed in the employee's 201 file.
- Cases are confidential: visible only to HR, Board of Directors members, the System Administrator, and the employee (their own notices).

## HR documents

- Generated as PDFs from templates HR can edit, e-signed by the issuer, and filed automatically in the employee's 201 file.
- Each document gets a number with its prefix and year (e.g. `COE-2027-0001`).

| Document | Prefix | Contents |
|---|---|---|
| Employment contract | `CTR-` | One template per status (Probationary, Regular, Contractual). Position, department, date hired, work schedule, basic salary and allowances, `reportingTo`. Probationary: the probation period and the regularization criteria. Contractual: contract end date. Positions on the Standard timesheet: the offset policy (extra hours, rest day and holiday work become offset time off). Signed by the employee and HR or a Board of Directors member. |
| Regularization evaluation | `EVL-` | Ratings 1–5 on job knowledge, quality of work, productivity, attendance and punctuality (pre-filled from the DTR: absences, lates, undertime), teamwork, communication, initiative, and compliance with company policies, plus optional position-specific criteria (e.g. certifications for engineers and technicians). Overall rating, recommendation (Regular or end of employment), supervisor comments, employee acknowledgment, HR review. Sent 30 days before probation ends. |
| Certificate of Employment | `COE-` | Employee name, position(s) held with dates, employment period (or "to present"), purpose stated by the employee, date issued, HR signature. Compensation appears only when the employee requests a COE with compensation (e.g. for loans or visas). Requested through self-service and issued within 3 days. |
| Clearance form | `CLR-` | At separation: every item from the separation checklist (assets returned, work reassigned) with a sign-off per responsible department. Final pay is released only after it is complete. |
| Notice to Explain | `NTE-` | See [Termination due process](#termination-due-process). |
| Notice of Decision | `NOD-` | See [Termination due process](#termination-due-process). |
| Termination Notice (authorized cause) | `TN-` | See [Termination due process](#termination-due-process). |

- **Probationary contracts must include the regularization criteria.** The Labor Code requires the standards for regularization to be made known at hiring; if they are not, the employee is deemed Regular. The contract pulls these criteria from the evaluation template so both always match.

## HR reports

- Every report can be viewed on screen and exported as **PDF and Excel**.
- Reports:
  - Employee masterlist (filter by department, position, status)
  - Payroll register per run: each employee's earnings, deductions, net pay, bank and account number (used to credit salaries)
  - Leave balances and leave usage (including leave without pay)
  - Timesheet status per cut-off: not submitted, pending supervisor, pending HR, returned, approved
  - Overtime summary per employee and department (Overtime timesheet)
  - Offset balances: hours earned, used and remaining (Standard timesheet)
  - Reimbursements by employee, client and type (tracking only; never billed)
  - Government contributions (employee and employer shares) and the monthly remittance reports
  - 13th month pay summary
- Access: HR and the System Administrator (Accounting per the [Sensitive data](../../SECURITY.md#sensitive-data) rules). Sensitive columns follow the Sensitive data rules; every export of sensitive data is audit-logged.

## Notifications

- **Employees:** timesheet due soon, timesheet returned with remarks or approved, leave or offset time off approved or rejected, payslip ready, document or certification expiring, notice received (NTE, NOD, TN).
- **Supervisors:** timesheets, leave and offset time off requests waiting for their approval; their team's certifications expiring (from step 2.2, see [Skills & certifications](#skills--certifications)).
- **HR:** new users needing module access, company details still missing, timesheets waiting for HR approval, leave and offset time off requests waiting for HR approval (requesters with an empty `reportingTo`), missing timesheets at the deadline, payroll run or final pay approved or returned, remittance due dates, probation, contract and document alerts, minimum wage flags, due-process deadlines.
- **Board of Directors:** payroll runs and final pay waiting for approval.
