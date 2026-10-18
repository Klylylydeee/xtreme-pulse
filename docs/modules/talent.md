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
- **Nobody edits their own record in Pulse Talent in step 2.1**, the System Administrator included. Employees change their own details through change requests in step 2.6 ([Self-service & record changes](#self-service--record-changes)). From step 2.6 they also fill in their own empty fields directly, and `reportingTo` supervisors approve their team's change requests; editing a record directly still needs Talent Write ([Onboarding checklist and change requests](#onboarding-checklist-and-change-requests-build-step-26)).
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
- **Who adds, edits and archives:** Talent Write **and** HR or the System Administrator, never on one's own record. HR may manage other HR staff's documents. From step 2.6 employees upload their own (any type but the employment contract and the regularization evaluation), and editing and archiving stay with HR ([Onboarding checklist and change requests](#onboarding-checklist-and-change-requests-build-step-26)).
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
  - An approver with no signature on file could still approve until step 2.6 added the gate; such decisions show "Approved without an e-signature". From step 2.6 the approve is refused with the gate's message, and only the bootstrap system account approves unsigned ([Onboarding checklist and change requests](#onboarding-checklist-and-change-requests-build-step-26)).
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

Built in step 2.6, with the change requests below: [Onboarding checklist and change requests (build step 2.6)](#onboarding-checklist-and-change-requests-build-step-26).

## Self-service & record changes

- Employees can view their full record and submit change requests for their own details.
- **HR and any supervisor in the employee's `reportingTo`** can edit the employee's record and approve change requests.
- Exceptions:
  - Salary, allowances, government IDs and bank account changes are HR and System Administrator only, per the [Sensitive data](../../SECURITY.md#sensitive-data) rules.
  - For employees in the HR department, those changes are made only by the System Administrator (normally the Web Administrator – Developer) or a Board of Directors member, never by HR. No one in HR changes their own or a colleague's pay or bank details.
  - `reportingTo` changes are HR, Board of Directors and System Administrator only (see [Reporting lines](core.md#reporting-lines)).
- Every change stores the old value, new value, requester, approver and timestamp.

### Onboarding checklist and change requests (build step 2.6)

Built in step 2.6. Decisions 256–276 in [BUILD_PLAN.md](../BUILD_PLAN.md#decisions-added-to-the-spec). The collections, fields and the new setting are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership), and who may see and change what in [Sensitive data](../../SECURITY.md#sensitive-data). Step 2.6 derives each employee's onboarding status, wires the e-signature gate, adds HR verification of government IDs and bank details, and adds self-service change requests through Core's [approvals engine](core.md#approvals). The `reportingTo` gate is wired in steps 2.7 (timesheet submission) and 2.8 (leave and offset time off), the payroll gate in step 2.10 (the run's flags), and the company-issued assets item stays a placeholder until Phase 4.

Each item marked *Assumption* is listed in [HANDOFF › Assumptions to check](../HANDOFF.md#assumptions-to-check) (items 84–101), to be confirmed by HR, counsel or the user.

**The checklist.** Every employee has one, the System Administrator's included; the bootstrap system account has no employee, so it has none. Nothing is ticked by hand: each item's state is **derived** from the records it is about, every time it is read, and nothing about it is stored except the two HR confirmations below. An item is **Done**, **To do**, **Waiting for HR to verify** (government IDs and the bank account, filled in but not verified) or a **Placeholder**.

| Employee item | Done when (*Assumption*: the required fields) |
|---|---|
| Change temporary password (`password`) | The account no longer has a temporary password. Sign-in already forces the change first ([Sign-in and passwords](../../SECURITY.md#sign-in-and-passwords)), so it is always done by the time the checklist shows |
| Personal info and addresses (`personalInfo`) | Date of birth, sex, civil status, nationality, present address, permanent address and mobile number are filled in. The personal email is optional |
| Emergency contact (`emergencyContact`) | Its name, relationship and mobile number are filled in |
| Government IDs (`governmentIds`) | TIN, RDO code, SSS number, PhilHealth PIN and Pag-IBIG MID are filled in. Until they are verified, the item reads "Waiting for HR to verify" (it counts as done for the employee's progress) |
| Payroll bank account (`bankAccount`) | The bank, the account number and the account name are filled in; verified as for government IDs |
| 201 documents (`documents`) | For each type in the setting's `requiredDocumentTypes`, the employee has at least one unarchived 201 document of that type that hasn't expired. With an empty list the item is done |
| Profile photo (`photo`) | A profile photo is set |
| E-signature (`eSignature`) | At least one e-signature version is uploaded |

| HR item (status only for the employee) | Done when |
|---|---|
| Module access (`moduleAccess`) | The account isn't in the [User access page's](core.md#user-access-page) "Needs access" group: some module is above None, or the user is a System Administrator |
| Department, position, employment status (`department`, `position`, `employmentStatus`) | Set. Creating a user requires all three, so they are always done; they are listed so the employee sees them |
| `reportingTo` (`reportingTo`) | At least one supervisor in `reportingTo` is active; **or** the employee is a Board of Directors member; **or** HR, a Board member or the System Administrator has confirmed "No supervisor" for them (*Assumption*: the spec's "not required for employees with an empty `reportingTo`") |
| Work schedule (`workSchedule`) | Always done: the company default applies until HR sets an own schedule. It shows which ("Company default" or the own schedule) |
| Work region (`workRegion`) | Always done: it defaults to NCR. It shows the region (*Assumption*, with the work schedule: neither asks HR to confirm the default) |
| Salary and allowances (`compensation`) | The employee has a current or scheduled compensation entry. Allowances are optional (the internet allowance is automatic) |
| Company-issued assets (`assets`) | A **Placeholder** until Pulse Supply: "Available when Pulse Supply is set up". It isn't counted in the progress |

- **Progress.** The employee's progress counts the eight employee items ("5 of 8 done"). The HR items show beside them as status only, and HR sees their own count (8, without the placeholder). The onboarding is **complete** when every item but the placeholder is done and the government IDs and bank account are verified.
- **Required documents** come from the new versioned setting `talent.onboardingSettings` (`requiredDocumentTypes`: types from `DOCUMENT_201_TYPES` other than the employment contract, the regularization evaluation and "other", which HR issues or which name nothing). `pnpm seed:admin` seeds it once, effective 2000-01-01, with the source "Company policy (spec)": government ID copy and NBI clearance (*Assumption*: the spec names "201 documents" without a list). A Talent Owner changes it from Settings on `/talent`, as a new version effective today in Manila (at most one per day), with a `create` entry on `core.configVersion`.
- **"No supervisor" confirmation.** On the inspector's Onboarding section, HR, a Board member or the System Administrator (with Talent Read, which the inspector needs; never on their own record) confirms that an employee with no active supervisor has none, so their leave and offset time off go to HR. It is stored on the employee record (`noSupervisorConfirmation`: who and when) and can be withdrawn. It counts only while `reportingTo` has no active supervisor. Audit: `update` on `talent.employeeRecord`.

**Required but not enforced.**

- **Guided once.** After a new user changes their temporary password, the change-password page sends them to `/talent/onboarding` instead of Home, when their employee items aren't all done and they weren't on their way to another page. "Skip for now" goes to Home; nothing else is in the way.
- **Reminded until done.** While any employee item is To do, every page shows the onboarding progress in the top toolbar ("Onboarding 5 of 8", linking to `/talent/onboarding`), and Home shows a "Finish setting up your profile" card under the hero ([Feedback & motion](../DESIGN_SYSTEM.md#feedback--motion)). Both go once every employee item is done or waiting for HR. HR items never keep the reminder showing, since the employee can't act on them.
- Everything else in the app works with the checklist incomplete. Only the gates below block anything.

**Gates.** One config map in code, `ONBOARDING_GATES` in `packages/talent/src/onboarding/gates.ts`, maps each gated action to the items it needs. A gate is code, not a setting: each gated action has to call it, so a gate can't be added or dropped from a screen (*Assumption*: the spec's "config map" is a typed constant).

| Gate | Needs | Wired in |
|---|---|---|
| `applyESignature`: approvals, then quotations, purchase orders, delivery receipts, service reports, HR and handover documents as they are built | `eSignature` | Step 2.6, inside `applyESignature`, so every later caller gets it |
| `fileTimeRequest`: submitting a timesheet, filing leave or offset time off | `reportingTo` | Steps 2.7 and 2.8 |
| `includeInPayroll`: inclusion in a payroll run | `governmentIds` and `bankAccount`, each done **and verified** | Step 2.10, as the run's "incomplete onboarding" flag before HR submits |

- **The check.** `checkOnboardingGate(gate, status)` returns the missing items in the map's order; `assertOnboardingGate` throws `OnboardingGateError`, an `ActionError` that names them and carries their keys, so a screen can link to each. The message is "Complete this onboarding item first: <item>. <where>", or "Complete these onboarding items first: <item>, <item>." For an employee item, `<where>` says where to do it ("Upload it in My record, then try again."); for an HR item, "Ask HR to set it." For the e-signature: "Complete this onboarding item first: E-signature. Upload it in My record, then try again."
- **The e-signature gate** (step 2.6, the "Done when"). `applyESignature` now throws `OnboardingGateError` when the signer has an employee but no e-signature, instead of returning null. The signer runs in the approve decision's transaction, so the decision rolls back and the approver sees the message. Approving with no signature on file, which steps 2.2 to 2.5 allowed, is no longer possible. The **bootstrap system account** has no employee and can't have a signature, so it is exempt: it still approves and the decision records `signature: null`, shown as "Approved by the system account, without an e-signature" (*Assumption*: a request routed to the System Administrators must stay decidable when only the system account is active). Return and reject sign nothing and aren't gated.

**Verification of government IDs and the bank account.**

- **State.** Each of the two groups has its own verification on the employee record: `governmentIdsVerification` and `bankAccountVerification`, each null (not verified) or `{ verifiedAt, verifiedBy }`.
- **Who verifies.** Whoever may change that group directly: Talent Write **and** HR or the System Administrator; for an employee in the HR department, Talent Write **and** the System Administrator or a Board member, never HR (*Assumption*: an HR colleague verifying an HR employee's bank account is the same risk as changing it). Never on one's own record. Accounting never verifies. "Mark verified" shows only once the group is complete.
- **What sets and clears it.** The rule is that the stored values are verified when someone who may verify entered or approved them:
  - the employee fills in a blank field of the group (below): cleared
  - someone who may verify saves the group in the inspector: verified by them
  - an approved change request to the group: verified by the approver, who may verify by the routing below. The approvals inspector says so: "Approving applies the change and marks these details verified."
  - "Mark verified": verified by them
  - values saved before step 2.6 have no verification and read as not verified, so HR verifies them once (*Assumption*)
- **Shown** inside the Government IDs and Payroll bank account sections only, so it reaches only viewers who see the section: "Verified by <name> on <date>" or "Not verified". The employee sees theirs on `/talent/me` and on the checklist.
- **Audit:** `update` on `talent.employeeRecord`, with the verification in both snapshots. The values stay hidden as always.
- **Notification** `talent.verificationNeeded`: when the employee fills in a government ID or the bank account, to whoever may verify (every active HR user; for an HR employee, every active Board member and System Administrator), "Verify <name>'s government IDs" (or "payroll bank account"), linking to `/talent?employee=<employeeId>`. Sent in the save's transaction.

**What the employee changes themselves.** All on `/talent/me` and from the checklist, self-service ([Exceptions to module access](../../SECURITY.md#exceptions-to-module-access)): the services take no employee id and act on the signed-in user's own employee.

- **Filling in a blank field saves straight away.** The employee edits their own Personal (with the emergency contact), Government IDs, Payroll bank account and Skills sections. Each save is split by change request section (below). For each section, a save that only fills fields that are empty is saved directly, the first save creating the record. Filled-in government IDs and the bank account are then not verified. This holds after onboarding too (*Assumption*).
- **Changing a filled-in field is a change request.** When a save changes, for a section, any field that already has a value (or clears one), that section's part of the save becomes one change request, the blanks it fills included, and none of it is saved until it is approved. The sheet says which before the save: its button reads "Save" or "Send for approval" (the server decides again, and its answer says what was saved and what was sent).
- **Never by the employee:** Core's fields (name, login email, department, position, `reportingTo`, employment status, date hired; "Managed in Users", ask HR), the Employment fields (work region, contract end date, regularization date, separation remarks), compensation and allowances, and the work schedule. These stay with HR as in steps 2.1 to 2.4.
- **201 documents.** The employee uploads their own, from the checklist or `/talent/me`: any type but the employment contract and the regularization evaluation, which HR issues. The checks, the file handling and the audit entry are step 2.2's; the document shows "Uploaded by <name>". Editing and archiving stay with HR (Talent Write **and** HR or the System Administrator) (*Assumption*). Notification `talent.documentUploaded` to every active HR user (the System Administrators when none is active): "<name> uploaded an NBI clearance", linking to the record. It names the type, never the file name or title.
- **Certifications.** The employee adds their own on `/talent/me`, with step 2.2's fields and checks; it shows "Added by <name>". Editing needs Talent Write and removing Talent Owner, never on one's own record, as before (*Assumption*).

**Change requests.**

- **Sections.** A change request covers one section of the employee's own record:

  | Section (`CHANGE_REQUEST_SECTIONS`) | Fields | Approved by any one of |
  |---|---|---|
  | Contact details (`contact`) | Present address, permanent address, mobile number, personal email, emergency contact | The employee's active `reportingTo` supervisors and every active HR user |
  | Skills (`skills`) | Skills | The same |
  | Personal details (`personal`) | Date of birth, sex, civil status, nationality | Every active HR user |
  | Government IDs (`governmentIds`) | TIN, RDO code, SSS, PhilHealth PIN, Pag-IBIG MID | Every active HR user; **for an employee in the HR department, every active Board member** |
  | Payroll bank account (`bankAccount`) | Bank, account number, account name | The same as government IDs |

  - The requester is never an approver. A step left with no one goes to the System Administrators (the engine's `whenEmpty: 'systemAdministrator'`), and a step whose only approver is the requester goes to them too ([Approvals](core.md#approvals)).
  - *Assumption:* Personal details go to HR only, because a supervisor doesn't see the date of birth or civil status ([Sensitive data](../../SECURITY.md#sensitive-data)); the System Administrator approves government IDs and bank details only when routed there, not as a standing approver.
  - The on-screen Personal section holds both Contact and Personal details. One save that touches both makes two change requests.
- **Supervisors approve, they don't edit.** The spec's "HR and any supervisor in `reportingTo` can edit the employee's record" is read as: supervisors approve their team's change requests, seeing only that request's fields. Editing a record directly still needs Talent Write under the step 2.1 rules, so supervisors don't get a new view of their team's personal data (*Assumption, to be confirmed by the user and counsel*: data minimization under RA 10173).
- **The approval type** `talent.changeRequest`, registered by `registerTalentApprovalTypes()`, which the approvals Server Action calls beside `registerCoreApprovalTypes()` and `registerTalentApprovalSigner()`:
  - one step, given at submit (the table above): `anyOf` with the user ids Talent works out from Core's `employeeNotificationContacts` and `activeHrUserIds` for Contact details and Skills, `{ set: 'hr' }` for Personal details and for others' IDs and bank, `{ set: 'board' }` for an HR employee's IDs and bank
  - decisions: approve, return and reject
  - `whenEmpty: 'systemAdministrator'`
  - the title "Change request: <section label> · <first name> <last name>" and the summary "Fields: present address, mobile number" (field labels only). Neither ever holds a value
  - the link `/talent/change-requests/<id>`
- **Stored** in the new collection `changeRequests`: the employee, the requester, the section, the fields that change (`changedFields`), the proposed values of those fields only, an optional note from the employee (up to 500 characters), the status, the current approval request, and, once applied, the previous values and who approved it and when. Government ID numbers and the account number are `sensitiveField()`s, in both the proposed and the previous values.
- **Statuses:** `pending` → `approved` (applied), `returned` or `rejected`; a returned request can be edited and sent again (back to `pending`, as a new approval request linked to the old one with `previousRequestId`) or cancelled (`cancelled`). Approved, rejected and cancelled requests are final and never deleted. One employee has at most one open (`pending` or `returned`) request per section; while one is open, that section's Edit on `/talent/me` reads "A change to this section is waiting for approval" (or "…was returned") and opens the request instead.
- **Checks** when sending: the fields pass the record's own checks (the formats, the bank list, at most 30 skills…); at least one field changes; the section has no other open request. The employee can't withdraw a pending request: the engine has no withdraw, so they ask the approver to return it (*Assumption*).
- **Applying on approval.** The type's `onSettled` hook runs in the decision's transaction. On approve it:
  - checks again that the approver may approve this section for this employee **now** (HR or the System Administrator; for an HR employee's IDs and bank, a Board member or the System Administrator; for Contact details and Skills, any approver named at submit), since the employee may have moved department after submit. Otherwise it throws "This change can no longer be approved by you: <reason>. Return it instead.", and the decision rolls back
  - writes the changed fields only, over their current values, keeping the record's other fields, and raises the record's `version`. A value someone changed meanwhile is overwritten by the approved one; the request page shows the current values when the approver decides (*Assumption*: no conflict check)
  - stores the previous values on the request, sets the status, and sets the verification of an IDs or bank change to the approver
  - writes the audit entries below

  On return or reject it sets the status only, and the remarks show on the request.
- **Approving needs no module access.** Like every approval, the engine checks the person, not module access, so an HR approver doesn't need Talent Write; the hook checks the role (*Assumption*).
- **Who sees a change request** (the page and its values): the requester, anyone who is or was its approver (`isApproverFor`), the System Administrator, and Talent Read users who may see that section of the employee's record. Others get the no-access state (HTTP 403). The values follow the record's rules: government ID numbers and the account number are masked (last 4) with Reveal, audit-logged (`talent.changeRequest`, categories `governmentId` and `bankAccount`), and an approver who may not reveal them doesn't get the section, which the routing never allows. A supervisor without Talent Read gets the employee's directory fields only.

**Audit.** All in module `talent`, in the transaction of the change:

| Change | Entry |
|---|---|
| A blank field filled by the employee | `create` (first save) or `update` on `talent.employeeRecord`, the employee as actor |
| A change request sent, sent again or cancelled | `create` or `update` on `talent.changeRequest`, labelled `<employee number> · <section label>` |
| A change request approved, returned or rejected | `update` on `talent.changeRequest`, and on approval an `update` on `talent.employeeRecord` with the reason "Change request approved"; Core writes its own entry on `core.approvalRequest` |
| Verification, "No supervisor" confirmed or withdrawn | `update` on `talent.employeeRecord` |
| A 201 document uploaded or a certification added by the employee | Step 2.2's `create` entries |
| A change request value revealed | `reveal` on `talent.changeRequest` |
| The onboarding setting changed | `create` on `core.configVersion`, module `core` |

Sensitive values show only as "Hidden (sensitive), changed" ([Audit logging](../../SECURITY.md#audit-logging)). A gate refusal writes nothing.

**Notifications.** The approvals engine sends the change request events: waiting for the approvers, settled by another, and the outcome to the employee ([Approvals](core.md#approvals)). Talent adds `talent.verificationNeeded` and `talent.documentUploaded` (above). Nothing is sent for the checklist itself.

**Screens.**

- **`/talent/onboarding`**, the employee's checklist (self-service; the bootstrap system account gets an empty state). The page header "Onboarding" with "5 of 8 done" and a progress bar. Two inset grouped sections: **Your items**, each row with its status badge (text: "Done", "To do", "Waiting for HR to verify") and an action that opens the same sheet as on My record (Edit, Upload, Add photo, Upload e-signature); and **Set up by HR**, status only, with "Available when Pulse Supply is set up" on the assets row. "Skip for now" goes to Home. Reached from the toolbar progress, the Home card and My record.
- **The toolbar progress and the Home card** ([Feedback & motion](../DESIGN_SYSTEM.md#feedback--motion)), while any employee item is To do.
- **`/talent/me`** adds:
  - Edit on the Personal, Government IDs, Payroll bank account and Skills sections, with the footer "Empty fields are saved straight away. Changes to filled-in fields go to <approvers> for approval." and the button "Save" or "Send for approval"
  - the verification badge in Government IDs and Payroll bank account
  - "Upload document" in the 201 file and "Add certification"
  - **Change requests**: the employee's own, newest first, with their status badges, the remarks of a returned or rejected one, and "Edit and send again" and "Cancel request" on a returned one
- **`/talent/change-requests/<id>`**, the request (opened from Approvals and from My record). The employee, the section, when it was sent, the employee's note, and a list of the changed fields: Current and Proposed (Previous and Applied once approved), masked where the record masks them. A link "Open in Approvals" goes to `/approvals?request=<id>`. Read-only; deciding stays on Approvals. Breadcrumb "Pulse Talent › Change request".
- **The Approvals inspector.** When the viewer has no e-signature, a notice above the decision buttons reads "Approving needs your e-signature. Upload it in My record." with a link, and Approve is disabled; Return and Reject stay available. The server refuses an approve anyway (the gate). A change request also shows "Approving applies the change to <name>'s record" (and "…and marks these details verified" for IDs and bank).
- **The inspector** adds an **Onboarding** section (Talent Read): both lists with their states and progress, and "Confirm no supervisor" or "Withdraw" for those who may. An item about a section the viewer can't see (government IDs, bank account, salary, 201 documents) shows "Visible to HR, Accounting and the System Administrator" instead of its state, so the list never says whether such a value exists. The Government IDs and Payroll bank account sections get the verification badge and "Mark verified".
- **`/talent`** adds, for HR and the System Administrator, a filter "Onboarding: Incomplete | To verify" (`?onboarding=incomplete|verify`) and two stat tiles counting each. Other Talent Read users don't get them, because "To verify" would say who has IDs or a bank account on file (*Assumption*).
- **Settings on `/talent`** adds "Required onboarding documents" (Talent Owner).

**Not in step 2.6:** the `fileTimeRequest` and `includeInPayroll` gates' callers (steps 2.7, 2.8 and 2.10), company-issued assets (Phase 4), withdrawing a pending request (the engine has none), and email notifications.

## Skills & certifications

- Owned by Pulse Talent as part of the employee record. Pulse Ops (technician assignment) and Pulse Engage (presales, bids, product partner requirements (e.g. how many certified engineers a brand requires)) read it through Talent's service functions.
- Fields: certification name, issuing vendor/body (e.g. Cisco, Fortinet, TESDA, PRC), certificate/license number, issue date, expiry date, attachment.
- Expiry alerts to the employee, their `reportingTo` and HR before a certification lapses.

Built in step 2.2 ([Documents, photo, e-signature and certifications](#documents-photo-e-signature-and-certifications-build-step-22)):

- **Each certification** has a name, an issuer, an optional product from Core's products (so Pulse Engage can count how many employees hold a current certification for a brand), an optional certificate or license number, an issue date (required), an optional expiry date and an optional attachment.
  - The attachment opens for the employee, Talent Read and the System Administrator.
- **Who changes them.** Adding and editing need Talent Write, never on one's own record. Removing one is a soft delete and needs Talent Owner, also never on one's own record. From step 2.6 employees add their own on `/talent/me`; editing and removing them keep these rules ([Onboarding checklist and change requests](#onboarding-checklist-and-change-requests-build-step-26)).
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
- Built in step 2.7: [Timesheet approval, the DTR and the offset balance (build step 2.7)](#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27).

#### Daily Time Record (DTR)
- Computed per employee per day from the approved timesheet, schedule, approved leave, approved offset time off and confirmed holidays.
- Day statuses: present, **on leave (paid)**, **offset (paid)**, **leave without pay**, **absent (unpaid)**, holiday, rest day. Plus late minutes, undertime minutes, night differential hours (10:00 PM – 6:00 AM), and either overtime hours (Overtime timesheet) or offset hours earned (Standard timesheet).
- A scheduled work day with no time entry and no approved paid leave or offset time off is **absent (unpaid)**.
- Leave without pay and unpaid absences are deducted from pay at the daily rate (half the daily rate for a half day).
- The DTR is derived; never edit it directly. Confirmed holidays are never counted as absences.
- Built in step 2.7 (leave and offset time off from step 2.8): [Timesheet approval, the DTR and the offset balance (build step 2.7)](#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27). Time off on the DTR, partly covered days and `absentMinutes`: [Leave, offset time off and opening balances (build step 2.8)](#leave-offset-time-off-and-opening-balances-build-step-28).

### Work schedules and daily time entries (build step 2.4)

Built in step 2.4. Decisions 213–234 in [BUILD_PLAN.md](../BUILD_PLAN.md#decisions-added-to-the-spec). The collections and setting shapes are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership). Step 2.4 stores schedules, timesheets and time entries, and computes hours **for display only**. It computes no pay and stores no computed hours. Submission, approval, the DTR, the holidays-changed listener and crediting offset hours come in step 2.7; reimbursements in step 2.5 ([Reimbursements (build step 2.5)](#reimbursements-build-step-25)).

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

Step 2.7 adds the submission deadline, `submissionDeadlineDays`, which reads as 1 on a version stored without it, so no new version is seeded (decision 279). It is edited in the same Work schedule segment, under the same rules.

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
  - **Segmented control** "Daily entries | Reimbursements". Reimbursements was an empty state in step 2.4; step 2.5 fills it ([Reimbursements (build step 2.5)](#reimbursements-build-step-25)).
  - **Day list:** one row per day of the cut-off, from the date hired (or the cut-off's start) up to today (or the separation date), newest first. Each row shows the times with a "Manual" badge on each manual side, the activity and client, the day's overtime by kind ("OT 2.0 h · Ordinary day") or offset ("Offset 2.6 h"), and "Not claimed" or "No time out" where they apply. Rest days and holidays are labelled, and a run of rest days with no entries folds into one row.
  - **Day sheet:** the day's entries, "Add entry", and each entry's edit sheet: time in, time out with a "Next day" switch, activity, client, the disabled project and ticket pickers, and the switch "Count extra hours as overtime" (or "as offset") with its required reason.
  - A sticky footer shows the cut-off's total overtime or offset. There is no Submit button in step 2.4.
  - **My team.** A user with direct reports also gets a "My team" list on the page, each person linking to their timesheet.
- **`/talent/timesheets/<employeeId>`** with `?cutOff=`: the same view read-only, titled with the employee's name, for Talent Read or the employee's supervisors. Opened from "Timesheet" in the employee inspector and from My team. Its breadcrumb reads "Pulse Talent › Timesheet". The page loads the view before it renders, with no skeleton, so a refusal is a real HTTP 403 and an unknown employee or cut-off a real 404. Supervisors without Talent Read get only directory fields about the employee: the date hired and status are used on the server and never sent. The day list still starts at the date hired, and the previous cut-off button stops at the cut-off that holds it, so a supervisor can work out the date hired when it falls in a cut-off they open (*Assumption*: acceptable, as the supervisor works with the employee).
- **The inspector and `/talent/me`** get a Work schedule section: the schedule in effect, a scheduled one and the history. The inspector has "Set schedule" for those who may set it; `/talent/me` is read-only.

**Choices made for step 2.4** (also decisions 213–234):

- Hours are derived when read and never stored, so a holiday change needs no recompute in step 2.4; the DTR listener comes in step 2.7.
- Leave and offset time off days (step 2.8) need no entry; until then such days show as days with no entry.

### Reimbursements (build step 2.5)

Built in step 2.5. Decisions 235–255 in [BUILD_PLAN.md](../BUILD_PLAN.md#decisions-added-to-the-spec). The collections and the setting's shape are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership). Step 2.5 stores reimbursement lines on the timesheet and checks them. Submission and approval come in step 2.7, payment in step 2.9 (a separate non-taxable line), and Fiscal's postings and petty cash vouchers in Phase 5.

Each item marked *Assumption* is listed in [HANDOFF › Assumptions to check](../HANDOFF.md#assumptions-to-check) (items 62–75), to be confirmed by HR, the accountant or counsel.

**Reimbursement settings.** The versioned setting `talent.reimbursementSettings` is added to the payroll settings in the [configuration store](../DATA_MODEL.md#versioned-configuration). It holds:

- `filingWindowPreviousCutOffs`: how many cut-offs before the line's own a receipt may be dated in, from 0 to 6 (seeded 1: "the current or previous cut-off")
- `types`: the reimbursement types. Each has:
  - a key, fixed once added and never removed (a type no longer used is marked inactive), and a name
  - `active`: an inactive type can't be chosen for a new line, or changed to; lines that already have it keep it
  - `requiresRoute`: pick-up and drop-off are required
  - `requiresDescription`: a description of the expense is required
  - `requiresClient`: the client is required
  - an optional limit: an amount in centavos, either per `line` or per `day`

`pnpm seed:admin` seeds it once, effective 2000-01-01, with the source "Company policy (spec)":

| Type | Pick-up and drop-off | Description | Client | Limit |
|---|---|---|---|---|
| Meal (`meal`) | No | No | Optional | None |
| Transportation (`transportation`) | Required | No | Optional | None |
| Other (`other`) | No | Required | Optional | None |

*Assumptions:* no limits are seeded, because the spec names none (HR adds them as a new version), and the client is optional on every type, as on time entries. The setting is edited on the Payroll settings page in a new **Reimbursements** segment, under the step 2.3 rules (Talent Owner **and** HR or the System Administrator, an effective date later than every version and at most a year ahead, a required source, a `create` audit entry on `core.configVersion`). A line's type, required fields and limit come from the version in effect on its **receipt date**; the filing window from the version in effect **today**.

**Reimbursement lines** (collection `reimbursements`). Each line has:

- the **receipt date**
- the **type**
- the **merchant** (1 to 120 characters)
- the **merchant TIN**: 9, 12 or 14 digits as typed (dashes and spaces are fine), stored as the canonical 14 digits below and shown as `000-000-000-00000`
- the **receipt or invoice number** (1 to 40 characters, stored as typed). Under RA 11976 (the EOPT Act) and RR 7-2024 the invoice replaced the official receipt as the primary document, so the field reads "Receipt or invoice number" (*Assumption*)
- the **amount**: a positive whole number of centavos, typed in pesos
- the **receipt**: a photo or a PDF, required
- the **client**: any live client from Core's client options; an existing line keeps a retired client, shown as "Removed client"
- **pick-up** and **drop-off** (1 to 200 characters each), when the type requires them
- a **description** (1 to 300 characters), required when the type requires it, optional otherwise

The **project** picker shows in the sheet, disabled, with "Available when Pulse Ops is set up". No project field is stored until Phase 4. The client is for tracking and reporting only: **reimbursements are never billed or charged to the client**, and no service offers them for billing.

**The timesheet a line belongs to.** A line is added on the employee's own timesheet being viewed, and stays on it (`timesheetId` never changes; to move one, delete it and add it again). A receipt dated in the previous cut-off, filed on the current timesheet, is paid with the current one.

**Checks**, on the server, in the save's transaction:

- the line's timesheet is `open`
- the receipt date is between the start of the cut-off N before the line's timesheet and the earlier of that timesheet's end and today (N is `filingWindowPreviousCutOffs`), on or after the date hired, and not after the separation date
- **adding** a line also needs its timesheet's cut-off to be today's or one of the N before it, so only the current and previous timesheets take new lines. Editing and deleting need only an open timesheet, so a timesheet returned in step 2.7 can still be fixed (*Assumption*)
- the type is in the version in effect on the receipt date and active (a stored inactive type is kept on edit), and the type's required fields are filled
- the merchant TIN is 9, 12 or 14 digits, and the amount is positive
- the receipt isn't claimed already (below)
- each form sends back the line's `version`; a stale save is refused with "Someone else changed this reimbursement. Reload to see it."

**No duplicates.** The same merchant TIN and receipt number can never be claimed twice, by anyone, as a reimbursement or (from step 5.11) on a petty cash voucher.

- **The register.** Every claimed receipt has one live entry in the Talent collection `receiptClaims`: the canonical TIN, the receipt key, the claim type (`talent.reimbursement`; `fiscal.pettyCashVoucher` from step 5.11), the claim's id and, for a reimbursement, the employee. A unique index on the TIN and the key among live entries (`deletedAt: null`) makes the check atomic across employees and modules: of two saves of one receipt at once, exactly one saves.
- **The canonical TIN** is 14 digits: a 9-digit TIN gets the head office branch code `00000`, and a 12-digit TIN's 3-digit branch code is padded to 5 (`001` → `00001`). *Assumptions:* a TIN with no branch code is the head office, and the branch is part of the key, because invoice series are registered per branch.
- **The receipt key** is the number in capitals, with everything but letters and digits removed and leading zeros dropped (`or-000123` and `OR 123` match). *Assumption.*
- **When.** A duplicate is rejected when the line is saved, which is stricter than "on submission"; step 2.7's submission checks every line's claim again (*Assumption*). Deleting a line, or changing its TIN or receipt number, releases its claim in the same transaction, so the receipt can be claimed again.
- **The messages.** The employee's own earlier claim: "You already claimed this receipt on <date> (<type>)." Anyone else's, a voucher included: "This receipt has already been claimed. Each receipt can be claimed once. Ask HR if you think this is wrong." The other claimant is never named to the employee (*Assumption*).
- **The service.** Talent's `claimReceipt` and `releaseReceiptClaim` run in the caller's transaction, and the TIN and key normalizers are exported, so Pulse Fiscal's petty cash calls the same service in step 5.11 ([Cross-module integration](../ARCHITECTURE.md#cross-module-integration)).
- **Check a receipt.** Talent Read opens "Check a receipt" on `/talent`: a merchant TIN and a receipt number give the live claim, if any, with the claimant's name and employee number, the receipt date, type and amount, and a link to the timesheet (or "Petty cash voucher" from step 5.11). See [RUNBOOK](../RUNBOOK.md#a-receipt-was-rejected-as-a-duplicate).
- *Assumption, to be confirmed by the accountant:* the app doesn't check that a receipt is made out to the company, and a ride with no receipt (jeepney, tricycle) can't be claimed.

**Limits.** Over-limit lines are highlighted, never refused, for the employee and the approvers alike. With the limit of the version in effect on the receipt date:

- **per line**: the line's amount is over the limit
- **per day**: the employee's live lines of that type dated that day, across every timesheet, add up to more than the limit; each of them is flagged

The line shows by how much, for example "₱120.00 over the daily limit".

**The receipt file.** Uploaded with the line and stored in the private [file storage](../ARCHITECTURE.md#file-storage) folder (owner type `talent.reimbursement`). JPEG, PNG and WebP images are re-encoded (WebP, at most 2000 px, auto-rotated, metadata such as GPS stripped); PDFs are stored byte for byte. The upload settings' types and size limit apply. A new file on edit replaces the old one, which is kept but no longer opens. The file opens for whoever may open the timesheet, only through a live line that points at it. Views aren't audit-logged: a receipt isn't [sensitive personal information](../../SECURITY.md#sensitive-data) (*Assumption*: pick-up and drop-off can show a home address, and supervisors see them).

**Who may do what.**

- **The employee** adds, edits and deletes their own lines. This is self-service, outside module access; the services take no employee id from the request. The bootstrap system account has no timesheet.
- **Talent Read** and the employee's `reportingTo` **supervisors** see the lines and open the receipts, read-only, on `/talent/timesheets/<employeeId>`.
- **Nobody changes another person's lines**, HR and the System Administrator included. Corrections come through "return with remarks" in step 2.7.

**Serialization and audit.** Each line save touches its timesheet (the step 2.4 touch: `updatedBy` and `__v`), so step 2.7's submission conflicts with a save in flight. Deleting is a soft delete after a confirmation ("Delete reimbursement"). `create`, `update` and `delete` entries on `talent.reimbursement`, labelled `<employee number> · <receipt YYYY-MM-DD>`, are written in the same transaction; the register's writes have no entries of their own, since the line's snapshot holds the TIN and number. No notification is sent.

**Screens** (phone first; see [Timesheets on a phone](../DESIGN_SYSTEM.md#layout--components)).

- **The Reimbursements segment** on `/talent/timesheet` and `/talent/timesheets/<employeeId>` lists the timesheet's lines, grouped by receipt date, newest first. Each row shows the type, the merchant, the client, the amount, a receipt thumbnail (or a PDF icon), and "Over limit" where it applies. With no line: "No reimbursements yet".
- **"Add reimbursement"** shows on the employee's own open timesheet within the filing window. It opens the reimbursement sheet: the receipt first ("Take a photo or choose a file"), then the type, the date (with "Receipts dated <from> – <to>"), the merchant, the merchant TIN, the receipt or invoice number, the amount, the client (with "For tracking only. Reimbursements are never billed to the client."), the disabled project picker, pick-up and drop-off for a type that requires them, and the description. A duplicate is shown under the receipt or invoice number.
- **A line** opens the same sheet to edit (own, open timesheet), or a read-only detail with "Open receipt".
- **The footer** shows "Reimbursements ₱1,234.50 · 3 receipts" while the segment is shown.
- **Payroll settings** gets the Reimbursements segment; **`/talent`** gets "Check a receipt" for Talent Read.

### Timesheet approval, the DTR and the offset balance (build step 2.7)

Spec written first; not built yet. Decisions 277–298 in [BUILD_PLAN.md](../BUILD_PLAN.md#decisions-added-to-the-spec). The new fields, the new collection and the setting change are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership), the attendance rules in [Attendance and the DTR](../COMPLIANCE.md#attendance-and-the-dtr-build-step-27), and who may see what in [Exceptions to module access](../../SECURITY.md#exceptions-to-module-access). Step 2.7 adds submission, the deadline and its reminders, the HR list of timesheets by status, approval by any one supervisor and then HR through Core's [approvals engine](core.md#approvals), the lock, crediting offset hours to a derived offset balance, the Daily Time Record, and the holidays-changed listener. Leave and offset time off on the DTR, opening balances and offset usage come in step 2.8; pay in step 2.9.

Each item marked *Assumption* is listed in [HANDOFF › Assumptions to check](../HANDOFF.md#assumptions-to-check) (items 123–137), to be confirmed by HR, the accountant, counsel or the user.

**Statuses** (`TIMESHEET_STATUSES`, replacing step 2.4's single `open`):

| Status | Label | Meaning |
|---|---|---|
| `open` | "Open" until the cut-off ends, then "Not submitted" ("Overdue" after the deadline) | The employee fills it in. Entries and reimbursement lines can change |
| `pendingSupervisor` | "Waiting for supervisor" | Submitted; the supervisor step is pending |
| `pendingHr` | "Waiting for HR" | The supervisor approved it, or the step was skipped |
| `returned` | "Returned" | An approver returned it with remarks. Entries and lines can change again; the employee resubmits |
| `approved` | "Approved" | HR approved it. Locked for good |

- **Moves.** `open` or `returned` → `pendingSupervisor` (or straight to `pendingHr` when the supervisor step is skipped) on submit; `pendingSupervisor` → `pendingHr` when a supervisor approves; either pending status → `returned` on a return, or → `approved` when HR approves. Nothing else moves a status. There is no withdraw (the engine has none, as in decision 272) and no reopen: an approved timesheet is never changed (*Assumption*).
- **What can change when.** Time entries and reimbursement lines are added, edited and deleted only while their timesheet is `open` or `returned`. On a pending timesheet the refusal reads "This timesheet is waiting for approval, so it can't change. Ask your approver to return it if something needs fixing."; on an approved one, "This timesheet is approved and locked." (*Assumption:* a pending timesheet can't be changed or withdrawn by the employee.)
- **Stored on the timesheet:** `status`, `submittedAt` (the latest submit), `approvalRequestId` (the current request), `supervisorApprovedAt` and `supervisorApprovedBy`, `approvedAt` and `approvedBy` (HR), `returnedAt`, `returnedBy` and `returnRemarks` (the latest return). The write guard allows these only through the timesheet service, besides step 2.4's touch.

**The submission deadline.** `talent.timesheetSettings` gains `submissionDeadlineDays`, a whole number from 1 to 10. A version stored without it, the seeded 2000-01-01 version included, reads as **1** (the spec's default), so no new version is seeded; HR changes it by adding a version in the Work schedule segment of Payroll settings, under the step 2.3 rules (*Assumption*: 1 day). This replaces step 2.4's "step 2.7 adds the submission deadline in a later version".

- **The deadline** of a timesheet is the end of the Manila day `periodEnd + submissionDeadlineDays`, with N from the version in effect on `periodEnd`. A period shortened by a new pay schedule uses its own end.
- **Submission opens** on the Manila day after `periodEnd` and stays open after the deadline: a late timesheet is still accepted and marked "Submitted late" (submitted on a day after the deadline). Before the cut-off ends there is no Submit button, and the service refuses with "You can submit this timesheet from <day after the cut-off>." (*Assumption:* not on the cut-off's last day, and late submissions are accepted.)

**Submitting** (self-service: the employee's own timesheet only, no employee id taken from the request). In one transaction, after step 2.4's touch, so a save still in flight conflicts and retries:

- the timesheet is the actor's own and is `open` or `returned`, and today is after its `periodEnd`
- the onboarding gate `fileTimeRequest` passes (`assertOnboardingGate`): the `reportingTo` item is done, which also covers an employee with "No supervisor" confirmed or a Board member ([Onboarding checklist and change requests](#onboarding-checklist-and-change-requests-build-step-26))
- no entry is still open ("Time out first: <day> has no time out."), and every closed entry has an activity
- every live reimbursement line still holds its live claim in `receiptClaims` (the second check promised by decision 243); a line whose claim is missing or belongs to another claim is named and refused
- the employee's account is active

A timesheet with no entries can be submitted; the confirmation warns that every scheduled day will show as absent (*Assumption*). The submit sets the status, `submittedAt` and `approvalRequestId`, submits the approval request (below) in the same transaction, and writes an `update` audit entry on `talent.timesheet`, labelled `<employee number> · <period start>`, with the reason "Submitted" (or "Resubmitted").

**Approval** (the approval type `talent.timesheet`, registered by `registerTalentApprovalTypes()` beside `talent.changeRequest`, so `apps/web/lib/approval-types.ts` needs no change):

- **Steps:** (1) `reportingTo`, labelled "Supervisor", `whenEmpty: 'skip'`; (2) `anyOf` `{ set: 'hr' }`, labelled "HR", `whenEmpty: 'systemAdministrator'`. The engine leaves out inactive supervisors and the requester, so an HR employee's own timesheet goes to the other HR users at step 2, and to the System Administrators only when the requester is the only active HR user ([Reporting lines](core.md#reporting-lines)). Approvers are fixed at submit.
- **Decisions:** approve and return only, as [Approvals](core.md#approvals) says for timesheets. A return needs remarks.
- **Title** "Timesheet: <first last> · Sep 11 – 25, 2026"; **summary**: the timesheet type, worked hours, total overtime or offset, the number of manual times, and the reimbursement count and total with the number over a limit (no sensitive field); **link** `/talent/timesheets/<employeeId>?cutOff=<period start>`; **record** `talent.timesheet`, the timesheet id, its audit label.
- **`onStepApproved`** for the Supervisor step: `pendingHr`, with `supervisorApprovedAt` and `supervisorApprovedBy`, and an `update` audit entry ("Approved by supervisor").
- **`onSettled`**, in the decision's transaction:
  - **approve** (HR's): `approved`, `approvedAt`, `approvedBy`; the offset credit below; an `update` audit entry ("Approved"). From then on the timesheet is locked.
  - **return** (at either step): `returned`, with `returnedAt`, `returnedBy` and `returnRemarks`; an `update` audit entry with the remarks as its reason.
- **Resubmitting** a returned timesheet submits a new request with `previousRequestId`, which starts again at the Supervisor step.
- **Approved as a whole.** Approving approves everything on the timesheet: every claimed overtime or offset minute and every reimbursement line. To drop a claim, an approver returns it with remarks (*Assumption*).
- **Notifications** are the engine's: `core.approvalRequested` to the supervisors and then to HR ("timesheets waiting for approval"), `core.approvalSettled` to the other approvers, and `core.approvalApproved` or `core.approvalReturned` to the employee ("timesheet returned with remarks or approved"). Talent sends no extra one for these.

**Who may see a timesheet** (adding to step 2.4's rule): the employee, Talent Read, the `reportingTo` supervisors, and now anyone who is or was an approver on one of its approval requests (Core's `isApproverFor` on `talent.timesheet` and the timesheet's id), read-only and whatever their module access ([Exceptions to module access](../../SECURITY.md#exceptions-to-module-access)). An HR approver without Talent Read gets the directory fields only, as a supervisor does. Nobody but the employee changes entries or lines, HR included: corrections still come through a return (*Assumption*, keeping item 54).

**The offset balance** (Standard timesheet; [Offset balance & offset time off](#offset-balance--offset-time-off)). It is the sum of the employee's **offset entries**, in whole minutes, never stored or edited:

- **The collection `offsetEntries`**, insert-only: the employee, the kind (`OFFSET_ENTRY_KINDS`: `opening` and `usage` from step 2.8; `credit` and `adjustment` from step 2.7), the signed minutes, the Manila day it counts from, the timesheet (for a credit or an adjustment), a reason, and who wrote it (null for the system). One `credit` per timesheet, by a partial unique index.
- **The credit.** When HR approves a timesheet, the hook writes one `credit` of the timesheet's offset total as the DTR computes it at that moment (the sum of each day's rounded offset), dated the approval day. It is written when the total is above 0, or when the timesheet's extra hours are treated as offset (a 0-minute credit records that the timesheet was credited). An Overtime timesheet earns no credit unless `extraHours` treats it as offset. Audit: `create` on `talent.offsetEntry`, labelled `<employee number> · <YYYY-MM-DD>`, in the decision's transaction.
- **Adjustments** come only from the holidays-changed listener (below). The balance can go below zero after one; offset time off (step 2.8) then waits until it is positive again (*Assumption*). There is no manual offset correction in step 2.7 (*Assumption*).
- **Who sees it:** whoever may see the employee's timesheet. It isn't sensitive.
- **On the timesheet,** the Offset card shows the balance ("Balance 12.5 h"), with "+X h this cut-off, credited when HR approves your timesheet" until it is approved and "Credited +X h on Sep 28" after.

**The Daily Time Record** ([Daily Time Record (DTR)](#daily-time-record-dtr)). Derived when read and never stored, like step 2.4's hours: the pure `computeDtr` in `packages/talent/src/dtr/` builds on `computeTimesheet`, and Talent's `getDtr(actor, employeeId, from, to)` loads its inputs. Every period not yet finalized is therefore always current. It covers each day from the later of the period start and the date hired to the earliest of the period end, the separation date and today.

- **Day statuses** (`DTR_DAY_STATUSES`), first match wins:

  | Status | When |
  |---|---|
  | `holiday` | A confirmed nationwide holiday (a regular holiday or a special non-working day), worked or not. Never an absence |
  | `restDay` | The schedule doesn't list the weekday |
  | `onLeavePaid`, `offsetPaid`, `leaveWithoutPay` | Approved leave or offset time off covers the day (step 2.8; never produced in step 2.7) |
  | `present` | A scheduled work day with worked minutes above 0 |
  | `absentUnpaid` | A scheduled work day with no worked minutes |

  A special working day is a scheduled work day. Worked minutes, overtime and offset still show on a holiday or rest day that was worked.
- **Late minutes**, on a `present` day only: when the first time in is later than the scheduled start by more than the grace period, the late minutes count from the scheduled start; within the grace period they are 0 (*Assumption*).
- **Undertime minutes**, on a `present` day only: the scheduled minutes (the span less the break) after the first time in that no entry covers, so leaving early and a gap in the middle both count. Work after the scheduled end never makes up a late start or undertime (Labor Code Art. 88; *Assumption*).
- **Night differential minutes** are step 2.4's paid minutes inside the night window: scheduled worked minutes plus, on the Overtime timesheet, claimed extra minutes. Standard employees get them for their scheduled night hours.
- **Extra hours:** overtime by kind (Overtime timesheet) or offset minutes earned (Standard), exactly as step 2.4 computes them.
- **Final or preview.** Days on an approved timesheet are `final`; the others are a preview ("Not approved yet"), which payroll (step 2.9) treats as the spec says for a timesheet that isn't fully approved.
- **Not in step 2.7:** whether an unworked regular holiday is paid (the day before), the daily-rate deductions and half days: steps 2.8 and 2.9 apply them to the DTR's figures.

**Hand-checked DTR cases.** With the seeded schedule (08:00–17:00, break 12:00–13:00, grace 15 minutes), `hoursPerDay` 8, the night window 22:00–06:00 and `offsetRatio` 1. Each extra-hours entry is marked.

| # | Case | Expected |
|---|---|---|
| D1 | Ordinary day, 08:10–17:00 | Present; late 0 (within grace); undertime 0; worked 7.8 h |
| D2 | Ordinary day, 08:16–17:00 | Present; late 16 min; undertime 0 |
| D3 | Ordinary day, 08:15–17:00 | Present; late 0 (exactly the grace period) |
| D4 | Ordinary day, 08:00–16:00 | Present; undertime 60 min |
| D5 | Ordinary day, 08:00–12:00 and 14:00–17:00 | Present; undertime 60 min (13:00–14:00); worked 7.0 h |
| D6 | Ordinary day, 08:30–17:30 | Present; late 30 min; undertime 0; extra 0 (the late start isn't made up) |
| D7 | Ordinary day, no entry | Absent (unpaid) |
| D8 | Saturday, no entry | Rest day |
| D9 | Monday 2026-11-30, confirmed regular holiday, no entry | Holiday (not absent). With the holiday a draft: absent (unpaid) |
| D10 | Standard, ordinary day, 08:00–19:00 | Present; offset 120 min (2.0 h); night differential 0 |
| D11 | Overtime (a Driver), ordinary day, 08:00–23:30 | Present; ordinary day 6.5 h; night differential 1.5 h |
| D12 | Standard, an own schedule 14:00–23:00 (break 18:00, 60 minutes), 14:00–23:00 | Present; late 0; night differential 1.0 h; offset 0 |
| D13 | Credit: a Standard timesheet with D10 and step 2.4's case 10 (155 min), approved by HR | One `credit` of 275 min (4.6 h); the balance rises by 4.6 h |
| D14 | Holiday changed: an approved Standard timesheet with Monday 2026-11-30, 08:00–17:00 marked, credited while the holiday was a draft (0 min) | Confirming the holiday adds an `adjustment` of +480 min (8.0 h); deleting it again adds −480 min |

**The holidays-changed listener** `talent.recomputeDtr`, registered with Core's `registerHolidaysChangedListener` by the worker ([Holiday calendar](core.md#holiday-calendar), [Cross-module integration](../ARCHITECTURE.md#cross-module-integration)):

- The DTR is derived when read, so no stored DTR needs recomputing. What the listener recomputes is the one stored value derived from it: the offset credits of **approved** timesheets whose period holds one of the changed dates.
- For each, in its own transaction (after step 2.4's touch on the timesheet): the target is the DTR's offset total now; the credited total is the sum of the timesheet's `credit` and `adjustment` entries; a difference becomes an `adjustment` entry with the reason "Holiday changed: <YYYY-MM-DD>", audited as a `create` with no actor (a system action). It is idempotent: a second run finds no difference.
- It applies to finalized payroll periods too, because offset hours are never pay (*Assumption*). The employee is notified in the same transaction: `talent.offsetAdjusted`, "Your offset balance changed by +8.0 h: the holidays on Nov 30 changed", linking to that timesheet (*Assumption*: the spec lists no such event).
- Timesheets not yet approved need nothing: their DTR and offset are read fresh, and their credit is computed at HR approval.
- From step 2.9 the payroll run stores the DTR figures it paid, so a holiday change to a finalized period becomes an adjustment in the next cut-off there, and step 2.9 extends this listener to draft runs. A lost job (decision 132) is accepted; step 2.10 reconciles at finalize.

**Reminders and the missing list** (the job `talent.timesheetReminders`, daily at 08:00 Asia/Manila, cron `0 8 * * *`; [Background jobs](../ARCHITECTURE.md#background-jobs)). Only timesheets whose deadline is yesterday, today or tomorrow are read, so old cut-offs never remind anyone (*Assumption*):

- **`talent.timesheetDue`** to the employee, for an `open` or `returned` timesheet with an active account: on the day submission opens ("Your timesheet for Sep 11 – 25 is ready to submit, due <deadline>"), on the deadline day ("due today") and on the day after ("overdue"). At most one per timesheet per Manila day (`notify()`'s `dedupeKey` `talent.timesheetDue:<timesheet id>:<YYYY-MM-DD>`). Link `/talent/timesheet?cutOff=<period start>`.
- **`talent.timesheetsMissing`** to every active HR user (the System Administrators when none is active), on the day after the deadline, when any timesheet of that period is still `open` or `returned`: "<N> timesheets not submitted for Sep 11 – 25", once per period (`dedupeKey` `talent.timesheetsMissing:<period start>`). Link `/talent/timesheets?cutOff=<period start>&status=notSubmitted`.
- Separated employees and inactive accounts get no reminder, and their last timesheet is left for HR's separation step (step 2.14; *Assumption*).
- `pnpm dev:timesheet-reminders [--date YYYY-MM-DD]` runs the job once in development, like `pnpm dev:expiry-alerts`; it refuses in production.

**Screens** (phone first; see [Timesheets on a phone](../DESIGN_SYSTEM.md#layout--components)).

- **The status banner** at the top of `/talent/timesheet` and `/talent/timesheets/<employeeId>`: "Submitted Sep 26 · Waiting for supervisor" (with the approvers' names), "Waiting for HR", "Returned by <name> on <date>" with the remarks, "Approved by <name> on <date> · Locked", or, after the cut-off ends, "Not submitted · Due Sep 26" ("Overdue" after it). "Submitted late" shows as a text badge.
- **Submit.** On the employee's own `open` or `returned` timesheet after the cut-off ends, the sticky footer's primary button reads "Submit timesheet" ("Resubmit" when returned). It opens a confirmation sheet: days present, absent and late, the total overtime or offset, the reimbursement total, the count of manual times, any blocking problem (an entry with no time out, a missing onboarding item) named with a link, and "You can't change it while it's waiting for approval."
- **The DTR segment.** The segmented control becomes "Daily entries | Reimbursements | DTR". The DTR lists one row per day, newest first: the status as a text badge, late and undertime minutes, night differential, and overtime or offset, with "Not approved yet" on a preview. Totals sit in the sticky footer while it shows.
- **An approver** sees "Waiting for your approval · Open in Approvals", linking to `/approvals?request=<id>`, where the decision is made. Nothing is decided on the timesheet page.
- **My team** shows each person's status for the latest ended cut-off.
- **`/talent/timesheets`**, the timesheets list, for Talent Read: a cut-off picker (the latest ended cut-off by default), tiles counting Not submitted, Waiting for supervisor, Waiting for HR, Returned and Approved (each a filter, `?status=`), and one row per employee with their department, timesheet type, status, "Submitted late" and a link to the timesheet. It is a list, never a table, on a phone. It is reached from a "Timesheets" button on `/talent` and from `talent.timesheetsMissing`; its breadcrumb reads "Pulse Talent › Timesheets". The list is the on-screen form of the [HR report](#hr-reports) "Timesheet status per cut-off"; its PDF and Excel exports come in step 2.16 (*Assumption:* Talent Read, not HR only, sees it).
- **Payroll settings › Work schedule** gets the "Submission deadline (days after the cut-off)" field on `talent.timesheetSettings`.

**Cross-module.** `getDtr` and `getOffsetBalance(actor, employeeId)` are Talent services for steps 2.8, 2.9 and 2.13, and for Pulse Ops' reads of approved overtime in Phase 4 ([Cross-module integration](../ARCHITECTURE.md#cross-module-integration)).

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
- Built in step 2.8: [Leave, offset time off and opening balances (build step 2.8)](#leave-offset-time-off-and-opening-balances-build-step-28).

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
- From build step 2.7 the balance is the sum of `offsetEntries`: a `credit` when HR approves a Standard timesheet, and an `adjustment` when a holiday change alters an approved timesheet's offset ([Timesheet approval, the DTR and the offset balance (build step 2.7)](#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27)). Opening and usage entries come in step 2.8 ([Leave, offset time off and opening balances (build step 2.8)](#leave-offset-time-off-and-opening-balances-build-step-28)), which also lets HR add a correcting `adjustment` with a reason.

## Opening balances at go-live

- When Pulse Talent goes live, HR enters opening figures once for each existing employee, as of the go-live date:
  - opening VL, SL and offset balances
  - year-to-date pay: gross pay, basic salary earned (for 13th month pay), taxable income, tax withheld and contributions
- They are dated, audit-logged opening entries, never edits to a balance. Leave and offset balances, payslip year-to-date figures, 13th month pay and BIR Form 2316 build on them.
- Built in step 2.8: [Leave, offset time off and opening balances (build step 2.8)](#leave-offset-time-off-and-opening-balances-build-step-28).

### Leave, offset time off and opening balances (build step 2.8)

Spec written first; not built yet. Decisions 299–324 in [BUILD_PLAN.md](../BUILD_PLAN.md#decisions-added-to-the-spec). The new setting and collections are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership), the leave law in [Leave and time off](../COMPLIANCE.md#leave-and-time-off-build-step-28), and who may see what in [Exceptions to module access](../../SECURITY.md#exceptions-to-module-access) and [Sensitive data](../../SECURITY.md#sensitive-data). Step 2.8 adds leave types as data, leave balances from entries, crediting at regularization and every January 1 with carry-over, leave and offset time off requests on one request sheet with their approval, time off on the DTR, and the opening entries at go-live. Pay (the daily-rate deductions, leave without pay, maternity pay) is step 2.9; the regularization evaluation that sets the regularization date is step 2.13; the HR leave and offset reports are step 2.16.

Each item marked *Assumption* is listed in [HANDOFF › Assumptions to check](../HANDOFF.md#assumptions-to-check) (items 150–180), to be confirmed by HR, the accountant, counsel or the user.

**Leave settings** (the new versioned setting `talent.leaveSettings`, seeded by `pnpm seed:admin` from 2000-01-01 with the source "Company policy (spec) and the laws named per type"). HR adds a version in a new **Leave** segment of Payroll settings, under the step 2.3 rules (Talent Owner **and** HR or the System Administrator). A type's key, once added, stays in every later version; a type is retired by `active: false`.

- **`goLiveDate`**: the Manila day Pulse Talent goes live, or null (seeded null). While it is null, no credit is written automatically and no opening entry can be entered; the Leave segment and the opening balances page say "Set the go-live date first." Once any opening entry exists, a new version can't change it (*Assumption*).
- **`offsetTimeOff`**: `minimumMinutes` (60, the spec's 1 hour) and `stepMinutes` (30), both whole minutes from 15 to 480 (*Assumption*: 30-minute steps).
- **`types`**, each:

  | Field | Meaning |
  |---|---|
  | `key`, `name`, `shortName` | For example `vacation`, "Vacation leave", "VL" |
  | `active` | A retired type can't be filed; past requests keep it |
  | `paid` | Paid days show on the DTR as `onLeavePaid`; an unpaid type's days as `leaveWithoutPay` |
  | `balance` | `credited` (a running balance of entries: VL, SL), `perEvent` (up to `days` per request: maternity, paternity, special leave for women) or `perYear` (up to `days` per calendar year, counting approved and pending requests: solo parent, VAWC) |
  | `days` | The annual credit (`credited`), the most per request (`perEvent`) or per year (`perYear`), in whole or half days |
  | `countDays` | `workDays` (only the employee's scheduled work days count; rest days and confirmed holidays don't) or `calendarDays` (every day counts, as the law sets maternity leave) |
  | `halfDays` | Whether a single-day request may be a half day |
  | `crediting` | `credited` only: `annualCreditOn` (`MM-DD`, seeded `01-01`), `prorateFromRegularization` (true), `carryOverCapDays` (null for no cap, the spec's default) |
  | `eligibility` | `employmentStatuses` (who may file), `sex` (null, `female` or `male`, read from the employee record), `minServiceMonths` (null or whole months since the date hired), `maxRequests` (null or the most approved requests ever, for paternity) |
  | `filing` | `minNoticeDays` (null or the days between filing and the first day, VL 14), `allowFuture` and `allowPast` (a past day may be filed up to the timesheet deadline of the cut-off holding the request's first day) |
  | `attachment` | null, or `{ label, required }`, for example "Medical certificate", required |
  | `confidential` | Routes to HR only and hides the type's name from everyone but the employee, HR and the System Administrator (VAWC) |
  | `legalBasis` | Text such as "RA 11210", or null |

- **Seeded types** (every figure is an *Assumption*, to be confirmed by HR and counsel; see [Leave and time off](../COMPLIANCE.md#leave-and-time-off-build-step-28)):

  | Key | Name (short) | Paid | Balance, days, counting | Half days | Eligibility | Filing | Attachment |
  |---|---|---|---|---|---|---|---|
  | `vacation` | Vacation leave (VL) | Yes | `credited` 5 a year, work days, no carry-over cap | Yes | Regular | At least 14 days ahead; never a past day | None |
  | `sick` | Sick leave (SL) | Yes | `credited` 5 a year, work days, no cap | Yes | Regular | On or after the sick day, by the first day's timesheet deadline; never a future day | Medical certificate, required |
  | `maternity` | Maternity leave (ML) | Yes | `perEvent` 105, calendar days | No | Female; every status | Ahead, or after up to the deadline | Medical certificate or proof of pregnancy, required |
  | `maternitySoloParent` | Maternity leave, solo parent (ML-SP) | Yes | `perEvent` 120, calendar days | No | Female; every status | As maternity | As maternity, plus the Solo Parent ID in the same file |
  | `maternityMiscarriage` | Maternity leave, miscarriage or emergency termination (ML-M) | Yes | `perEvent` 60, calendar days | No | Female; every status | As maternity | Medical certificate, required |
  | `maternityExtension` | Maternity leave extension, without pay (ML-X) | **No** | `perEvent` 30, calendar days | No | Female; every status | As maternity | None |
  | `paternity` | Paternity leave (PL) | Yes | `perEvent` 7, work days; at most 4 approved requests | No | Male; every status | As maternity | Proof of the delivery, optional |
  | `soloParent` | Solo parent leave (SPL) | Yes | `perYear` 7, work days | Yes | Every status; 6 months since the date hired | As maternity | Solo Parent ID, required |
  | `vawc` | VAWC leave (VAWC) | Yes | `perYear` 10, work days; **confidential** | Yes | Female; every status | As maternity | Barangay, police, prosecutor or court certification, required |
  | `specialLeaveWomen` | Special leave for women (SLW) | Yes | `perEvent` 60, calendar days | No | Female; every status; 6 months since the date hired | As maternity | Medical certificate, required |

  "Every status" is Probationary, Regular and Contractual, since statutory leaves don't follow the company probation rule. The 5 days of VL still stand in for the 5-day Service Incentive Leave (see [Leave](#leave)).

**Units and counting.**

- Leave is counted in **half days**, stored as whole numbers of half days, so 2.5 days is 5. Offset is counted in whole **minutes**, as in step 2.7. Balances show one decimal ("4.5 days", "12.5 h").
- **Chargeable days** of a request are its days that count under the type's `countDays`: for `workDays`, the days the employee's schedule in effect lists as work days, less confirmed nationwide holidays (a special working day counts); for `calendarDays`, every day. Days before the date hired or after the separation date never count.
- **Halves of a day** (half-day leave): the first half runs from the scheduled start to the break, the second from the end of the break to the scheduled end. With no break, the span splits at its midpoint, rounded down to the minute (*Assumption*). A half day is one half day of the balance whatever its minutes.

**Leave entries** (the new insert-only collection `leaveEntries`, for `credited` types only). The balance of a type is the sum of the employee's entries for it, never stored or edited ([Leave](#leave)):

| Kind (`LEAVE_ENTRY_KINDS`) | Written by | Half days |
|---|---|---|
| `opening` | HR, once per employee per type, dated the go-live date | 0 or more |
| `credit` | The credit job: the prorated credit at regularization, then the annual credit; one per employee, type and year | Above 0 |
| `carryOver` | The credit job on the credit date, before that year's credit: minus whatever the balance exceeds the cap by (0 with no cap); one per employee, type and year | 0 or less |
| `usage` | Approving a request (minus its paid half days); cancelling an approved one (plus them back) | Signed |
| `adjustment` | The holidays-changed listener, or HR with a reason | Signed |

`perEvent` and `perYear` types have no entries: their limits are checked against the employee's approved and pending requests.

**Crediting** (the new job `talent.leaveCredits`, daily at 00:30 Asia/Manila, cron `30 0 * * *`; [Background jobs](../ARCHITECTURE.md#background-jobs)). For every active employee who is **Regular** with a regularization date on or before today, and every active `credited` type:

- **At regularization**, a `credit` for the regularization year, dated the regularization date. With `prorateFromRegularization` it is `days × months ÷ 12`, where the months run from the regularization month to December, counting the regularization month only when the date is on or before the 15th, rounded to the nearest half day, halves up (*Assumption*). Regularized on April 10: 9 months, 3.75 → **4.0** days; on April 20: 8 months, 3.33 → **3.5** days. Regularized on January 1, it is the full credit.
- **Every year on `annualCreditOn`**, first the `carryOver` for the balance at the end of the day before, then a `credit` of `days`, both dated that day.
- **Only the current year.** The job writes the current year's entries, so a missed day catches up, but it never back-fills earlier years. It writes nothing dated before `goLiveDate`, and nothing while `goLiveDate` is null: the opening entry carries everything before go-live. A unique index on `{ employeeId, typeKey, kind, year }` for `credit` and `carryOver` makes every run idempotent (*Assumption*).
- **Probationary and Contractual employees** get no VL or SL credits: credits start at regularization ([Leave](#leave); *Assumption* for Contractual, see [Leave and time off](../COMPLIANCE.md#leave-and-time-off-build-step-28)). A Regular employee whose regularization date is missing gets none either, and the inspector's Time off section flags "Regularization date missing: no VL or SL credits".
- **Audit:** `create` on `talent.leaveEntry`, labelled `<employee number> · <short name> · <YYYY-MM-DD>`, with no actor (a system action). No notification (*Assumption*).
- `pnpm dev:leave-credits [--date YYYY-MM-DD]` runs the job once in development, like `pnpm dev:timesheet-reminders`; it refuses in production.

Step 2.13's regularization evaluation sets the regularization date and the Regular status; this job then credits on its next run.

**Time off requests** (the new collection `timeOffRequests`; base fields, never deleted). One request is either **leave** or **offset time off** (`TIME_OFF_KINDS`), filed on one request sheet:

- **Number:** `LV-YYYY-NNNN` for leave and `OFS-YYYY-NNNN` for offset time off, from Core's document number counters at filing (*Assumption*: the prefixes; the Approvals audit label already reads "Leave · LV-…").
- **Days:** `startDate` and `endDate` (Manila days, at most 366 days apart), and a `portion` (`TIME_OFF_PORTIONS`): `whole` for every request over more than one day; on a single day also `firstHalf` or `secondHalf` (leave types with half days) or `part` (offset time off: `fromTime` and `toTime`, `HH:MM`, inside the scheduled span).
- **Leave:** `leaveTypeKey`; `chargeableHalfDays`; for `credited` types `paidHalfDays` and `unpaidHalfDays` (a preview while pending, fixed at approval, changed only by the listener and cancelling).
- **Offset time off:** `minutes`, the scheduled minutes covered (for whole days, each chargeable day's scheduled minutes less the break).
- `reason` (up to 500 characters, optional), `attachmentFileId` (or null).
- **Status** (`TIME_OFF_STATUSES`): `pending`, `returned`, `approved`, `rejected`, `cancelled`; `approved` can still become `cancelled` (below), and `rejected` and `cancelled` are final. Also `approvalRequestId` (the current request), `submittedAt`, `decidedAt`, `decidedBy`, `remarks`, `cancelledAt`, `cancelledBy`, `cancelReason`, and `version`.

**Filing a leave request** (self-service: the employee's own, no employee id taken from the request). The service checks, in one transaction serialized per employee so two overlapping requests can't both be saved:

- the onboarding gate `fileTimeRequest` passes (`assertOnboardingGate`), the account is active, and the type is active
- **eligibility**: the employment status today is in the type's list ("Probationary employees can't use VL or SL. Any absence during probation is unpaid."), the record's sex matches when the type names one (an empty sex is refused with a link to My record), the service months are met, and `maxRequests` isn't reached
- **filing window**, in Manila days from today: with `minNoticeDays`, `startDate − today ≥ minNoticeDays` ("Vacation leave must be filed at least 14 days before the first day, so by Oct 15 for Oct 29."); without `allowFuture`, no day after today ("Sick leave is filed on or after the sick day."); without `allowPast`, no day before today; a past day only while the timesheet deadline of the cut-off holding `startDate` hasn't passed ("The timesheet deadline for that cut-off has passed. Ask HR."). The window is checked again on each resend (*Assumption*)
- **at least one chargeable day** ("These days are all rest days or holidays."), and within the type's limit for `perEvent` and `perYear` types (refused, never unpaid: "Maternity leave covers up to 105 days per request.")
- **no overlap** with the employee's pending or approved time off on the same day and half (a half-day request may sit beside another on the other half), and no `whole` or half day of leave on a day the employee has worked time entries in that portion ("You worked on Oct 5. Leave can't cover a day with time entries."; *Assumption*)
- **the attachment** when the type requires one: an image (re-encoded, as step 2.2 does) or a PDF, under the upload settings

**Insufficient balance** (`credited` types). The **available** balance is the balance less the paid half days of the employee's other pending requests of that type, and never counts a credit dated after today (*Assumption*). The request's chargeable half days are paid up to the available balance, from its first day; the rest are **leave without pay**, from its last day backwards (*Assumption*). Before submitting, the sheet shows "3 days: 2 covered by your VL balance, **1 day without pay** (deducted from pay)". At approval the split is worked out again against the balance then, and the approval notification states it.

**Filing offset time off** (self-service, the same gate, active account, overlap and transaction rules):

- `whole` days over a range, or a `part` of one day from `fromTime` to `toTime`, the minutes covered at least `minimumMinutes` and a multiple of `stepMinutes`. Only scheduled minutes count, so the break and time outside the schedule cover nothing.
- It must **start after the moment of filing**: whole days from tomorrow, a part of today only when `fromTime` is later than now. Offset never covers an absence, a late or undertime already incurred ([Offset balance & offset time off](#offset-balance--offset-time-off); *Assumption*).
- The minutes may not exceed the **available** offset balance: the balance less the employee's other pending offset time off. A balance at or below zero (after a step 2.7 adjustment) allows none.
- Anyone with an available balance may file, including an employee who moved to an Overtime timesheet ([Offset balance & offset time off](#offset-balance--offset-time-off)).

**Approval** (two approval types, `talent.leave`, labelled "Leave", and `talent.offsetTimeOff`, labelled "Offset time off", registered by `registerTalentApprovalTypes()`; the steps are passed at submit):

- **One step**, `reportingTo`, labelled "Supervisor": any one active supervisor decides. When it is empty it goes to HR (`whenEmpty: 'hr'`, any one other active HR user). For an **HR requester** (in the HR department at submit) it goes to the System Administrator instead (`whenEmpty: 'systemAdministrator'`), as decision 2 says ([Reporting lines](core.md#reporting-lines); *Assumption*: this differs from timesheets, where step 2.7 sends HR's own timesheet to the other HR users).
- **Confidential types** (VAWC) skip the supervisors: one `anyOf` step `{ set: 'hr' }` labelled "HR", or for an HR requester a step with no approvers and `whenEmpty: 'systemAdministrator'` (*Assumption*).
- **Decisions:** approve, return and reject ([Notifications](#notifications) lists "approved or rejected"). A return or rejection needs remarks.
- **Title** "Leave: <first last> · VL · Nov 2 – 4, 2026 (3 days)" or "Offset time off: <first last> · Nov 2, 1:00 – 5:00 PM (4.0 h)"; a confidential type reads "Leave (confidential)". **Summary:** the chargeable days or hours, the paid and unpaid split, and "Medical certificate attached" (never the file). **Link** `/talent/time-off-requests/<id>`; **record** `talent.timeOffRequest`, its number.
- **`onSettled`**, in the decision's transaction:
  - **approve:** re-check the request (an overlapping approval, and for offset the available balance: if the balance no longer covers it, the hook refuses with "The offset balance no longer covers this request. Return or reject it." and the decision rolls back), fix the split, write the `usage` entry (`leaveEntries` for a `credited` type, minus the paid half days; `offsetEntries`, minus the minutes, with `sourceType` `talent.timeOffRequest` and `sourceId`), set `approved`, and audit
  - **return** or **reject:** set the status with the remarks, and audit
- **Edit and send again.** A returned request is edited and sent again as a new approval request with `previousRequestId`, or cancelled, as step 2.6's change requests are. A pending request can't be withdrawn: the engine has none, so the employee asks the approver to return or reject it (*Assumption*).
- **Cancelling an approved request** (the employee's own, before its first day): `cancelled`, with a `usage` entry giving the paid half days or minutes back, an `update` audit entry, and `talent.timeOffCancelled` to the request's approvers. From the first day on it can't be cancelled (*Assumption*).
- **Notifications** are the engine's (waiting for the supervisor or HR, approved, returned, rejected) plus `talent.timeOffCancelled`. HR filing on someone's behalf is not built (*Assumption*).
- **Audit:** `create` on `talent.timeOffRequest` at filing (labelled with its number), `update` at each decision, resend and cancel; each entry it writes is audited as its own `create`.

**On the DTR** ([Daily Time Record (DTR)](#daily-time-record-dtr)). `getDtr` passes every **approved** request covering the range to `computeDtr` as `timeOff`, extending step 2.7's input (`DtrTimeOffInput`): the date, the status (`onLeavePaid`, `offsetPaid` or `leaveWithoutPay`), the portion, the covered scheduled intervals, the kind, the type's short name (or "Leave" for a confidential type to anyone but the employee, HR and the System Administrator) and the request id.

- **Holidays and rest days still come first** (decision 289): a holiday or rest day inside a request keeps its status and is never charged. For `calendarDays` types they are counted in the request but still shown as Holiday or Rest day.
- **A day the time off covers in full** takes the time off's status (on a day partly paid and partly unpaid, `onLeavePaid` when any of it is paid). Its late and undertime are 0.
- **A day covered in part** (a half day, or offset for part of the day) takes `present` when anything was worked and the time off's status when nothing was. Late and undertime count only against the scheduled intervals the time off doesn't cover: late from the start of the first uncovered interval, past the grace period; undertime for uncovered scheduled minutes after the first time in. Uncovered scheduled minutes on a day with nothing worked are the day's new **`absentMinutes`** (*Assumption*). This refines item 138's "time off takes a day's status even when it was worked" for partial days.
- **New day fields:** `timeOff` (the parts above, with their paid or unpaid status and covered minutes), `absentMinutes`, and `leaveWithoutPayDays` (0, 0.5 or 1). **New totals:** `paidLeaveDays`, `leaveWithoutPayDays`, `offsetMinutesUsed`, `absentMinutes`. Step 2.9 deducts `absentUnpaid` days and `leaveWithoutPayDays` at the daily rate, and late, undertime and `absentMinutes` at the hourly rate.
- A pending request doesn't change the DTR; the own time off page shows it.

**The holidays-changed listener** (`talent.recomputeDtr`, extended). After step 2.7's offset credits, it reconciles every **approved** request covering a changed date, each in its own transaction, idempotently:

- recompute the chargeable half days or minutes; when they **fall** (a holiday was confirmed inside the request), give back the difference as an `adjustment` (leave, taken from the unpaid days first) or a `usage` entry (offset), lower the stored split, and notify the employee (`talent.leaveAdjusted`, or step 2.7's `talent.offsetAdjusted`)
- when they **rise** (a holiday was deleted), leave: charge the new days from the available balance and make the rest unpaid; offset: charge them, even below zero, as step 2.7 allows (*Assumption*)
- audited as `create` and `update` with no actor; a finalized payroll period's pay difference is step 2.9's adjustment

**Opening balances** (the new page `/talent/opening-balances`, Talent Write **and** HR or the System Administrator; [Opening balances at go-live](#opening-balances-at-go-live)). It lists every employee hired before `goLiveDate` with a row each: VL, SL, offset, and "Year-to-date pay: Entered" or "Not entered" (never an amount), with "Enter" opening a sheet. Nobody enters their own.

- **VL and SL:** one `opening` entry per employee per `credited` type, in half days from 0 to 365 days, dated `goLiveDate`. **Offset:** one `opening` entry in `offsetEntries`, typed in hours with up to two decimals and stored in whole minutes (rounded half up), 0 or more. A second opening for the same type is refused.
- **Corrections** are `adjustment` entries with a required reason (up to 300 characters), entered by the same people on the same page or the inspector's Time off section, for leave and for offset. They are never written on one's own record (*Assumption*: this adds the manual correction step 2.7 left out).
- **Year-to-date pay** (the new insert-only collection `payrollOpeningEntries`): for the year of `goLiveDate`, as of that date, `grossCentavos`, `basicSalaryEarnedCentavos`, `taxableCompensationCentavos`, `taxWithheldCentavos`, `sssEmployeeCentavos`, `philhealthEmployeeCentavos` and `pagibigEmployeeCentavos`, each a whole number of centavos, 0 or more, each a `sensitiveField()` (category `salary`). A correction is a new entry with `supersedesId` and a required reason; the latest wins. Who enters it follows the salary rule (Talent Write and HR or the System Administrator; for an employee in the HR department, Talent Write and the System Administrator or a Board member, never HR), and it shows masked to whoever may reveal `salary` ([Sensitive data](../../SECURITY.md#sensitive-data)). Steps 2.10 and 2.12 read it for payslip year-to-date figures, 13th month pay and BIR Form 2316 (*Assumption*: these seven figures are enough; see [Leave and time off](../COMPLIANCE.md#leave-and-time-off-build-step-28)).
- **Audit:** `create` on `talent.leaveEntry`, `talent.offsetEntry` and `talent.payrollOpeningEntry` (labelled `<employee number> · <year>`), never with an amount in the label.

**Who may see what.**

- **Requests and balances** aren't sensitive. The employee sees their own; the `reportingTo` supervisors, Talent Read, and anyone who is or was an approver on the request (`isApproverFor`) see them read-only, whatever their module access, as for timesheets ([Exceptions to module access](../../SECURITY.md#exceptions-to-module-access)). A confidential type shows as "Leave" with no type, attachment or reason to anyone but the employee, HR and the System Administrator.
- **Attachments** (medical certificates and the other supporting files) are treated as **medical** (*Assumption*): they open through the file route (owner type `talent.timeOffRequest`) only for the employee, HR and the System Administrator with Talent Read, and the request's approvers, never Accounting, and every open is audit-logged as a `reveal` (`auditView`), as 201 documents are. They aren't copied into the 201 file (*Assumption*).

**Screens** (phone first; see [Time off on a phone](../DESIGN_SYSTEM.md#layout--components)).

- **`/talent/time-off`**, the employee's own, "Time off" in the Pulse Core group after Timesheet (for users with an employee only), breadcrumb "Pulse Core › Time off": balance cards (VL, SL and offset, each with "Available" when a pending request holds some), the `perYear` types used this year, then the requests, newest first, each with its number, days, a status badge and, for leave without pay, "1 day without pay". "File time off" opens the request sheet. A cancellable approved request has "Cancel request"; a returned one "Edit and send again" and "Cancel".
- **The request sheet** (full height on a phone): a segmented control "Leave | Offset", then the type (leave), the first and last day (native date inputs, with the filing window under them, such as "File VL by Oct 15 for Oct 29"), the half or part of the day when allowed, the attachment ("Take a photo or choose a file"), the reason, and the summary before Submit: chargeable days or hours, rest days and holidays left out, and the paid and unpaid split. Refusals show next to the field with the server's words. The gate's notice shows when `reportingTo` isn't set.
- **`/talent/time-off/<employeeId>`**, read-only, for the supervisors, approvers and Talent Read (breadcrumb "Pulse Talent › Time off"), reached from My team and the inspector's Time off section.
- **`/talent/time-off-requests/<id>`**, a request: its days, split, attachment ("Open attachment"), reason, status and approval history, and "Waiting for your approval · Open in Approvals" for an approver. Approvals links here.
- **The DTR segment** shows time off as text badges: "On leave (paid) · VL", "Half day VL (paid)", "Offset (paid) 4.0 h", "Leave without pay", with the absent minutes of a partly covered day.
- **The employee inspector's Time off section** (Talent Read): balances, the latest requests, the regularization flag, and for HR and the System Administrator with Talent Write "Enter opening balances" and "Add correction". **Year-to-date pay at go-live** sits in the Compensation section, shown only to viewers who may see it.
- **Payroll settings › Leave**: the go-live date, the offset minimum and step, and the leave types as a grouped list (a list on a phone), with "Add version".
- **My team** links to each person's time off.

**Cross-module and services.** `getLeaveBalances(actor, employeeId)` and `getOffsetBalance` (now also returning the available balance) serve steps 2.9, 2.13 and 2.16. `getDtr` includes approved time off. Pulse Ops' read of approved time off for scheduling (Phase 4) is added in its own step. No Core change: the approvals engine, `isApproverFor`, `nextDocumentNumber`, the file route registrations, `registerSensitiveReveal`, `notify` and the holidays-changed listeners already exist.

**Hand-checked cases.** With the seeded schedule (Monday to Friday, 08:00–17:00, break 12:00–13:00, grace 15 minutes), the seeded leave types, "today" Monday 2026-10-19, and 2026-11-30 a confirmed regular holiday:

| # | Case | Expected |
|---|---|---|
| L1 | VL filed for Thu 2026-10-29 (10 days ahead) | Refused: at least 14 days before, so by Oct 15 (the **Done when**) |
| L2 | VL filed for Mon 2026-11-02 (14 days ahead), one whole day, balance 5.0 | Accepted: 1 day, paid; after approval the balance is 4.0 |
| L3 | VL Fri 2026-11-06 – Tue 2026-11-10 | 3 chargeable days (Saturday and Sunday left out) |
| L4 | VL Mon 2026-11-30 – Tue 2026-12-01 | 1 chargeable day; the DTR shows Nov 30 as Holiday |
| L5 | VL for 3 days with a balance of 2.0 | Preview: 2 paid, 1 without pay (the last day); the DTR shows the last day as Leave without pay, `leaveWithoutPayDays` 1 |
| L6 | Half-day VL, first half, worked 13:00–17:00 | Present; half day VL (paid); late 0; undertime 0; balance −0.5 |
| L7 | Half-day VL, first half, first time in 13:20 | Present; late 20 min (counted from 13:00, past the grace period) |
| L8 | Half-day VL, second half, nothing worked | On leave (paid); `absentMinutes` 240 |
| L9 | VL or SL filed by a Probationary employee | Refused, with "Probationary employees can't use VL or SL…" |
| L10 | SL for tomorrow; SL for last Friday without a certificate; with one | Refused; refused; accepted (until the deadline of that cut-off) |
| L11 | Regularized 2026-04-10; another 2026-04-20 (job run that day) | Credits of 4.0 and 3.5 days |
| L12 | VL balance 3.5 at the end of 2026, credit on 2027-01-01, cap none; cap 2 | 8.5 days (carry-over 0); 7.0 days (carry-over −1.5) |
| L13 | Maternity from 2026-11-02 for 105 calendar days | Ends 2027-02-14; every day on leave (paid) except rest days and holidays shown as such; a 106-day request is refused |
| O1 | Offset balance 275 min (D13); offset time off Mon 2026-11-02 13:00–17:00, worked 08:00–12:00 | 240 min; Present with "Offset (paid) 4.0 h"; undertime 0; balance 35 min |
| O2 | Offset time off for a whole day with an available balance of 35 min | Refused: more than the balance |
| O3 | Offset time off 13:00–13:45; 13:00–13:30 | Refused (not a 30-minute step); refused (below 60 min) |
| O4 | Offset time off for today from 08:00, filed at 10:00 | Refused: it must start after filing |
| O5 | Offset time off for a whole day with a balance of 600 min, approved by the supervisor on a phone | The DTR shows Offset (paid) and the balance falls by 480 min to 120 (the **Done when**) |
| H1 | An approved VL Mon 2026-11-30 – Tue 2026-12-01 filed while Nov 30 was a draft (2 days charged); the holiday is confirmed | An `adjustment` of +2 half days (the balance rises 1.0) and `talent.leaveAdjusted`; deleting the holiday again charges 1 day from the available balance |

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
- **Supervisors:** timesheets, leave and offset time off requests waiting for their approval; their team's certifications expiring (from step 2.2, see [Skills & certifications](#skills--certifications)); their team's change requests to contact details and skills waiting for their approval (from step 2.6, through the approvals engine).
- **From step 2.6** ([Onboarding checklist and change requests](#onboarding-checklist-and-change-requests-build-step-26)): the employee hears the outcome of each change request (approved, returned or rejected); HR hears of change requests waiting for HR, government IDs or a bank account to verify (`talent.verificationNeeded`; for an HR employee, the Board members and the System Administrators instead) and 201 documents an employee uploaded (`talent.documentUploaded`); Board members hear of an HR employee's ID and bank change requests.
- **From step 2.8** ([Leave, offset time off and opening balances](#leave-offset-time-off-and-opening-balances-build-step-28)): leave and offset time off go through the approvals engine (`talent.leave`, `talent.offsetTimeOff`: waiting for the supervisor, or HR for an empty `reportingTo`; approved, returned or rejected to the employee). New: `talent.timeOffCancelled` to the approvers when an approved request is cancelled, and `talent.leaveAdjusted` to the employee when a holiday change alters an approved leave's charge (offset time off reuses `talent.offsetAdjusted`).
- **From step 2.7** ([Timesheet approval, the DTR and the offset balance](#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27)): the employee gets `talent.timesheetDue` (ready to submit, due today, overdue) and `talent.offsetAdjusted` (a holiday change altered an approved timesheet's offset); HR gets `talent.timesheetsMissing` the day after the deadline; the approval events (waiting for the supervisor or HR, returned, approved) are the approvals engine's.
- **HR:** new users needing module access, company details still missing, timesheets waiting for HR approval, leave and offset time off requests waiting for HR approval (requesters with an empty `reportingTo`), missing timesheets at the deadline, payroll run or final pay approved or returned, remittance due dates, probation, contract and document alerts, minimum wage flags, due-process deadlines.
- **Board of Directors:** payroll runs and final pay waiting for approval.
