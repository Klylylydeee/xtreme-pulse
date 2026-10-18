# Pulse Core (Platform)

Pulse Core is the platform every module builds on. It covers sign-in, user accounts, system administration, the company directory and org chart, the holiday calendar, shared master data, approvals, notifications, the audit log and company settings.

Built in [Phase 1](../BUILD_PLAN.md#phase-1-pulse-core). Routes: the login page, Home (`/`), Approvals (`/approvals`, from build step 1.9), Holidays (`/holidays`, from build step 1.10), the directory (`/directory`) and the org chart (`/org-chart`, both from build step 1.11), and administration (`/admin`). Package: `packages/core`.

Sign-in, passwords, account status, module access and the System Administrator role are security rules, so they live in [SECURITY.md](../../SECURITY.md).

## People data ownership

Every user is an employee of Xtreme Works (the only exception is the bootstrap system account). Pulse Core owns the user account and org structure (login, account status, module access, department, position, reporting lines, directory, org chart), and the employee identity fields account status depends on: employee number, name, date hired, employment status and separation date (`employees.separationDate`, see [Managing user accounts](#managing-user-accounts)). Pulse Talent owns employment, government, payroll, timesheet and document details, and shows Core's identity fields in its employee record. Both reference the same `employeeId`.

**The profile photo** (build step 2.2) is Core data, `employees.photoFileId`, because Core's directory, org chart, access page, approvals and command bar show it.
- **Who sets it.** Core's `setEmployeePhoto(actor, employeeId, file)` and `removeEmployeePhoto(actor, employeeId)` allow the employee themself, HR and the System Administrator, never on the bootstrap system account. Each change writes an `update` entry on `core.employee`.
- **Where.** Pulse Talent provides the controls, on `/talent/me` and in the employee inspector ([Documents, photo, e-signature and certifications](talent.md#documents-photo-e-signature-and-certifications-build-step-22)).
- **How it's served.** The image is re-encoded (metadata stripped) and opens through the file route for any signed-in active user, the current photo only.
- **Who sees it.** The identity service and the directory projections carry it as `photoUrl`.

**Alert recipients for jobs** (build step 2.2). `employeeNotificationContacts(employeeIds)` and `activeHrUserIds()` let a background job, which has no signed-in user, find who to notify about an employee:
- **For each employee:** the employee number, name, whether they are separated, their active user, and their active `reportingTo` supervisors' users.
- **Never returned:** a sensitive field.
- **Callers:** server-only, for jobs. They never reach a page. From build step 2.6 Talent's change request service also calls them, to name a change request's approvers (the active supervisors and HR users) and to notify HR.

**Onboarding facts** (build step 2.6). `employeeOnboardingFacts(employeeIds)` gives Talent what the onboarding checklist needs from Core, per employee: whether the account still has a temporary password, whether it is in the User access page's "Needs access" group, whether a profile photo is set, whether the employee is in the Board department, how many of their `reportingTo` supervisors are active, and the department, position and employment status ids or values. It returns no sensitive field and nothing about module access beyond the "Needs access" flag. Server-only; Talent's onboarding service calls it after its own access check ([Onboarding checklist and change requests](talent.md#onboarding-checklist-and-change-requests-build-step-26)).

**The identity service** (build step 2.1). Pulse Talent reads Core's identity through Core's service functions in `packages/core/src/server/employees/identity.ts`, never the models.

- **`listEmployeeIdentities(actor, { q, departmentId, status, separated })` and `getEmployeeIdentity(actor, employeeId)`** return, field by field:
  - the employee id and the account's user id
  - employee number, first, middle and last name, and login email
  - department (id, name, code) and position (id, name, timesheet type)
  - `reportingTo` (ids and names)
  - employment status, date hired and separation date
  - whether the account is active

  They need Talent Read, or for `getEmployeeIdentity` the actor's own employee. Separated employees come back only when asked (`separated`) and only with Talent Read. The bootstrap system account has no employee and never appears.
- **Supervisors** (build step 2.4). `getEmployeeIdentity` also returns an active employee whose `reportingTo` includes the actor's own employee, whatever the actor's module access; a separated one comes back only with Talent Read, as before. **`listDirectReportIdentities(actor)`** returns the identities of the active employees whose `reportingTo` includes the actor's employee, by last name then first name (none for an actor without an employee). Pulse Talent uses both for the supervisor's read-only view of a team member's timesheet ([Work schedules and daily time entries](talent.md#work-schedules-and-daily-time-entries-build-step-24)). Talent sends such a supervisor only the directory fields; the rest stays on the server ([Exceptions to module access](../../SECURITY.md#exceptions-to-module-access)).
- **`getSensitiveSubject(employeeId)`** returns only the employee id and current department code, for the [reveal rules](../../SECURITY.md#sensitive-data). It takes no actor, because `revealSensitiveField` has already checked the user.

These reads add no audit entry, and they never feed the directory, whose allowlist is unchanged ([Company directory](#company-directory)).

## Bootstrap System Administrator account

- A fresh install has no users, so a seed script creates the first System Administrator: `pnpm seed:admin` (`scripts/seed-admin.ts`).
- Default login email: **`sysadmin@xtreme-works.com`**.
- The script reads the email and initial password from environment variables `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. **Never commit the password** to the repo, these docs, seed files or logs.
- The account must change its password on first sign-in.
- It is a **system account**, not an employee: no employee number or employment status, always active unless another System Administrator disables it (on `/admin/users`, from build step 1.7, see [System Administrator](../../SECURITY.md#system-administrator)), and excluded from the directory, org chart, onboarding, timesheets, payroll and reporting lines.
- The script is idempotent in two parts. If a System Administrator already exists, it skips creating one. Base data loaders insert only what is missing and never overwrite existing records, so base data for modules built later can be added to an existing database (for example during a staged go-live).
- A loader may fill a field that is absent on an existing record; it never changes an existing value.
- Seeded positions carry a stable seed key, so renaming a seeded position doesn't make the seed add it again.
- **Products** (build step 1.8): the seed loads the 13 products listed in [Deals and stages](engage.md#deals-and-stages), each with a stable `seedKey`, and inserts only the missing ones. A product added by hand with the same name (ignoring case) counts as present, and a renamed seeded product isn't added again. "General" isn't protected: it can be renamed or retired like any product ([Managing master data](#managing-master-data)).
- **Holiday rules** (build step 1.10): the seed adds the first version of the `core.holidayRules` setting only when the setting has no version, so a later run never replaces it ([Holiday calendar](#holiday-calendar)).
- **Talent payroll settings** (build step 2.3): after Core's loaders, the script runs Pulse Talent's (`talentSeedLoaders` from `@pulse/talent/server/seed`), one per payroll setting. Each adds its seeded versions only when that setting has no version, the same rule as the holiday rules ([Payroll settings and allowances](talent.md#payroll-settings-and-allowances-build-step-23), [Seeded payroll rates](../COMPLIANCE.md#seeded-payroll-rates-build-step-23)). From build step 2.4 the same loaders also seed `talent.workSchedule` (the company default schedule) and `talent.timesheetSettings` ([Work schedules and daily time entries](talent.md#work-schedules-and-daily-time-entries-build-step-24)), from build step 2.5 `talent.reimbursementSettings`, and from build step 2.6 one more Talent loader seeds `talent.onboardingSettings` (the required onboarding documents) under the same rule ([Onboarding checklist and change requests](talent.md#onboarding-checklist-and-change-requests-build-step-26)).
- Seed writes are system writes (`createdBy` is null) and are not audit-logged. They are not backfilled when the [audit log](#audit-log) arrives in build step 1.3.
- The seed only loads the allowed email domains. The allowed-domain check runs in services (bootstrap, sign-in and user creation) against the stored `allowedEmailDomains` records, not in the users schema.
- The same seed run loads base data: allowed email domains, departments and positions (see [Departments and positions](#departments-and-positions)), products (build step 1.8), the holiday rules (build step 1.10), leave types, payroll settings (cut-offs, daily rate factor), contribution tables, holiday premium rates, regional minimum wage rates (NCR), the default work schedule, the internet allowance, HR document templates, and company settings placeholders.

## Administration area

Built in step 1.6. The `/admin` pages are checked by role, not module access ([Rules](../../SECURITY.md#rules)), and appear in the sidebar's **Administration** group:

| Entry | Group | Route | Who |
|---|---|---|---|
| Overview | None (always at the top) | `/admin` | HR and the System Administrator |
| Users | People and organization | `/admin/users` | HR and the System Administrator |
| User access | People and organization | `/admin/access` | HR and the System Administrator (build step 1.7) |
| Departments | People and organization | `/admin/departments` | HR and the System Administrator |
| Positions | People and organization | `/admin/positions` | HR and the System Administrator |
| Clients | Master data | `/admin/clients` | The System Administrator (build step 1.8) |
| Products | Master data | `/admin/products` | The System Administrator (build step 1.8) |
| Catalog items | Master data | `/admin/catalog-items` | The System Administrator (build step 1.8) |
| Suppliers | Master data | `/admin/suppliers` | The System Administrator (build step 1.8) |
| Company settings | System | `/admin/settings` | The System Administrator |
| Audit log | System | `/admin/audit` | The System Administrator |

- Anyone else doesn't see the group (an empty sidebar group is hidden), and gets the [no-access state](../DESIGN_SYSTEM.md#feedback--motion) (HTTP 403) on every `/admin` page, `/admin` itself included. HR gets it on `/admin/clients`, `/admin/products`, `/admin/catalog-items`, `/admin/suppliers`, `/admin/settings` and `/admin/audit`, and doesn't see those entries.
- Breadcrumbs read "Administration › Users" and so on, from the longest matching entry. The command bar's navigation items follow the filtered sidebar.
- From step 1.7, User access sits after Users, with a badge counting the users who still need access, and its breadcrumb reads "Administration › User access". The `/admin` overview gets a User access card with the same count ([User access page](#user-access-page)).
- From step 1.8, the four master data entries sit before Company settings, for the System Administrator only, with breadcrumbs "Administration › Clients", "Administration › Products", "Administration › Catalog items" and "Administration › Suppliers" ([Managing master data](#managing-master-data)).
- The entries after Overview fall into three collapsible sub-groups, in this order: **People and organization**, **Master data** and **System** (the Group column). They are the same groups, in the same order, as the cards on the `/admin` overview, which shows each group the user can see. Overview stays at the top, outside any group. A group holds only the entries the user can see, so HR, who sees only People and organization, gets those entries listed plainly under Overview with no toggle, and the System Administrator gets all three groups. How the groups open, close and show badges is in [Layout & components](../DESIGN_SYSTEM.md#layout--components). Breadcrumbs don't change ("Administration › Users"): the sub-groups aren't part of them.

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
- Only **HR, Board of Directors members and the System Administrator** can set or change `reportingTo`. Employees and supervisors cannot. HR and the System Administrator edit it on `/admin/users` (build step 1.5, [Managing user accounts](#managing-user-accounts)). From build step 1.11, HR, Board members and the System Administrator also edit it in the inspector on the directory and the org chart ([Company directory](#company-directory)).
- **Checked on save** (build step 1.5): at most 10 supervisors, no one listed twice, and each supervisor must exist, be an employee (not the bootstrap system account) and be active when saved. The cycle check walks the upward chain inside the transaction. It writes every supervisor record it reads, and the employee's own, so two edits that would together form a cycle conflict and the retried one is refused. An edit that only removes or reorders supervisors isn't checked again (it can't add a cycle or anyone inactive), so a line to someone who later separated can stay.
- Existing lines to someone who later separates stay as they are. The approvals engine (build step 1.9) leaves an inactive or separated supervisor out when a request is submitted, so a supervisor step goes only to the active ones ([Approvals](#approvals)). The org chart (build step 1.11) doesn't draw them, and only the editors see them in the inspector ([Org chart](#org-chart)).
- **Editing in the inspector** (build step 1.11). Who may edit: HR, Board members and the System Administrator (`canEditReportingLines`), checked by role in the Server Action and again in the service. Nobody edits their own lines ("You can’t change your own reporting lines."); the bootstrap system account has none; a separated employee's lines can't be edited from the inspector. A Board member may edit anyone else's, HR staff and System Administrators included.
  - The inspector and `/admin/users` share one change rule in Core's reporting-lines service: the checks above, including the shortcut for an edit that only removes or reorders supervisors.
  - **Stale form.** A save sends the supervisors the inspector opened with, in order. When the stored lines differ, it is refused with "Someone else changed <name>’s reporting lines since you opened them. Reload to see the change."
  - **Supervisor search.** The inspector has its own search, for the same editors: active employees by name or employee number, at most 20, without the person being edited. `/admin/users`' search stays HR and System Administrator only.
  - **Audit.** One `update` entry on `core.employee` (label `<employee number> · <first last>`, both sides snapshotted with `snapshotsForAudit`) in the save's transaction. There is no typed reason, and a save that changes nothing writes nothing.
  - **No notification** is sent. Pending approval requests keep the approvers fixed at submit ([Approvals](#approvals)).
- Approval workflows (leave, offset time off, timesheets, purchase requests, quotes, employee record changes, regularization) route through `reportingTo`.
- **Any one supervisor can decide.** When an employee has multiple supervisors, the request goes to all of them, and the first decision (approve, return or reject) settles it. The other supervisors are notified of the outcome and can no longer act on it.
- No one approves their own request. When the only approver in a step is the requester (e.g. the HR Officer's own timesheet at the HR step), the step goes to the System Administrator (see [Approvals](#approvals)).

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
- **The bootstrap system account** shows only to System Administrators, read-only, with Reset password and, from build step 1.7, Disable or Enable ([System Administrator](../../SECURITY.md#system-administrator)).
- **Temporary password dialog.** After creating a user or resetting a password, a dialog shows the generated temporary password once, with Copy and "Hand it over privately". Closing it ends the only chance to see it; if it's lost, reset again ([Sign-in and passwords](../../SECURITY.md#sign-in-and-passwords)).
- **Audit:** record types `core.employee`, labelled `<employee number> · <first name> <last name>` (for example `2027-01 · Ana Cruz`), and `core.user`, labelled with the email. Creating a user writes the user, the employee and two `create` entries in one transaction. Edits are `update` entries with both sides snapshotted (`snapshotsForAudit`). A reset is a `passwordReset` entry on the `core.user` record, with no hash, showing `mustChangePassword` before and after. None of these fields is [sensitive personal data](../../SECURITY.md#sensitive-data). The temporary password appears only in the action's response to the person who did it, never in an entry.
- **After creating a user** (build step 1.7): once the temporary password dialog closes, the screen goes to that user's access sheet (`/admin/access?user=<id>`). Cancel there is "Set access later".
- **After a position change** (build step 1.7): once the save succeeds, the editor sees a "Review access" link to the user's access sheet. Access never changes with the position ([Rules](../../SECURITY.md#rules)).
- **Notifications** (build step 1.7): creating a user, and changing a user's position, notify the other active HR users and System Administrators, never the person who made the change. Each is sent in the save's transaction, so a failed save sends nothing ([User access page](#user-access-page)). Other edits send nothing.

## User access page

The page where HR and the System Administrator set each user's module access. Built in step 1.7 (the details follow the list below).

- **Route:** `/admin/access`, in the Pulse Core administration area. It appears in the sidebar only for HR and the System Administrator, with a badge counting users who still need access.
- **List:** every active user with profile photo (initials until a photo is added; photos from build step 2.2), name, employee number, department, position, and a compact access summary per module (e.g. `Talent R`, `Fiscal O`). Search by name or employee number; filter by department and position.
- **Needs access:** users with None on every module are pinned at the top under a "Needs access" heading, newest first.
- **Editing:** selecting a user opens a sheet with one row per module (Engage, Ops, Supply, Desk, Fiscal, Talent, Insight). Each row has a segmented control **None | Read | Write | Owner** with a one-line description of the selected level; Insight offers None | Read only. Save applies all changes at once. The sheet shows who last changed the user's access and when.
- **System Administrator role:** the sheet has a "System Administrator" switch above the module rows, visible and editable only to System Administrators. Turning it on makes the user resolve to Owner on every module (Read on Insight) and locks the rows; the stored levels are kept and apply again if the switch is turned off. A confirmation is required, and the last remaining System Administrator can't be switched off.
- **Read-only rows:** a user's own access, the bootstrap system account's, and the System Administrator's access when viewed by HR, are shown but cannot be edited (see [Module access](../../SECURITY.md#module-access-rwo)).
- **After creating a user:** HR or the System Administrator goes straight to that user's access sheet, with the option to set access later.
- **From the employee record** (build step 2.1, with the Talent employee record): an active employee's record in Pulse Talent has a "Manage access" action, shown to HR and the System Administrator only, that links to the same sheet (`/admin/access?user=<userId>`). The access page keeps every check of its own ([The employee record](talent.md#the-employee-record-build-step-21)).
- **Notifications:** HR and the System Administrator are notified when a new user is created and when a user's position changes, and reminded daily while any user still needs access.
- **New user's home** (build step 1.6): a user whose effective access is None on every module sees a card under the Home hero: an icon tile and "Your access is being set up. HR will give you access to the modules you need." It never shows to the System Administrator, but can show to HR or a Board member with nothing set. It replaced the "Nothing needs your attention" empty state while it showed; from build step 1.11 that empty state is gone and the card sits under the hero, above the tiles ([Home](#home)). The company details reminder is unchanged ([Feedback & motion](../DESIGN_SYSTEM.md#feedback--motion)). Self-service stays available.
- **Board members:** Board of Directors members normally need Insight Read for the Board dashboards, targets and weekly summary. The sheet shows this as a hint for Board members; it never grants access automatically.
- Every change is audit-logged (see [Module access](../../SECURITY.md#module-access-rwo)).

Built in step 1.7:

- **Who.** Checked by role like the rest of the [Administration area](#administration-area): `requireAdminPage('hrOrSystemAdministrator')` on the page and `adminOnly('hrOrSystemAdministrator')` on its Server Actions; anyone else gets the no-access state (HTTP 403). The service checks the role again itself, and only a System Administrator can use the switch.
- **Which users.** Active users only. An inactive user has no access to set: the list leaves them out and the service refuses them. The bootstrap system account shows only to System Administrators, read-only, with a "System Administrator" badge and no access chips; HR doesn't see it.
- **List.** Search matches the name and the employee number. Department and Position filters. The filters live in the URL (`?q=`, `?department=`, `?position=`), and `?user=<id>` opens that user's sheet. Each row's summary has one chip per module above None (`Talent R`, `Fiscal O`), or "All modules R" (or W, O) when every module has the same level. Each row shows "Added <date>", when the account was created. Stat tiles above the list show how many active users have access (for example "With access 18 of 21") and how many users each module has. On a phone the rows become cards.
- **Needs access group.** Active users who aren't System Administrators and have None stored on every module, HR and Board members included; never the system account. Newest first; everyone else is sorted by last name. The sidebar badge and the `/admin` overview card show the same count. Only HR and System Administrators get the count, refreshed on each navigation.
- **Level descriptions.** None "Can't see this module." Read "Can view records." Write "Can view, create and edit records." Owner "Full control: approve, void, delete and manage settings."
- **The sheet** also shows an "After saving, <first name> sees:" preview of the modules the user will see, and "Last changed: never" or "Last changed <when> by <name>" (the name, else the email). Cancel and Save, with Ctrl+S or ⌘S to save. "Last changed" comes from `users.moduleAccessChangedAt` and `users.moduleAccessChangedBy` ([DATA_MODEL.md](../DATA_MODEL.md#collection-ownership)), not from the audit log.
- **Read-only.** For everyone: one's own row, the switch included, and the bootstrap system account. For HR: a System Administrator's row. The sheet says why it is read-only.
- **Saving.** One transaction. The service checks the actor's role and that the actor's own account is still active, loads the user, and refuses an inactive user, one's own row, the system account and, for HR, a System Administrator. It writes only the modules whose level changed, sets `moduleAccessChangedAt` and `moduleAccessChangedBy`, and writes one `accessChange` entry per changed module. A save that changes nothing writes nothing. If someone else changed the user's access after the sheet opened (the sheet sends back the `moduleAccessChangedAt` it loaded), the save is refused with "Someone else changed this user's access. Reload to see it."
- **The switch** changes only `isSystemAdministrator`; it never writes the stored levels. While it is on, the rows show locked at Owner (Read on Insight). The confirmation to turn it off lists the stored levels that will apply again. It writes its own `accessChange` entry, with `isSystemAdministrator` before and after, and counts as an access change for "Last changed". Turning it off goes through the never-zero guard ([Account status](../../SECURITY.md#account-status)), and a System Administrator can't switch off their own.
- **Audit entries.** Module `core`, action `accessChange`, record `core.user` labelled with the email, one entry per changed module, holding only that module: `before: { moduleAccess: { talent: "none" } }`, `after: { moduleAccess: { talent: "write" } }`. Written in the save's transaction, so a failed entry fails the save.
- **Notifications** go to every active HR user and System Administrator except the person who made the change, as in-app [notifications](#notifications). The daily reminder has no actor, so it goes to all of them, at most once per recipient per Manila day (`notify()`'s duplicate check, key `core.accessReminder:<Manila date>`), and nothing is sent while nobody needs access.

| Event | When | Title (example) | Link |
|---|---|---|---|
| `core.userCreated` | A user is created on `/admin/users`, in the create transaction | "New user: Ana Cruz needs access" | `/admin/access?user=<id>` |
| `core.positionChanged` | A user's position changes on `/admin/users`, in the save's transaction | "Review Ana Cruz's access: position changed to Driver" | `/admin/access?user=<id>` |
| `core.usersNeedAccess` | The daily job `core.accessReminder`, 08:00 Asia/Manila every day, weekends included, while anyone needs access ([Background jobs](../ARCHITECTURE.md#background-jobs)) | "3 users still need access" | `/admin/access` |

- **Not in step 1.7:** "Manage access" on the Talent employee record (built in step 2.1), profile photos (initials only), email notifications, and changing access automatically on a position change (never).

## Company directory

- All active users can see each other's name, profile photo, employee number, department, position, login email and `reportingTo`.
- Everything else in the employee record stays private (the employee, HR, Accounting and the System Administrator, per the [Sensitive data](../../SECURITY.md#sensitive-data) rules).
- Deactivated employees are hidden from the directory by default; HR and the System Administrator can still view them.

Built in step 1.11:

- **Route:** `/directory`, a Pulse Core page open to every signed-in user with no module access needed ([Rules](../../SECURITY.md#rules)). It sits in the Pulse Core sidebar group after Holidays; the breadcrumb reads "Pulse Core › Directory".
- **Fields, an allowlist.** Each person shows exactly: name, profile photo (initials until a photo is added; photos from build step 2.2), employee number, department, position, login email and `reportingTo`, plus their direct reports (the people whose `reportingTo` names them). Services build each result field by field from explicit projections. The date hired, employment status, separation date, module access and every Pulse Talent field never leave the server ([Sensitive data](../../SECURITY.md#sensitive-data)).
- **Who is listed.** Employees whose account resolves to active ([Account status](../../SECURITY.md#account-status)). HR and the System Administrator get a "Show separated" switch (`?separated=1`); separated people then show with an "Inactive" badge, never their date or status. For anyone else, Board members included, the server ignores the switch, and a separated person's card answers like a missing one. The bootstrap system account never appears.
- **List.** Sorted by last name, then first name, with no paging. Search by name, employee number or email (`?q=`) and filter by department (`?department=`). A table on desktop, a list on a phone.
- **Directory card.** Selecting a person opens their card in the inspector (a full-height sheet on a phone); `?person=<employeeId>` opens it directly, and the command bar links there. The card shows the fields above, with "Reports to" and "Direct reports", each person opening their own card, and the email as a mail link. A line to an inactive or separated supervisor shows, with an "Inactive" badge, only to HR, Board members and the System Administrator, so they can remove it.
- **Editing reporting lines.** For HR, Board members and the System Administrator, "Edit reporting lines" turns the "Reports to" section into the supervisor picker, inline in the inspector (not a sheet), with the hint "No supervisor: leave and offset time off go to HR." for someone outside the Board, Save (⌘↵ or Ctrl+Enter) and Cancel. The rules are in [Reporting lines](#reporting-lines).
- **Not logged.** Opening the directory, a card or the org chart isn't audit-logged or written to the logs, and nothing is cached across users.
- **Not in step 1.11:** profile photos (Phase 2), the rest of the employee record (Pulse Talent), and editing anything on the card but reporting lines.

## Org chart

- Built automatically from `reportingTo`, so it always reflects the current structure. There is no separate chart to maintain.
- Visible to **every active user**, so everyone can see how the company is organized.
- Each person shows directory-level information only: profile photo, name, position and department. Clicking opens their directory card.
- Employees with more than one supervisor appear once, with a line to each supervisor.
- Filter by department and search by name.
- Deactivated employees and the bootstrap system account are not shown.

Built in step 1.11:

- **Route:** `/org-chart`, a Pulse Core page open to every signed-in user with no module access needed, after Directory in the Pulse Core sidebar group; the breadcrumb reads "Pulse Core › Org chart".
- **Who is shown.** Active employees only, for everyone, HR and the System Administrator included. A line to a separated or inactive supervisor isn't drawn; a person left with no shown supervisor sits at the top level.
- **Layout.** Each person appears once, placed by the longest chain of supervisors above them, with one line to each shown supervisor. The chart is one scrollable, zoomable region at every width, with zoom out, zoom in and Fit buttons; the page itself never scrolls sideways. There is no separate tree list.
- **Cards** show the photo (initials), name, position and department. Selecting one opens that person's directory card in the inspector on the same page (`/org-chart?person=<employeeId>`), where editors can change reporting lines ([Company directory](#company-directory)).
- **Department filter** (`?department=`), applied on the server: that department's members and the lines among them. A member whose shown supervisors are all outside the department gets the caption "Reports to <names>".
- **Search by name** (`?q=`) highlights the matching cards with a ring and the label "Match", dims the rest and scrolls to the first match, without changing the layout.
- **Accessibility.** Cards are buttons in reading order (by level, then position), each named with whom they report to ("Ana Cruz, Network Engineer, reports to Ben Reyes and Carla Lim"). The lines are hidden from assistive technology ([Accessibility](../DESIGN_SYSTEM.md#accessibility)).

## Command bar

Built in step 1.11. The command bar ("Search or jump to…", ⌘K on Mac and Ctrl+K elsewhere, [Pro-app layout](../DESIGN_SYSTEM.md#pro-app-layout)) is open to every signed-in user and searches people and actions across what the user can open.

- **Go to.** The navigation items the server already filtered for the user (the same list as the sidebar), matched as the user types. These are the command bar's actions in step 1.11.
- **People.** Core's people provider (`core.people`) finds active employees by name or employee number, for every signed-in user, and shows the name, employee number and position. Choosing one opens their directory card (`/directory?person=<employeeId>`). Separated people never appear, whoever searches.
- **Provider registry.** Modules add their records and actions through `registerCommandProvider({ key, group, kind, isVisibleTo, search })` in `@pulse/core/server` ([Cross-module integration](../ARCHITECTURE.md#cross-module-integration)). `kind` is `records` or `actions` (`COMMAND_PROVIDER_KINDS`). A result has an id, a title, an optional subtitle, a link and an icon key from `COMMAND_ICONS` (`person`, `action` in step 1.11; modules add theirs). Registering a key a second time throws in production; in development and tests it replaces the first, since a hot reload runs the registering code again. Core's own registration (`registerCoreCommandProviders()`) registers each provider once per process, so the command bar's search calls it on every request. Core registers no action provider in step 1.11.
- **Filtered by access.** Only providers whose `isVisibleTo(user)` accepts the user are called, and each provider still checks its own records, so a result never names something the user can't open ([Rules](../../SECURITY.md#rules)).
- **Searching.** From 2 characters, 200 ms after the user stops typing; only the latest request's answer is used, and nothing is cached. Queries are trimmed and capped at 100 characters. Each provider returns at most 8 results. A provider that fails is left out of the answer, and the log names its key only, never the query or a record. Every result's link must be a path inside the app, by the same rule as a [notification link](#notifications); any other is dropped.
- **Links only.** Choosing an entry goes to its link. Nothing in the command bar changes data, and searches aren't audit-logged.
- **Not in step 1.11:** modules' records and actions (each phase registers its own), recent searches, and actions that change data.

## Home

Built in step 1.11. Home (`/`) is open to every signed-in user and shows only their own data.

- **Hero.** "Good morning", "Good afternoon" or "Good evening" with the user's first name, by the Manila time (before 12:00, 12:00 to 17:59, from 18:00), and the Manila date. The bootstrap system account gets the greeting without a name.
- **Access card.** While the user's effective access is None on every module, the card under the hero stays as in step 1.6 ([User access page](#user-access-page)); the company details reminder is unchanged.
- **Onboarding card** (build step 2.6). While any of the user's own onboarding items is To do, a "Finish setting up your profile" card with the progress ("5 of 8 done") and "Continue" sits under the hero, above the access card. Pulse Talent provides its data; it never shows for the bootstrap system account ([Onboarding checklist and change requests](talent.md#onboarding-checklist-and-change-requests-build-step-26)).
- **Tiles**, each loading and failing on its own:

| Tile | Shows | Opens |
|---|---|---|
| Approvals waiting | The count of requests waiting for the user ([Approvals list](#approvals-list)) and "Oldest submitted N days ago", from the oldest waiting request's submit date | `/approvals` |
| Unread notifications | The user's unread count ([Notifications](#notifications)) | `/notifications` |
| Upcoming holidays | Up to 3 confirmed holidays in the next 60 days, with their date and type ([Holiday calendar](#holiday-calendar)) | `/holidays` |
| Your team | The user's active supervisors and active direct reports, with directory fields only; hidden for the bootstrap system account | Each person's directory card |

- **Zero states.** Each tile has its own ("Nothing is waiting for you.", "You're all caught up.", "No holidays in the next 60 days.", "No one reports to you yet."), so the "Nothing needs your attention" empty state is gone.
- **Numbers only.** Tiles show counts and lists, with no trend charts until Pulse Talent brings data over time (Phase 2).
- **Not in step 1.11:** the timesheet, leave, offset and payslip tiles (Phase 2).

## Holiday calendar

- Shared master data in Pulse Core, managed by HR and the System Administrator. Used by timesheets, payroll, leave (holidays are not deducted from leave balances) and later by SLA timers in Pulse Desk.
- Each holiday: name, date, type (regular holiday, special non-working day, special working day), scope (nationwide or a specific city/municipality), legal basis (e.g. Proclamation No.), status (draft or confirmed).
- Only **confirmed** holidays affect attendance, leave and payroll. Drafts are shown to HR and the System Administrator only.

### Keeping it updated
1. **Yearly auto-draft:** every October 1, a background job creates next year's holidays as drafts:
   - Fixed-date holidays (e.g. New Year's Day, Araw ng Kagitingan, Labor Day, Independence Day, Ninoy Aquino Day, All Saints' Day, Bonifacio Day, Christmas Day, Rizal Day)
   - National Heroes Day (last Monday of August)
   - Holy Week dates computed from Easter (Maundy Thursday, Good Friday, Black Saturday)
   - Keep this list as seed configuration, not code, since holidays are added or changed by law.
2. **Optional online source:** if the server has internet access, also pull a public Philippine holiday API or calendar feed and add anything missing as drafts (e.g. Chinese New Year). Never auto-confirm from an outside source.
3. **HR confirms against the official proclamation:** each year's holidays are declared by Presidential Proclamation, published in the Official Gazette, usually a few months before the year starts. HR checks the drafts against it, moves dates that were shifted, adds missing ones, deletes ones not declared, and confirms.
4. **Ad-hoc declarations:** Eid'l Fitr and Eid'l Adha are declared by separate proclamation close to the date, and special non-working days can be declared at any time (e.g. weather or national events). HR adds them when announced, and all users are notified.
5. **Reminders:** if next year has no confirmed holidays by December 1, alert HR and the System Administrator weekly until it is done.
6. Adding or changing a holiday recomputes the DTR for payroll periods not yet finalized. Finalized periods get adjustments in the next payroll. (From Phase 2: in step 1.10 the holidays-changed event has no listeners, see below.)

Built in step 1.10 (the details follow; the collection and its indexes are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership)):

- **Route:** `/holidays`, a Pulse Core page open to every signed-in user with no module access needed ([Rules](../../SECURITY.md#rules)). It sits in the Pulse Core sidebar group after Approvals; the breadcrumb reads "Pulse Core › Holidays".
- **Who sees what.** HR and System Administrators see drafts and confirmed holidays. Everyone else sees confirmed holidays only, filtered in the server query, so a draft never reaches their browser.
- **Who manages.** HR and System Administrators add, edit, confirm, declare, delete and run the auto-draft on the same page. This is checked by role on the server, in the Server Actions and again in the service; nobody else gets the controls or can call them.
- **Fields.** Name (up to 100 characters), date (a Manila day), type (`regular`, `specialNonWorking` or `specialWorking`, shown as "Regular holiday", "Special non-working day" and "Special working day"), scope (`nationwide` or `local`), location (free text up to 100 characters, required when the scope is local; a nationwide holiday stores none, and a location left in the form is cleared on save), legal basis (up to 200 characters, for example "Proclamation No. 1006"), status (`draft` or `confirmed`). How a local holiday applies to employees is decided in Phase 2: from build step 2.4, timesheets apply confirmed nationwide holidays only, and show a local holiday on its day as information ([Work schedules and daily time entries](talent.md#work-schedules-and-daily-time-entries-build-step-24)).
- **Adding** a holiday creates a draft (source `manual`). The legal basis is optional on a draft.
- **Confirming** needs a legal basis: a draft without one can't be confirmed. Confirm sets `confirmedAt` and `confirmedBy`. **Confirm all** confirms a year's drafts at once, and is refused while any of them has no legal basis; the refusal lists those drafts. Confirming doesn't notify every user.
- **Declare holiday** is the ad-hoc path for a holiday announced at short notice (Eid'l Fitr, Eid'l Adha, a special non-working day for weather or a national event). It creates a holiday that is confirmed at once and marked `declared`, needs a legal basis, and notifies every active user except the person declaring it (`core.holidayDeclared`) in the same transaction, so a failed save notifies no one. The bootstrap system account is never notified.
- **Editing and deleting.** A draft is edited or deleted freely. A holiday's date can be changed only within its year: a move to another year is refused, and the user deletes the holiday and adds a new one instead. A confirmed holiday can be edited or deleted after a confirmation dialog, but an edit can't remove its legal basis. There is no unconfirm. Deleting is a soft delete (`deletedAt` set) with no restore screen.
- **Same date.** Several holidays may share a date. The same name on the same date, ignoring case, is refused among live (not deleted) holidays. When the chosen date already has a holiday, the form shows a non-blocking warning naming it.
- **Auto-draft rules** are versioned configuration: the setting `core.holidayRules` ([Versioned configuration](../DATA_MODEL.md#versioned-configuration)), defined with `defineConfigSetting`. `pnpm seed:admin` seeds its first version once, only when no version exists, effective from the day it is seeded. An auto-draft run uses the version in effect on the day it runs (Manila). Step 1.10 has no editor for it. Each rule has a stable key, a name, a default type and one of three kinds:
  - `fixed`: a month and a day.
  - `lastWeekday`: a month and a weekday, the last one in that month (National Heroes Day is the last Monday of August).
  - `easterOffset`: a number of days from Easter Sunday (Maundy Thursday −3, Good Friday −2, Black Saturday −1). Easter Sunday is computed with the anonymous Gregorian algorithm.
- **Seeded rules.** Regular holidays follow RA 9492 as amended; the others default to special non-working days, apart from the EDSA anniversary, which recent proclamations have made a special working day. Types and dates change by proclamation, so HR checks every auto-draft against the year's proclamation before confirming it.

| Holiday | Rule | Default type |
|---|---|---|
| New Year's Day | Fixed, January 1 | Regular holiday |
| EDSA People Power Revolution Anniversary | Fixed, February 25 | Special working day |
| Maundy Thursday | Easter −3 days | Regular holiday |
| Good Friday | Easter −2 days | Regular holiday |
| Black Saturday | Easter −1 day | Special non-working day |
| Araw ng Kagitingan | Fixed, April 9 | Regular holiday |
| Labor Day | Fixed, May 1 | Regular holiday |
| Independence Day | Fixed, June 12 | Regular holiday |
| Ninoy Aquino Day | Fixed, August 21 | Special non-working day |
| National Heroes Day | Last Monday of August | Regular holiday |
| All Saints' Day | Fixed, November 1 | Special non-working day |
| All Souls' Day | Fixed, November 2 | Special non-working day |
| Bonifacio Day | Fixed, November 30 | Regular holiday |
| Feast of the Immaculate Conception | Fixed, December 8 | Special non-working day |
| Christmas Eve | Fixed, December 24 | Special non-working day |
| Christmas Day | Fixed, December 25 | Regular holiday |
| Rizal Day | Fixed, December 30 | Regular holiday |
| Last Day of the Year | Fixed, December 31 | Special non-working day |

- **The auto-draft.** The job `core.holidayAutoDraft` runs every October 1 at 08:00 Asia/Manila and drafts next year ([Background jobs](../ARCHITECTURE.md#background-jobs)). HR or a System Administrator can also run it from the page for the current or the next year ("Run auto-draft"); that calls the same service directly, not through the worker, and shows how many drafts were added and how many were skipped. Each rule's draft carries `sourceKey` `rule:<key>`, nationwide scope, no legal basis and source `rule`. A run adds a draft only when no holiday of that year, deleted ones included, has that `sourceKey`, so it can run any number of times, and a deleted or moved auto-draft is never drafted again. A rule is also skipped when its date already has a live holiday added by hand or from the online source (HR covered that day before the run); its `sourceKey` stays unused, so a later run drafts it if that day is free again. Another rule's draft on the same date doesn't block it: two rules can fall on one day (Black Saturday and Araw ng Kagitingan are both April 9 in 2039), and both are drafted.
- **The online source** is off unless the server has `HOLIDAY_SOURCE_URL` set ([Environment variables](../DEPLOYMENT.md#environment-variables)). When it is set, each auto-draft run also fetches the year's holidays from it (`{year}` in the URL is replaced by the year, for example `https://date.nager.at/api/v3/PublicHolidays/{year}/PH`), as a Nager.Date-style JSON list (each entry's `date` as `YYYY-MM-DD` and its `name`). Every date with no holiday yet, deleted ones included, becomes a draft with type special non-working day, nationwide scope, no legal basis, source `online` and `sourceKey` `online:<YYYY-MM-DD>`, for HR to check. It matches by date only, and never confirms anything. If the source fails (unreachable, an error answer or a payload that doesn't parse), the failure is logged, the rule-based drafts are still made, and the run's result says the online source failed ([Runbook](../RUNBOOK.md#online-holiday-source-unreachable)).
- **The reminder.** The job `core.holidayReminder` notifies every active HR user and System Administrator (`core.holidaysUnconfirmed`) while a year has no confirmed holidays: on December 1, 8, 15, 22 and 29 at 08:00 Asia/Manila for next year, and every Monday at 08:00 in January and February for the then-current year. Each recipient gets it at most once per year per Manila day (`notify()`'s duplicate check, key `core.holidayReminder:<year>:<Manila date>`). Nothing is sent once that year has a confirmed holiday.
- **Holidays changed.** After a change that touches confirmed holidays commits (confirm, confirm all, declare, or editing or deleting a confirmed holiday), the service enqueues the BullMQ job `core.holidaysChanged` with `{ dates }`, the affected dates as `YYYY-MM-DD`; a move sends both the old and the new date. The worker runs every listener registered with `registerHolidaysChangedListener`. There are none until Phase 2 (Pulse Talent recomputes the DTR for payroll periods not yet finalized, [Cross-module integration](../ARCHITECTURE.md#cross-module-integration)), so in step 1.10 it does nothing. The job is enqueued after the commit, so a crash between the two loses it; this is accepted, and Phase 2 reconciles at payroll finalize. Changes to drafts don't enqueue it.
- **Audit:** module `core`, record type `core.holiday`, labelled `<name> · <YYYY-MM-DD>` (for example `Christmas Day · 2027-12-25`), using the name and date after the change (before it, for a delete). Adding, declaring and each auto-drafted holiday write a `create` entry; editing and confirming write `update` entries; deleting writes a `delete` entry with `after` null. Each is written in the change's transaction. A scheduled auto-draft run writes its entries with no actor (a system action); a run by HR or a System Administrator writes them with that person as the actor ([Audit logging](../../SECURITY.md#audit-logging)).

| Event | When | To | Link |
|---|---|---|---|
| `core.holidayDeclared` | A holiday is declared, in the declare transaction | Every active user except the person declaring it, never the bootstrap system account | `/holidays` |
| `core.holidaysUnconfirmed` | The job `core.holidayReminder`, December 1, 8, 15, 22 and 29 for next year and Mondays in January and February for the current year, 08:00 Asia/Manila, while that year has no confirmed holidays ([Background jobs](../ARCHITECTURE.md#background-jobs)) | Every active HR user and System Administrator | `/holidays` |

- **Clarifications (step 1.10 spec).**
  - `date` is the Manila day at 00:00 stored as UTC, like `employees.separationDate`; `year` is derived from it.
  - `source` (`manual`, `rule` or `online`) and `sourceKey` are fixed once created. Moving an auto-draft to another date keeps its `sourceKey`, which is why it isn't drafted again.
  - A declared holiday has source `manual` and `declared` true. A normal add has `declared` false.
  - The online source treats a date as taken when any holiday of that date exists, deleted ones included, so a holiday HR deleted isn't brought back from the feed either.
  - A move keeps the holiday in its year (`year` never changes after create), so `{ year, sourceKey }` stays valid; to move a holiday to another year, delete it and add a new one.
  - The seeded `core.holidayRules` version is effective from its seed day, so a run on or after that day, the current year included (Going live item 4), uses it.
  - Confirm all enqueues one `core.holidaysChanged` job with every date it confirmed.
  - The type, scope, status and source values are fixed sets in `@pulse/core`: `HOLIDAY_TYPES`, `HOLIDAY_SCOPES`, `HOLIDAY_STATUSES` and `HOLIDAY_SOURCES` ([Constants versus data](../CODE_STYLE.md#constants-versus-data)).
  - Confirm, Confirm all and the auto-draft notify nobody; only a declaration notifies every user, and only the reminder notifies HR and the System Administrator.
- **Not in step 1.10:** an editor for `core.holidayRules` (a new version is added through the configuration store), a restore screen for deleted holidays, unconfirming, how local holidays apply to employees and the DTR recompute (Phase 2), and email notifications. The Home "upcoming holidays" tile is built in step 1.11 ([Home](#home)).

## Shared master data

Pulse Core owns these records. Other modules create and edit them only through Core's service functions (see [Architecture rules](../ARCHITECTURE.md#architecture-rules)). Each record's fields are specified where the record is mainly used:

| Record | Managed from | Fields specified in |
|---|---|---|
| Clients, with sites and contacts | Pulse Engage (basic screens in `/admin` from build step 1.8) | [Clients, sites and contacts](engage.md#clients-sites-and-contacts) |
| Products (`brands` in code) | Engage settings (basic screens in `/admin` from build step 1.8) | [Deals and stages](engage.md#deals-and-stages) |
| Catalog items | Pulse Supply (basic screens in `/admin` from build step 1.8) | [Stock](supply.md#stock) (item kind and fields) and [Warranties](desk.md#warranties-support-contracts-and-subscriptions) (default warranty months) |
| Suppliers | Pulse Supply (basic screens in `/admin` from build step 1.8) | [Suppliers](supply.md#suppliers) |
| Departments and positions | `/admin` | [Departments and positions](#departments-and-positions) |
| Holidays | Holiday calendar | [Holiday calendar](#holiday-calendar) |

Catalog items carry their product, part number, description, unit, item kind (serialized, bulk, or non-stock for services and licenses) and default warranty months (build step 1.8).

### Managing master data

Built in step 1.8, for clients with their sites and contacts, products, catalog items and suppliers. Each record's fields are in the spec the table above links to; this section holds the rules they share. The schemas and services live in `packages/core`, which exports the services, never the models ([ADR 0013](../adr/0013-master-data-schemas-in-core.md)); collections and indexes are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership).

- **Routes:** `/admin/clients` (each client with its sites and contacts), `/admin/products`, `/admin/catalog-items` and `/admin/suppliers`, for the System Administrator only, in the sidebar's Administration group ([Administration area](#administration-area)). The pages use `requireAdminPage('systemAdministrator')` and their Server Actions `adminOnly('systemAdministrator')`; HR and everyone else get the no-access state (HTTP 403). These are basic screens: a list with search, where retired records can be shown to restore them, and create and edit sheets. Engage (Phase 3) and Supply (Phase 4) build their full screens on the same services.
- **Service access.** Each service checks module access itself, because Engage and Supply call the same services later. A System Administrator always passes (Owner on every module, [Resolving and enforcing](../../SECURITY.md#resolving-and-enforcing-build-step-16)).

| Record | List and open | Create and edit | Retire and restore |
|---|---|---|---|
| Clients | Engage Read | Engage Write | Engage Owner |
| Sites and contacts | Engage Read | Engage Write | Engage Write (remove and restore) |
| Products | Engage Read | Engage Owner | Engage Owner |
| Catalog items | Supply Read | Supply Owner | Supply Owner |
| Suppliers | Supply Read | Supply Owner | Supply Owner |

- **Picker options.** Each record type has an option list (id and name, live records only; a catalog item's name is `<product> · <part number>`) that any signed-in user can read, so other modules' forms can offer clients, sites, contacts, products, catalog items and suppliers without that module's access ([Rules](../../SECURITY.md#rules)). It holds nothing else.
- **Retiring** a client, product, catalog item or supplier is a soft delete (`deletedAt` set), never a hard delete, after a confirmation. **Restoring** brings it back unchanged. A retired record can't be edited until it is restored, and can't be picked for a new record (the pickers leave it out and the services refuse it). Existing links to a record retired later are kept and show a "Retired" badge.
- **What blocks a retire.** A product can't be retired while it has live catalog items. A catalog item can't be added to, or restored under, a retired product. Later phases add blockers for the records that use master data (for example open deals from Phase 3), each in its own step.
- **Sites and contacts** are removed with a soft delete and can be restored. None can be added to, or restored on, a retired client. Retiring a client leaves its sites and contacts as they are, and restoring it brings them back with it.
- **Primary contact.** A client has at most one primary contact, held by a partial unique index. Marking a contact primary clears the old one in the same transaction. Removing the primary contact clears its flag, so a restored contact comes back not primary. A client may have no primary contact.
- **Unique names.** Ignoring case (`Verifone` and `verifone` are the same name), retired and removed records included: product names, supplier names, a part number within its product, and a site name within its client. Re-adding a retired name is refused with a message that points to Restore. Client names and TINs aren't unique.
- **Duplicate client names.** When another client, retired ones included, has the same name ignoring case, the form shows a warning under the name field and the save button becomes "Save anyway" ([Feedback & motion](../DESIGN_SYSTEM.md#feedback--motion)). The service runs the same check and refuses the duplicate unless the request confirms it, so a save never skips the warning.
- **Overlapping changes.** As with [departments and positions](#managing-departments-and-positions), a change writes the records it depends on inside its transaction, so an overlapping retire conflicts and is retried: adding or restoring a catalog item writes its product, adding or restoring a site or contact (and marking a primary contact) writes its client, and saving a supplier writes each newly picked product. Nobody ends up with a live catalog item under a retired product, a live site or contact on a retired client, or two primary contacts.
- **Audit:** every create, edit, retire (`delete`, with `after` null), restore, removal (`delete`) and restoration of a site or contact writes its change and its audit entry in one transaction, module `core`. Record types and labels, using the name after the change (before it, for a retire or removal):

| Record type | Label (example) |
|---|---|
| `core.client` | The client's name (`Banco Uno`) |
| `core.clientSite` | `<client> · <site>` (`Banco Uno · Makati Branch`) |
| `core.clientContact` | `<client> · <contact>` (`Banco Uno · Ana Cruz`) |
| `core.brand` | The product's name (`Extreme Networks`) |
| `core.catalogItem` | `<product> · <part number>` (`Extreme Networks · 5320-24T-8XE`) |
| `core.supplier` | The supplier's name |

- None of these fields is [sensitive personal data](../../SECURITY.md#sensitive-data). Client and supplier TINs are company data, like the company TIN: shown in full and kept in audit snapshots.
- **Not in step 1.8:** stock locations (step 4.4), Engage's and Supply's own screens (Phases 3 and 4), and the blockers later phases add.

## Approvals

The approvals engine (build step 1.9) supports three kinds of step:

- **Routed to `reportingTo`:** any one supervisor decides (see [Reporting lines](#reporting-lines)).
- **Any one of a set:** for example, any one Board of Directors member.
- **All of a set:** for example, both payment approvers.

A return or a rejection always needs remarks. A step whose only approver is the requester goes to the System Administrator (see [Reporting lines](#reporting-lines)). Approvers can open what they're asked to approve read-only, even without module access (see [Exceptions to module access](../../SECURITY.md#exceptions-to-module-access)).

Every approval in the app, for reference. The linked section is the rule; this table is only an index.

| Request | Approved by | Rule |
|---|---|---|
| Timesheet | Any one supervisor, then HR | [Submission & approval](talent.md#submission--approval) |
| Leave, offset time off | Any one supervisor. HR if the requester has an empty `reportingTo`; the System Administrator for HR's own request | [Leave](talent.md#leave), [Offset time off](talent.md#offset-balance--offset-time-off) |
| Employee record change | HR or any one supervisor; sensitive fields HR or System Administrator only, and for HR staff a Board member or the System Administrator (build step 2.6, `talent.changeRequest`) | [Self-service & record changes](talent.md#self-service--record-changes), [Onboarding checklist and change requests](talent.md#onboarding-checklist-and-change-requests-build-step-26) |
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

Built in step 1.9 (the engine and the [Approvals list](#approvals-list); each module wires its own requests in its own step):

- **Approval types.** A module registers each kind of request it sends for approval with Core's `registerApprovalType`: its name (`<module>.<name>`), its steps, the decisions it allows, what an empty step does, and its hooks. Submitting an unregistered type is refused. The module submits a request with `submitApproval()` inside its own transaction, so the request commits or rolls back with the module's change. Modules never read or write `approvalRequests` themselves ([Cross-module integration](../ARCHITECTURE.md#cross-module-integration)).
- **Stored** in `approvalRequests`, one record per submission, written only by the engine and never deleted (no soft delete). A request holds its type, its module, the record it is about (type, id and label), a title, a summary, a link to the record, the requester (user and employee), its status (`pending`, `approved`, `returned` or `rejected`), the current step, the request it follows (`previousRequestId`, for a resubmission), when it was submitted and settled and who settled it, and a `version` that guards against overlapping decisions. Each step holds its kind, a label, its rule (any one or all), its approvers (each user with their name as it was at submit), whether it was routed to the System Administrator, its status (`waiting`, `pending`, `approved`, `returned`, `rejected` or `skipped`) and its decisions (who, which decision, remarks and when). Fields and indexes are in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership).
- **One pending request per record.** A record has at most one pending request at a time, held by a partial unique index.
- **Step kinds.** `reportingTo`: the requester's supervisors, each mapped to their active user account. `anyOf`: any one of a set, for example the Board of Directors members. `allOf`: every one of a set, for example the payment approvers. A type lists its steps in order.
- **Approvers are fixed at submit.** Each step's approvers are worked out when the request is submitted: inactive and separated people are left out, and the requester is removed from every set. After that they don't change: a later change to `reportingTo` or to a set doesn't re-route a pending request. Re-routing a stuck pending request is not built in step 1.9.
- **The requester never decides.** When the requester was a step's only approver (or every approver in it), the step goes to every active System Administrator as an any-one step, never to the requester, and is marked as routed to the System Administrator. In an all-of step where the requester is one of the set, any one System Administrator fills the requester's place. If no System Administrator other than the requester is active, the submit is refused with a clear message. "The System Administrator" here means any one active System Administrator, the bootstrap system account included while it is enabled.
- **Empty steps.** A step left with nobody for another reason (no one listed, or everyone listed inactive) follows the type's `whenEmpty` rule: skip the step (status `skipped`), send it to HR, or send it to the System Administrator. A type without the rule refuses the submit.
- **Decisions:** approve, return and reject. Each type declares which it allows; timesheets, payroll runs and payments allow approve and return only. A return or a rejection needs remarks, up to 1,000 characters. Only a named approver of the pending step can decide.
- **Any-one steps.** The first decision settles the step. The other approvers are notified that it was settled by that person and that no action is needed, and the request moves from their Waiting list to Decided.
- **All-of steps.** Every approver must approve, in any order. Any return or rejection ends the request.
- **Next step.** When a step is approved, the next step becomes pending and its approvers are notified. When the last step is approved, the request is approved.
- **Returned and rejected requests are final.** They are never reopened. To try again, the module submits a new request linked to the old one (`previousRequestId`), which starts again from the first step; the old request and its decisions stay as history.
- **Overlapping decisions.** When two decisions overlap, exactly one wins. A decision from a form loaded before the request last changed is refused.
- **Hooks.** A type registers `onSettled` (the request was approved, returned or rejected), and optionally `onStepApproved` (a step was approved) and `outcomeRecipients` (who hears the outcome). Decisions call the module's hooks inside the engine's transaction, so the module updates and audits its own record together with the decision. A hook that throws rolls back the decision, its audit entry and its notifications.
- **Notifications** are sent in the transaction of the submit or decision that causes them, as in-app [notifications](#notifications). The outcome goes to the requester, unless the type names its own `outcomeRecipients` (for example Accounting for a payment, see [Payments](fiscal.md#payments-disbursements)).

| Event | When | To |
|---|---|---|
| `core.approvalRequested` | A step becomes pending: at submit, or when the step before it is approved | The step's approvers |
| `core.approvalSettled` | A decision takes the item from approvers who didn't decide: an any-one step is decided, a System Administrator fills the requester's place in an all-of step, or an all-of step is returned or rejected | The approvers it takes the item from (the any-one step's other approvers, the other System Administrators who could fill the place, or the all-of step's approvers still pending): settled by that person, no action needed |
| `core.approvalApproved` | The last step is approved | The requester, or the type's `outcomeRecipients` |
| `core.approvalReturned` | The request is returned | The requester, or the type's `outcomeRecipients` |
| `core.approvalRejected` | The request is rejected | The requester, or the type's `outcomeRecipients` |

- **Audit:** module `core`, record type `core.approvalRequest`. Submitting writes a `create` entry, and each decision an `update` entry with its remarks as the reason, in the same transaction ([Audit logging](../../SECURITY.md#audit-logging)). No new audit action is added. The module's hook writes the entry for its own record.
- **Who can see and decide.** The services check the person, not module access: deciding needs a named approver of the pending step; reading a request needs one of its approvers (current or past), its requester, or a System Administrator. Anyone who is or was an approver on any request for a record may also open that record read-only, while the request is pending and afterwards; each module checks this beside its module access ([Exceptions to module access](../../SECURITY.md#exceptions-to-module-access)).
- **Development script.** `pnpm dev:approval --requester <email> --step supervisors|board|all:<email,email>|self` submits a sample request of the type `dev.sample` from the requester: to their supervisors, to any one Board member, to all of the listed users, or to a step whose only approver is the requester. It runs in development only and refuses in production, where `dev.sample` isn't registered. It is how step 1.9's "Done when" is checked before any module sends requests.
- **Clarifications (step 1.9 build).**
  - An approval may carry optional remarks; a return or a rejection must.
  - `whenEmpty` "hr" makes the step an any-one step to every active HR user but the requester (and to the System Administrator when the requester is the only active HR user).
  - When every step is skipped, the request is stored as approved at submit; no hook runs and no one is notified, and the module acts on the returned status.
  - A step's approvers only count as having been asked (for the Decided list, reading the request and the read-only record exception) once that step becomes pending.
  - In an all-of step, the System Administrators who may fill the requester's place are stored as approvers marked "as System Administrator"; the first of them to approve fills it, and the others are told it was settled. When an all-of step is returned or rejected, the approvers still pending are also told it was settled.
  - Audit label for `core.approvalRequest`: `<type label> · <record label>` (for example `Leave · LV-0001`).
  - **Decided list.** A request is listed under Decided for the user once their part in a step has ended: they decided it, another approver settled the any-one step, another System Administrator filled the place in an all-of step they were also asked to fill, or the request was returned or rejected while they were still pending. This holds whatever the request's status, so a request pending at a later step is listed too. Each decision records, for the decider and for every approver it takes the item from, when their part ended (`decidedFor` in [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership)). Decided is sorted by the user's latest such time, newest first, ties broken by the request's id, and "Load more" pages in that order. It isn't sorted by `settledAt`, which stays empty while a later step is pending. Nothing ever leaves both Waiting for you and Decided.
  - A decision on a request the person may not read (see "Who can see and decide") gets the same answer as one on a request that doesn't exist, so ids can't be probed. Its requester, or a System Administrator, who isn't an approver is told they aren't an approver.
  - `onStepApproved` also runs for the last step: first `onStepApproved`, then `onSettled`, both in the decision's transaction.
  - The `dev.sample` type has no `whenEmpty` rule, so `pnpm dev:approval --step supervisors` is refused for a requester with no active supervisors.
  - Every approval notification links to `/approvals?request=<id>`. Titles: "Approval needed: <title>", "Settled by <name>, no action needed", "Approved: <title>", "Returned: <title>", "Rejected: <title>"; the outcome's body names who decided and carries the remarks. A request's title and summary must never hold a sensitive field.
- **Not in step 1.9:** each module's own requests (their steps), withdrawing a pending request, re-routing a stuck one, a "My requests" view, e-signatures on decisions (build step 2.2, below), background jobs and seed data. The Home "approvals waiting" tile is built in step 1.11 ([Home](#home)).
- **E-signatures on decisions** (build step 2.2):
  - **The signer.** Core can't import Pulse Talent, so Talent registers the one signer with `registerApprovalSigner`, an explicit call made by the approvals Server Action (`registerTalentApprovalSigner()`).
  - **What signs.** An **approve** decision calls the signer in the decision's transaction. The signer applies the approver's own current e-signature, through Talent's owner-only `applyESignature`, and returns a stamp `{ applicationId, signatureId, version }`. The engine stores the stamp on the decision (`steps[].decisions[].signature`) and passes it to the hooks (`decision.signature`). Return and reject sign nothing.
  - **Fail closed.** With no signer registered, an approve is refused. A signer that throws rolls the decision back.
  - **No signature on file.** Until step 2.6, an approver with no signature (and the bootstrap system account, which has none) still approved, and the decision stored `signature: null`. From build step 2.6 Talent's signer refuses an approver who has an employee but no signature, with the onboarding gate's message ("Complete this onboarding item first: E-signature…"), so the decision rolls back. The engine is unchanged: the refusal is the signer throwing. The bootstrap system account still approves, with `signature: null` ([Onboarding checklist and change requests](talent.md#onboarding-checklist-and-change-requests-build-step-26)).
  - **The inspector** shows "Signed with e-signature, version N" or "Approved without an e-signature", as text; the image isn't shown.
  - **Replacing a signature** leaves earlier decisions on the version they were signed with ([Documents, photo, e-signature and certifications](talent.md#documents-photo-e-signature-and-certifications-build-step-22)).

### Approvals list

Built in step 1.9, at `/approvals`. It is a Pulse Core page, open to every signed-in user with no module access needed ([Rules](../../SECURITY.md#rules)); what each person sees is checked by the services above.

- **Sidebar:** Approvals sits in the Pulse Core group after Home, with a badge counting the requests waiting for the user (read as "3 waiting", see [Layout & components](../DESIGN_SYSTEM.md#layout--components)). The breadcrumb reads "Pulse Core › Approvals".
- **Segments:** **Waiting for you** (requests whose pending step names the user) and **Decided** (requests where the user's part in a step has ended: they decided it, someone else settled it, or the request was returned or rejected), newest first by when their part ended. A request shows under Decided as soon as the user's part in a step ends, even while a later step is still pending; its row and inspector then show its current status and step. A request that asks the user again at a later step shows in both segments.
- **Rows:** the type's label, the title, the requester, when it was submitted, the step's label, the progress of an all-of step ("1 of 2 approved"), and "Sent to you as System Administrator" when the step was routed to the System Administrator.
- **Inspector:** selecting a row opens the inspector (a full-height sheet on a phone) with the steps, their approvers and decisions, a link to the record, and Approve, Return and, when the type allows it, Reject. Return and Reject show a required remarks field inline. ⌘↵ or Ctrl+Enter approves. `?request=<id>` opens a request directly; notifications link there.

## Notifications

- All notifications are delivered in-app through Pulse Core (email later, once the email system ships). Each user has a notification list with an unread badge.
- Pulse Core's own events: HR and the System Administrator hear about new users, users still needing access (daily) and position changes to review ([User access page](#user-access-page)), and company details that are still placeholders ([Company details](#company-details-pending-from-the-client)). Every user is notified of ad-hoc holiday declarations (`core.holidayDeclared`), and HR and the System Administrator get the weekly reminder while a year's holidays aren't confirmed (`core.holidaysUnconfirmed`, from build step 1.10) ([Holiday calendar](#holiday-calendar)). From build step 1.9 the approvals engine sends the approval events for every module: a request waiting for an approver (`core.approvalRequested`), a step settled by another approver (`core.approvalSettled`), and the outcome (`core.approvalApproved`, `core.approvalReturned`, `core.approvalRejected`) ([Approvals](#approvals)).
- Each module lists its own events in its spec, for example [Pulse Talent notifications](talent.md#notifications).

Built in step 1.3:

- **Stored** in `notifications`, one record per recipient: the recipient, the module (`core` or a module key), the event (`<module>.<name>`, for example `core.holidayDeclared`), a title, an optional body, a link, the record it is about (optional) and `readAt` (null while unread). Titles are capped at 200 characters and bodies at 1,000, as plain text.
- **The link is always a path inside the app**: it starts with a single `/`, with no `//` or `\` anywhere and no spaces. A full URL or a `//host` link is refused, so a notification can never send someone off-site.
- **Sending.** Modules call Core's `notify()` service, never the collection, inside their own transaction when the event comes from a change (so the notification commits or rolls back with it). The company details reminder (step 1.4) does its own check, skipping a recipient who already got it that Manila day ([Company settings page](#company-settings-page)).
- **Duplicate check** (build step 1.7). `notify()` takes an optional `dedupeKey`: a string of up to 200 characters, fixed once stored, for example `core.accessReminder:2026-10-05`. A recipient who already has a notification with that key is skipped. A unique index on the recipient and the key (only where a key is set) holds when two sends overlap; outside a transaction, a send that hits it is skipped rather than failing. The daily access reminder uses it ([User access page](#user-access-page)).
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
