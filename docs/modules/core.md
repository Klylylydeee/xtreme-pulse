# Pulse Core (Platform)

Pulse Core is the platform every module builds on. It covers sign-in, user accounts, system administration, the company directory and org chart, the holiday calendar, shared master data, approvals, notifications, the audit log and company settings.

Built in [Phase 1](../BUILD_PLAN.md#phase-1-pulse-core). Routes: the login page, Home (`/`) and administration (`/admin`). Package: `packages/core`.

Sign-in, passwords, account status, module access and the System Administrator role are security rules, so they live in [SECURITY.md](../../SECURITY.md).

## People data ownership

Every user is an employee of Xtreme Works (the only exception is the bootstrap system account). Pulse Core owns the user account and org structure (login, account status, module access, department, position, reporting lines, directory, org chart), and the employee identity fields account status depends on: employee number, name, date hired, employment status and separation date (`employees.separationDate`, see [Managing user accounts](#managing-user-accounts)). Pulse Talent owns employment, government, payroll, timesheet and document details, and shows Core's identity fields in its employee record. Both reference the same `employeeId`.

## Bootstrap System Administrator account

- A fresh install has no users, so a seed script creates the first System Administrator: `pnpm seed:admin` (`scripts/seed-admin.ts`).
- Default login email: **`sysadmin@xtreme-works.com`**.
- The script reads the email and initial password from environment variables `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. **Never commit the password** to the repo, these docs, seed files or logs.
- The account must change its password on first sign-in.
- It is a **system account**, not an employee: no employee number or employment status, always active unless another System Administrator disables it, and excluded from the directory, org chart, onboarding, timesheets, payroll and reporting lines.
- The script is idempotent in two parts. If a System Administrator already exists, it skips creating one. Base data loaders insert only what is missing and never overwrite existing records, so base data for modules built later can be added to an existing database (for example during a staged go-live).
- A loader may fill a field that is absent on an existing record; it never changes an existing value.
- Seeded positions carry a stable seed key, so renaming a seeded position doesn't make the seed add it again.
- Seed writes are system writes (`createdBy` is null) and are not audit-logged. They are not backfilled when the [audit log](#audit-log) arrives in build step 1.3.
- The seed only loads the allowed email domains. The allowed-domain check runs in services (bootstrap, sign-in and user creation) against the stored `allowedEmailDomains` records, not in the users schema.
- The same seed run loads base data: allowed email domains, departments and positions (see [Departments and positions](#departments-and-positions)), leave types, payroll settings (cut-offs, daily rate factor), contribution tables, holiday premium rates, regional minimum wage rates (NCR), the default work schedule, the internet allowance, HR document templates, and company settings placeholders.

## Administration area

Built in step 1.6. The `/admin` pages are checked by role, not module access ([Rules](../../SECURITY.md#rules)), and appear in the sidebar's **Administration** group:

| Entry | Route | Who |
|---|---|---|
| Overview | `/admin` | HR and the System Administrator |
| Users | `/admin/users` | HR and the System Administrator |
| Departments | `/admin/departments` | HR and the System Administrator |
| Positions | `/admin/positions` | HR and the System Administrator |
| Company settings | `/admin/settings` | The System Administrator |
| Audit log | `/admin/audit` | The System Administrator |

- Anyone else doesn't see the group (an empty sidebar group is hidden), and gets the [no-access state](../DESIGN_SYSTEM.md#feedback--motion) (HTTP 403) on every `/admin` page, `/admin` itself included. HR gets it on `/admin/settings` and `/admin/audit`.
- Breadcrumbs read "Administration › Users" and so on, from the longest matching entry. The command bar's navigation items follow the filtered sidebar.
- `/admin/access` and its badge join the group in step 1.7 ([User access page](#user-access-page)).

## Departments and positions

| Department | Code | Positions |
|---|---|---|
| Human Resource | `HR` | Human Resource Officer |
| Accounting | `ACCT` | Accounting Officer, Accounts Payable Officer, Accounts Receivable Officer |
| Office Administrator | `ADMIN` | Administrative Specialist, Driver |
| Network | `NET` | Lead Presales Engineer, Lead Postsales Engineer, Presales Support Engineer |
| Point of Sales | `POS` | Lead Business Technology Support, Technology Support |
| Sales | `SALES` | Sales, Marketing, Account Manager, Channel Account Manager, Business Development Manager |
| Data Center | `DC` | Head Data Center, Mechanical Engineer, Lead HVAC Technician, HVAC Technician |
| Board of Directors | `BOD` | Managing Director, Sales Director, Operations Director, Strategic Director |
| Web Administrator | `WEB` | Developer |

- Departments and positions are stored as data (admin-managed), not hardcoded enums, so new ones can be added without a code change.
- Each department has an optional **department head** (an employee, set by HR or the System Administrator), used for escalations such as Desk SLA breaches. If none is set, or the head's account is deactivated, escalations go to the Operations Director.
- **Position is not permission.** Positions carry no module access; access is set and checked per user (see [Module access](../../SECURITY.md#module-access-rwo)).
- Each position also has a **timesheet type** (`overtime` or `standard`, see [Timesheet types](talent.md#timesheet-types)), set by HR or the System Administrator.

### Managing departments and positions

Built in step 1.4.

- **Routes:** `/admin/departments` and `/admin/positions`, for HR and the System Administrator, in the sidebar's Administration group ([Administration area](#administration-area)). Anyone else gets the no-access state (HTTP 403). Each service checks the role again itself.
- **Departments** have a name, a code and an optional department head. The code (2 to 10 capital letters or digits, starting with a letter) is set when the department is added and can't be changed afterwards; only the name and the head can be edited. Codes are never reused: the unique index includes retired departments.
- **Department head:** any employee whose account resolves to active, from any department. It is optional and can be cleared. A head who later separates stays set (from build step 1.5): the departments list marks them with an "Inactive" badge, and escalations treat an inactive head as no head (Phase 6).
- **Positions** have a name, a department and a timesheet type. A position is added only to a live (not retired) department. Its department is fixed once created; to move a position, add a new one in the other department. Only the name and the timesheet type can be edited. Position names are unique within a department ignoring case (`Driver` and `driver` count as the same name), retired positions included.
- **Changing the timesheet type** saves at once and takes effect from the next cut-off, never in the middle of one: each timesheet stores the type that applied when its cut-off started (see [Timesheet types](talent.md#timesheet-types)).
- **Retiring** is a soft delete (`deletedAt` set), never a hard delete, after a confirmation. A department can't be retired while it has live positions or active employees. A position can't be retired while active employees hold it. Adding or restoring a position, and from step 1.5 assigning an active employee ([Managing user accounts](#managing-user-accounts)), writes the department (and position) record in its transaction, so it conflicts with an overlapping retire.
- **No protected departments.** `HR`, `ACCT` and `BOD` can be retired like any other department, under the same rules. The HR, Accounting and Board [roles](../../SECURITY.md#roles) follow those codes, so a department a role depends on can't be retired while anyone is still in it.
- **Restoring** a retired department or position brings it back unchanged. Retired departments and positions can't be picked for new records.
- **Audit:** every add, edit, retire and restore writes its change and its audit entry in one transaction (record types `core.department` and `core.position`; actions `create`, `update`, `delete` for a retire, with `after` null, and `restore`). Each entry's record label is `<department code> · <department name>` for a department (for example `HR · Human Resource`) and `<department code> · <position name>` for a position (for example `HR · Human Resource Officer`), using the name after the change (before it, for a retire). A position whose department can't be found is labelled with its name alone.

## Reporting lines

- `reportingTo` is an **array** of employee IDs: an employee can have one or multiple supervisors.
- An employee cannot report to themselves, and reporting chains must never form a cycle (validate on save).
- Anyone may have an empty `reportingTo`, such as top-level Board of Directors members. Their leave and offset time off go to HR, and the supervisor step of quotations and purchase requests is skipped (see each module's spec). When a non-Board employee is saved with no supervisor, the form hints "No supervisor: leave and offset time off go to HR."
- Only **HR, Board of Directors members and the System Administrator** can set or change `reportingTo`. Employees and supervisors cannot. In build step 1.5 HR and the System Administrator edit it on `/admin/users` ([Managing user accounts](#managing-user-accounts)); the Board's editor arrives with the org chart in build step 1.11.
- **Checked on save** (build step 1.5): at most 10 supervisors, no one listed twice, and each supervisor must exist, be an employee (not the bootstrap system account) and be active when saved. The cycle check walks the upward chain inside the transaction. It writes every supervisor record it reads, and the employee's own, so two edits that would together form a cycle conflict and the retried one is refused. An edit that only removes or reorders supervisors isn't checked again (it can't add a cycle or anyone inactive), so a line to someone who later separated can stay.
- Existing lines to someone who later separates stay as they are; the approvals engine (build step 1.9) and the org chart (build step 1.11) handle them.
- Approval workflows (leave, offset time off, timesheets, purchase requests, quotes, employee record changes, regularization) route through `reportingTo`.
- **Any one supervisor can decide.** When an employee has multiple supervisors, the request goes to all of them, and the first approval or rejection settles it. The other supervisors are notified of the outcome and can no longer act on it.
- No one approves their own request. When the only approver in a step is the requester (e.g. the HR Officer's own timesheet at the HR step), the step goes to the System Administrator.

## Employee number (company ID)

- Format **`YYYY-NN`**: hire year + sequence within that year. Example: the first employee hired in 2027 is `2027-01`, the second is `2027-02`.
- The year comes from the date hired (its year in Manila). The sequence restarts at 01 each year, is always 2 digits, and has a **maximum of 99 per year**. Once the counter reaches 99, generating another number for that year fails with "Employee numbers for 2027 have run out: 2027-99 has been issued. Enter the person's existing company ID if they have one." (with that year), and nothing is written.
- **Generate:** atomically, with a per-year counter (`findOneAndUpdate` with `$inc` and `upsert`) inside the create transaction, so two hires can never get the same number and an aborted create leaves no gap. Generation always takes the next number after the counter; it never fills gaps.
- **Enter existing:** when HR adds a current employee who already has a company ID, HR enters it. It must match `YYYY-NN`, its year must equal the Manila year of the date hired, and it must be unused; otherwise it is a field error. That year's counter is raised to at least that sequence (`$max`), so it is never issued again. A lower number that is still free is accepted and never lowers the counter.
- Assigned once, immutable, never reused, even after separation: employees are never deleted, and a failed create rolls back with its number. Counter writes aren't audit-logged; the employee's create entry carries the number.

## Managing user accounts

Built in step 1.5. Passwords, account status and the System Administrator's rules are in [SECURITY.md](../../SECURITY.md#account--access); this section covers the screen and the fields Core owns. Phase 2 adds the full employee record in Pulse Talent.

- **Route:** `/admin/users`, for HR and the System Administrator, in the sidebar's Administration group ([Administration area](#administration-area)). Anyone else gets the no-access state (HTTP 403). Each service checks the role again itself.
- **List:** employee number, name, email, department, position and employment status, with a "Temporary password" badge while the user still has to change a temporary password. Search by name, employee number or email, and filter by department. Separated users (Resigned, Terminated, Retired) are hidden unless "Show separated" is on (`?separated=1`). Sorted by last name, with no paging.
- **Creating a user** opens a sheet with:
  - Login email, lowercased and checked against the stored allowed email domains (a removed domain is refused). An email already in use is a field error.
  - First name, middle name (optional) and last name.
  - Employee number: Generate, or Enter existing (see [Employee number](#employee-number-company-id)).
  - Date hired, from 1990-01-01 to a year ahead (today + 365 days in Manila). The account is active from creation, whatever the date hired.
  - Department and position, both live, the position in that department.
  - Employment status: Probationary, Regular or Contractual.
  - `reportingTo` (see [Reporting lines](#reporting-lines)).
- **New users** are never System Administrators and start with no module access ([System Administrator](../../SECURITY.md#system-administrator), [Module access](../../SECURITY.md#rules)).
- **Editing:** name, email, department, position, `reportingTo`, employment status and separation date. The email follows the same checks as on create; changing it doesn't end the user's sessions. The employee number is fixed. The date hired can change only within the employee number's year. Moving an employee into or out of HR, Accounting or the Board changes their role from their next request ([Roles](../../SECURITY.md#roles)); HR can move someone into or out of HR this way, and the change is audit-logged. When HR edits a System Administrator, the email on the form is ignored and the stored one kept.
- **Read-only:** the editor's own row; they change their own password on `/change-password`. When HR opens a System Administrator, the email and employment status are read-only and there is no Reset password ([System Administrator](../../SECURITY.md#system-administrator)).
- **Employment status and separation date** follow [Account status](../../SECURITY.md#account-status): Terminated shows disabled with its hint. The separation date is required for a separated status (Resigned, Terminated, Retired), null otherwise.
- **Live department and position.** Creating a user, changing an employee's department or position, and moving a separated employee back to an active status write the department and position records inside the transaction (`claimLiveDepartment`, `claimLivePosition`), so an overlapping retire conflicts and is retried. Nobody ends up active in a retired department or position (see [Managing departments and positions](#managing-departments-and-positions)).
- **Email domain claimed.** The email's allowed domain is checked before the transaction (a quick field error) and written again inside it (`claimEmailDomain`), so a create or email change that overlaps the domain's removal conflicts and is refused.
- **Known limit (step 1.5):** a future-dated hire can't be separated before their date hired (the separation date must be on or after the date hired and today or earlier), and employees can't be deleted. A hire who withdraws before starting stays active until their date hired, and can be separated from then. Date-aware statuses, possibly in Phase 2, address it.
- **The bootstrap system account** shows only to System Administrators, read-only, with Reset password ([System Administrator](../../SECURITY.md#system-administrator)).
- **Temporary password dialog.** After creating a user or resetting a password, a dialog shows the generated temporary password once, with Copy and "Hand it over privately". Closing it ends the only chance to see it; if it's lost, reset again ([Sign-in and passwords](../../SECURITY.md#sign-in-and-passwords)).
- **Audit:** record types `core.employee`, labelled `<employee number> · <first name> <last name>` (for example `2027-01 · Ana Cruz`), and `core.user`, labelled with the email. Creating a user writes the user, the employee and two `create` entries in one transaction. Edits are `update` entries with both sides snapshotted (`snapshotsForAudit`). A reset is a `passwordReset` entry on the `core.user` record, with no hash, showing `mustChangePassword` before and after. None of these fields is [sensitive personal data](../../SECURITY.md#sensitive-data). The temporary password appears only in the action's response to the person who did it, never in an entry.
- **No notifications** in step 1.5. Notifying HR and the System Administrator of new users arrives with the [User access page](#user-access-page) in step 1.7.

## User access page

The page where HR and the System Administrator set each user's module access.

- **Route:** `/admin/access`, in the Pulse Core administration area. It appears in the sidebar only for HR and the System Administrator, with a badge counting users who still need access.
- **List:** every active user with profile photo, name, employee number, department, position, and a compact access summary per module (e.g. `Talent R`, `Fiscal O`). Search by name; filter by department and position.
- **Needs access:** users with None on every module are pinned at the top under a "Needs access" heading, newest first.
- **Editing:** selecting a user opens a sheet with one row per module (Engage, Ops, Supply, Desk, Fiscal, Talent, Insight). Each row has a segmented control **None | Read | Write | Owner** with a one-line description of the selected level; Insight offers None | Read only. Save applies all changes at once. The sheet shows who last changed the user's access and when.
- **System Administrator role:** the sheet has a "System Administrator" switch above the module rows, visible and editable only to System Administrators. Turning it on sets Owner on every module (Read on Insight) and locks the rows; a confirmation is required, and the last remaining System Administrator can't be switched off.
- **Read-only rows:** a user's own access, and the System Administrator's access when viewed by HR, are shown but cannot be edited (see [Module access](../../SECURITY.md#module-access-rwo)).
- **After creating a user:** HR or the System Administrator goes straight to that user's access sheet, with the option to set access later.
- **From the employee record:** the user's record in Pulse Talent has a "Manage access" action that opens the same sheet (HR and System Administrator only).
- **Notifications:** HR and the System Administrator are notified when a new user is created, and reminded daily while any user still needs access.
- **New user's home** (build step 1.6): a user whose effective access is None on every module sees a card under the Home hero: an icon tile and "Your access is being set up. HR will give you access to the modules you need." It never shows to the System Administrator, but can show to HR or a Board member with nothing set. It replaces the "Nothing needs your attention" empty state while it shows; the company details reminder is unchanged ([Feedback & motion](../DESIGN_SYSTEM.md#feedback--motion)). Self-service stays available.
- **Board members:** Board of Directors members normally need Insight Read for the Board dashboards, targets and weekly summary. The sheet shows this as a hint for Board members; it never grants access automatically.
- Every change is audit-logged (see [Module access](../../SECURITY.md#module-access-rwo)).

## Company directory

- All active users can see each other's name, profile photo, employee number, department, position, login email and `reportingTo`.
- Everything else in the employee record stays private (the employee, HR, Accounting and the System Administrator, per the [Sensitive data](../../SECURITY.md#sensitive-data) rules).
- Deactivated employees are hidden from the directory by default; HR and the System Administrator can still view them.

## Org chart

- Built automatically from `reportingTo`, so it always reflects the current structure. There is no separate chart to maintain.
- Visible to **every active user**, so everyone can see how the company is organized.
- Each person shows directory-level information only: profile photo, name, position and department. Clicking opens their directory card.
- Employees with more than one supervisor appear once, with a line to each supervisor.
- Filter by department and search by name.
- Deactivated employees and the bootstrap system account are not shown.

## Holiday calendar

- Shared master data in Pulse Core, managed by HR (and the System Administrator). Used by timesheets, payroll, leave (holidays are not deducted from leave balances) and later by SLA timers in Pulse Desk.
- Each holiday: name, date, type (regular holiday, special non-working day, special working day), scope (nationwide or a specific city/municipality), legal basis (e.g. Proclamation No.), status (draft or confirmed).
- Only **confirmed** holidays affect attendance, leave and payroll. Drafts are shown to HR only.

### Keeping it updated
1. **Yearly auto-draft:** every October 1, a background job creates next year's holidays as drafts:
   - Fixed-date holidays (e.g. New Year's Day, Araw ng Kagitingan, Labor Day, Independence Day, Ninoy Aquino Day, All Saints' Day, Bonifacio Day, Christmas Day, Rizal Day)
   - National Heroes Day (last Monday of August)
   - Holy Week dates computed from Easter (Maundy Thursday, Good Friday, Black Saturday)
   - Keep this list as seed configuration, not code, since holidays are added or changed by law.
2. **Optional online source:** if the server has internet access, also pull a public Philippine holiday API or calendar feed and add anything missing as drafts (e.g. Chinese New Year). Never auto-confirm from an outside source.
3. **HR confirms against the official proclamation:** each year's holidays are declared by Presidential Proclamation, published in the Official Gazette, usually a few months before the year starts. HR checks the drafts against it, moves dates that were shifted, adds missing ones, deletes ones not declared, and confirms.
4. **Ad-hoc declarations:** Eid'l Fitr and Eid'l Adha are declared by separate proclamation close to the date, and special non-working days can be declared at any time (e.g. weather or national events). HR adds them when announced, and all users are notified.
5. **Reminders:** if next year has no confirmed holidays by December 1, alert HR weekly until it is done.
6. Adding or changing a holiday recomputes the DTR for payroll periods not yet finalized. Finalized periods get adjustments in the next payroll.

## Shared master data

Pulse Core owns these records. Other modules create and edit them only through Core's service functions (see [Architecture rules](../ARCHITECTURE.md#architecture-rules)). Each record's fields are specified where the record is mainly used:

| Record | Managed from | Fields specified in |
|---|---|---|
| Clients, with sites and contacts | Pulse Engage (basic screens in `/admin`) | [Clients, sites and contacts](engage.md#clients-sites-and-contacts) |
| Products (`brands` in code) | Engage settings | [Deals and stages](engage.md#deals-and-stages) |
| Catalog items | Pulse Supply | [Stock](supply.md#stock) (item kind) and [Warranties](desk.md#warranties-support-contracts-and-subscriptions) (default warranty months) |
| Suppliers | Pulse Supply | [Suppliers](supply.md#suppliers) |
| Departments and positions | `/admin` | [Departments and positions](#departments-and-positions) |
| Holidays | Holiday calendar | [Holiday calendar](#holiday-calendar) |

Catalog items carry their product, part number, description, unit, item kind (serialized, bulk, or non-stock for services and licenses) and default warranty months (build step 1.8).

## Approvals

The approvals engine (build step 1.9) supports three kinds of step:

- **Routed to `reportingTo`:** any one supervisor decides (see [Reporting lines](#reporting-lines)).
- **Any one of a set:** for example, any one Board of Directors member.
- **All of a set:** for example, both payment approvers.

A return always needs remarks. A step whose only approver is the requester goes to the System Administrator (see [Reporting lines](#reporting-lines)). Approvers can open what they're asked to approve read-only, even without module access (see [Exceptions to module access](../../SECURITY.md#exceptions-to-module-access)).

Every approval in the app, for reference. The linked section is the rule; this table is only an index.

| Request | Approved by | Rule |
|---|---|---|
| Timesheet | Any one supervisor, then HR | [Submission & approval](talent.md#submission--approval) |
| Leave, offset time off | Any one supervisor. HR if the requester has an empty `reportingTo`; the System Administrator for HR's own request | [Leave](talent.md#leave), [Offset time off](talent.md#offset-balance--offset-time-off) |
| Employee record change | HR or any one supervisor; sensitive fields HR or System Administrator only | [Self-service & record changes](talent.md#self-service--record-changes) |
| Regularization evaluation | Completed by a supervisor, reviewed by HR | [Probation & contract tracking](talent.md#probation--contract-tracking) |
| Payroll run, 13th month run | HR submits; any one Board member approves | [Payroll run & payslips](talent.md#payroll-run--payslips) |
| Final pay | Any one Board member | [Final pay](talent.md#separation-final-pay--certificate-of-employment) |
| Quotation | Any one supervisor of the deal owner (skipped for an empty `reportingTo`) | [Quotations](engage.md#quotations) |
| Purchase request | Any one supervisor of the requester (skipped for an empty `reportingTo`) | [Purchase requests](supply.md#purchase-requests) |
| Purchase order | Any one Board member | [Purchase orders](supply.md#purchase-orders) |
| Non-stock delivery confirmation | Project lead, or any one requester for a PO with no project | [Exceptions to module access](../../SECURITY.md#exceptions-to-module-access) |
| Payment, petty cash replenishment | Managing Director **and** Sales Director, in either order | [Payments](fiscal.md#payments-disbursements), [Petty cash](fiscal.md#petty-cash) |
| Manual journal entry | Posted by a Fiscal Owner | [Chart of accounts and ledger](fiscal.md#chart-of-accounts-and-ledger) |
| Chargeable work | A Desk Owner | [Chargeable work](desk.md#chargeable-work) |
| A module's other approvals | That module's Owner | [Module access](../../SECURITY.md#module-access-rwo) |

## Notifications

- All notifications are delivered in-app through Pulse Core (email later, once the email system ships). Each user has a notification list with an unread badge.
- Pulse Core's own events: HR and the System Administrator hear about new users, users still needing access (daily) and position changes to review ([User access page](#user-access-page)), and company details that are still placeholders ([Company details](#company-details-pending-from-the-client)). Every user is notified of ad-hoc holiday declarations, and HR gets the weekly reminder when next year's holidays aren't confirmed ([Holiday calendar](#holiday-calendar)).
- Each module lists its own events in its spec, for example [Pulse Talent notifications](talent.md#notifications).

Built in step 1.3:

- **Stored** in `notifications`, one record per recipient: the recipient, the module (`core` or a module key), the event (`<module>.<name>`, for example `core.holidayDeclared`), a title, an optional body, a link, the record it is about (optional) and `readAt` (null while unread). Titles are capped at 200 characters and bodies at 1,000, as plain text.
- **The link is always a path inside the app**: it starts with a single `/`, with no `//` or `\` anywhere and no spaces. A full URL or a `//host` link is refused, so a notification can never send someone off-site.
- **Sending.** Modules call Core's `notify()` service, never the collection, inside their own transaction when the event comes from a change (so the notification commits or rolls back with it). There is no duplicate check in `notify()` yet; build step 1.7 adds one for the daily reminders. The company details reminder (step 1.4) does its own check, skipping a recipient who already got it that Manila day ([Company settings page](#company-settings-page)).
- **Reading.** A user only ever sees and changes their own notifications: every query filters on the signed-in user. Marking one or all as read is the only change allowed; nothing else on a stored notification can be edited. Opening the list and marking read are not audit-logged.
- **The badge** shows the unread count. It refreshes on navigation, when the window regains focus and when the list opens; there is no polling.
- **Kept forever.** Notifications are never deleted and never expire (see [Retention](../DATA_MODEL.md#retention)).

## Audit log

The audit log is append-only. Each entry records the actor, module, record, action, old and new values, and a reason (build step 1.3). The System Administrator browses it from `/admin`. What must be logged is listed in [Audit logging](../../SECURITY.md#audit-logging).

Built in step 1.3, in the `auditLogs` collection:

| Field | What it holds |
|---|---|
| `actorId`, `actorEmail` | The user who did it (null for a system action), and their email at the time |
| `module` | `core` or a module key (`MODULES`) |
| `action` | One of a fixed list in code (`AUDIT_ACTIONS`): `create`, `update`, `delete`, `restore`, `reveal`, `export`, `passwordChange`, `passwordReset`, `accessChange`. Adding one is a spec change |
| `record` | The record's type (`<module>.<name>`, for example `core.user`), its id, and an optional label to show, such as an email or document number |
| `before`, `after` | Full snapshots of the record before and after the change, redacted (see below). `before` is null on create; `after` is null on delete. Both are null for a reveal or an export |
| `fields` | The fields revealed or exported (names only) |
| `reason` | Why, when the action asks for one (up to 1,000 characters), else null |
| `createdAt` | When |

- **Append-only.** Every field is fixed once written, and every update, replace and delete is refused, as is `$out` or `$merge` from an aggregation on it. Corrections are new entries. The limits are in [Audit logging](../../SECURITY.md#audit-logging).
- **Same transaction.** A service writes the entry with `recordAudit()` in the transaction of the change it records, so both commit or neither does. If the entry can't be written, the change fails.
- **Redacted snapshots.** Snapshots never hold a password, a hash or a sensitive value; the rules are in [Audit logging](../../SECURITY.md#audit-logging). Ids are stored as strings and dates as ISO 8601 strings. On an update, a sensitive field whose stored value changed is marked as changed in `after` (still hidden), so the entry shows that it changed.
- **Size cap.** A string longer than 2,000 characters is cut there and marked, an array keeps its first 100 items plus a marker with the number left out, nesting deeper than 20 levels is replaced by a marker, and a whole snapshot still larger than 64 KB once serialized is replaced by `{ "$truncated": "snapshot", "bytes": <size> }`. The entry is still written.
- **Not logged:** sign-ins, seed writes, viewing the audit log, and opening or marking notifications.
- **Browsing.** Newest first, filtered by Manila date range, actor, module, action, and record type and id. The page is for the System Administrator only; anyone else, HR included, gets the no-access state (HTTP 403, see [Administration area](#administration-area)).
- **Kept forever.** Entries are never deleted and never expire (see [Retention](../DATA_MODEL.md#retention)).

## Company details (pending from the client)

The client will provide these later. Until then, keep them in one **company settings** record in Pulse Core, editable by the System Administrator, filled with clearly marked placeholders (e.g. `[Company TIN]`). Never hardcode them in templates or code.

- Company logo (login page, sidebar, payslips, HR documents, reports)
- Registered company name
- Business address
- Company TIN and RDO code
- SSS employer number
- PhilHealth employer number
- Pag-IBIG employer ID
- BIR registration details for system-generated invoices and computerized books (e.g. the CAS/CBA acknowledgment or permit details, and the registered invoice number series)

Quotations, purchase orders, delivery receipts, sales invoices, vouchers, service reports, support contracts, payslips, HR documents and remittance reports read these from company settings, so they update everywhere once filled in. HR and the System Administrator see a reminder while any are still placeholders.

The company TIN and the employer numbers are company data, not [sensitive personal data](../../SECURITY.md#sensitive-data): they are stored and shown in full, and appear in audit snapshots.

### Company settings page

Built in step 1.4, at `/admin/settings`. The page and everything on it (company details, the logo, allowed email domains and upload settings) are for the System Administrator only; anyone else, HR included, gets the no-access state (HTTP 403, see [Administration area](#administration-area)). Each service checks the role again itself. The page is in the sidebar's Administration group for the System Administrator.

- **Placeholders.** A company detail counts as a placeholder while its value is still a marked placeholder (`[Company TIN]`, see `isPlaceholder`). The logo counts too: it is pending while no logo is uploaded (`logoFileId` is null). The page labels each pending detail "Placeholder".
- **Reminder banner.** While any detail is pending, Home and `/admin` show HR and the System Administrator a banner listing the missing details. Nobody else sees it. It clears once every detail, the logo included, is filled in.
- **Reminder notification.** A [background job](../ARCHITECTURE.md#background-jobs) runs weekly, Mondays at 08:00 Asia/Manila, while any detail is pending. It notifies every active HR user and System Administrator (event `core.companyDetailsPending`), linking the System Administrator to `/admin/settings` and HR to `/admin`. It is idempotent per Manila day: a recipient who already got that event that day is skipped, so a rerun sends nothing twice.
- **Logo.** PNG, JPEG or WebP only, saved through the [storage service](../ARCHITECTURE.md#file-storage) under the owner `core.companySettings`, then set on the settings record. The file is saved before the transaction that sets it, so if that transaction fails the file is left orphaned in storage; this is accepted. The login page, the sidebar and other screens show it through the public `/company-logo` route (see [Exceptions to module access](../../SECURITY.md#exceptions-to-module-access)), and show the placeholder mark until a logo exists. The logo can also be removed.
- **Allowed email domains.** The list shows how many users are on each domain. Adding a domain that was removed restores that record (audit `restore`). Removing one is a soft delete, after a confirmation that shows how many users are on it. Removing the last remaining domain, or the domain of the acting System Administrator's own email, is refused.
- **System-wide settings** are the upload limits only: the maximum upload size and the allowed file types (the `core.fileUploads` setting, see [File storage](../ARCHITECTURE.md#file-storage)). They are [versioned configuration](../DATA_MODEL.md#versioned-configuration): a change adds a new version effective from today in Manila, never an edit. Only one version can take effect per day, so a second change on the same Manila day is refused with a clear error.
- **Audit:** every change writes its audit entry in the same transaction (record types `core.companySettings`, `core.allowedEmailDomain` and `core.configVersion`). Setting or removing the logo is an `update` of the settings record.
