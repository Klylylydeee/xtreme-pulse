# Pulse Core (Platform)

Pulse Core is the platform every module builds on. It covers sign-in, user accounts, system administration, the company directory and org chart, the holiday calendar, shared master data, approvals, notifications, the audit log and company settings.

Built in [Phase 1](../BUILD_PLAN.md#phase-1-pulse-core). Routes: the login page, Home (`/`) and administration (`/admin`). Package: `packages/core`.

Sign-in, passwords, account status, module access and the System Administrator role are security rules, so they live in [SECURITY.md](../../SECURITY.md).

## People data ownership

Every user is an employee of Xtreme Works (the only exception is the bootstrap system account). Pulse Core owns the user account and org structure (login, account status, module access, department, position, reporting lines, directory, org chart). Pulse Talent owns employment, government, payroll, timesheet and document details. Both reference the same `employeeId`.

## Bootstrap System Administrator account

- A fresh install has no users, so a seed script creates the first System Administrator: `pnpm seed:admin` (`scripts/seed-admin.ts`).
- Default login email: **`sysadmin@xtreme-works.com`**.
- The script reads the email and initial password from environment variables `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. **Never commit the password** to the repo, these docs, seed files or logs.
- The account must change its password on first sign-in.
- It is a **system account**, not an employee: no employee number or employment status, always active unless another System Administrator disables it, and excluded from the directory, org chart, onboarding, timesheets, payroll and reporting lines.
- The script is idempotent in two parts. If a System Administrator already exists, it skips creating one. Base data loaders insert only what is missing and never overwrite existing records, so base data for modules built later can be added to an existing database (for example during a staged go-live).
- The same seed run loads base data: allowed email domains, departments and positions (see [Departments and positions](#departments-and-positions)), leave types, payroll settings (cut-offs, daily rate factor), contribution tables, holiday premium rates, regional minimum wage rates (NCR), the default work schedule, the internet allowance, HR document templates, and company settings placeholders.

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
- Each department has an optional **department head** (an employee, set by HR or the System Administrator), used for escalations such as Desk SLA breaches. If none is set, escalations go to the Operations Director.
- **Position is not permission.** Positions carry no module access; access is set and checked per user (see [Module access](../../SECURITY.md#module-access-rwo)).
- Each position also has a **timesheet type** (`overtime` or `standard`, see [Timesheet types](talent.md#timesheet-types)), set by HR or the System Administrator.

## Reporting lines

- `reportingTo` is an **array** of employee IDs: an employee can have one or multiple supervisors.
- An employee cannot report to themselves, and reporting chains must never form a cycle (validate on save).
- Top-level Board of Directors members may have an empty `reportingTo`.
- Only **HR, Board of Directors members and the System Administrator** can set or change `reportingTo`. Employees and supervisors cannot.
- Approval workflows (leave, offset time off, timesheets, purchase requests, quotes, employee record changes, regularization) route through `reportingTo`.
- **Any one supervisor can decide.** When an employee has multiple supervisors, the request goes to all of them, and the first approval or rejection settles it. The other supervisors are notified of the outcome and can no longer act on it.
- No one approves their own request. When the only approver in a step is the requester (e.g. the HR Officer's own timesheet at the HR step), the step goes to the System Administrator.

## Employee number (company ID)

- Format **`YYYY-NN`**: hire year + sequence within that year. Example: the first employee hired in 2027 is `2027-01`, the second is `2027-02`.
- The year comes from the date hired. The sequence restarts at 01 each year, is always 2 digits, and has a **maximum of 99 per year**. Creating a 100th hire in the same year fails with a clear error for HR.
- Generate atomically with a per-year counter (`findOneAndUpdate` with `$inc` and `upsert`) so two hires can never get the same number.
- Assigned once, immutable, never reused, even after separation.
- When HR adds a current employee who already has a company ID, HR enters it manually; that year's counter is raised to at least that sequence so it is never issued again.

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
- **New user's home:** a user with no module access sees a short message on the Pulse Core home, e.g. "Your access is being set up. HR will give you access to the modules you need." Self-service stays available.
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

## Audit log

The audit log is append-only. Each entry records the actor, module, record, action, old and new values, and a reason (build step 1.3). The System Administrator browses it from `/admin`. What must be logged is listed in [Audit logging](../../SECURITY.md#audit-logging).

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
