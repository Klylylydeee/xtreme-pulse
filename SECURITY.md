# Security

This file covers how Xtreme Pulse keeps people out and data in: network exposure, sign-in, roles, module access, sensitive data, secrets and audit logging. Every page, Server Action and Route Handler must follow it. Reviews at the end of each phase check the code against the [review checklist](#review-checklist).

## Reporting a security issue

Xtreme Pulse is an internal application. If you find a vulnerability, a data leak, or someone seeing data they shouldn't, report it privately and directly to the System Administrator (normally the Web Administrator – Developer). Don't report it in shared chats, tickets or commits. Include what you saw, where, and when.

- **Contact:** _to be filled in (name and a private channel)_
- A suspected leak of personal data may also trigger obligations under the Data Privacy Act (see [COMPLIANCE.md](docs/COMPLIANCE.md#open-questions)).

## Network exposure

Xtreme Pulse is an **internal application**, reachable only on the office network or via VPN. It is never exposed to the public internet.

Several rules below depend on this, so exposing the app beyond the office network or VPN requires revisiting them first (see [ADR 0004](docs/adr/0004-password-only-auth-on-internal-network.md)).

## Account & access

### Sign-in and passwords

- Sign-in is restricted to these email domains: **`@xtreme-works.com`**, **`@gmail.com`**, **`@yahoo.com`**. Keep the list in one config constant (`ALLOWED_EMAIL_DOMAINS`). Normalize emails to lowercase and reject any other domain, both at sign-in and when creating a user.
- No self-registration. An email can only sign in if it belongs to an existing user created by HR or the System Administrator with an active account status; a valid domain alone is never enough.
- **Password login only.** No Google, Yahoo or other third-party sign-in.
- Hash passwords with argon2id (or bcrypt); never store, log or return plain-text passwords.
- New accounts get a temporary password from HR or the System Administrator, who can also reset any user's password. Only a System Administrator can reset a System Administrator's password. Users must change a temporary password on first sign-in.
- **Forgot password (later phase, not a priority):** a "Forgot password?" link on the login page lets users reset their own password by email.
  - Needs an email system (e.g. Nodemailer over SMTP). Keep sending behind one `packages/core` email service so the provider can change.
  - Reset tokens are random, single-use, expire after 1 hour, and are stored hashed, never in plain text.
  - Always show the same response whether or not the email exists, so the form can't be used to discover accounts.
  - The reset link points to the internal URL, so users must be on the office network or VPN to open it.
  - Until this ships, HR or the System Administrator handles resets.
- No MFA, account lockout or login-history tracking: the app is internal and reachable only on the office network or via VPN.
- A session lasts **24 hours** from sign-in. After that the user signs in again. Keep the length in one config constant (`SESSION_MAX_AGE_HOURS`); it can be made longer, never shorter. The status check on every request still signs a deactivated user out at once (see [Account status](#account-status)).

### Account status

- Account status is derived from employment status, never set independently (except the bootstrap system account, see [Bootstrap System Administrator account](docs/modules/core.md#bootstrap-system-administrator-account)):

```typescript
export const EMPLOYMENT_STATUS = {
  Probationary: "active",
  Regular: "active",
  Contractual: "active",
  Resigned: "deactivated",
  Terminated: "deactivated",
  Retired: "deactivated",
} as const;

export type EmploymentStatus = keyof typeof EMPLOYMENT_STATUS;
export type AccountStatus = (typeof EMPLOYMENT_STATUS)[EmploymentStatus];
```

- Deactivated users cannot sign in. Check account status on every request so a deactivated user is signed out immediately (JWT sessions cannot be revoked on their own).
- Deactivated users are never deleted; their records, approvals, signatures and audit history remain.

## Roles

Most rights come from [module access](#module-access-rwo). A few people also hold a role that the spec names directly:

| Role | Who | What it adds |
|---|---|---|
| System Administrator | Granted only by another System Administrator (see below) | Full access to everything |
| HR | Members of the Human Resource department (`HR`) | Creates users, sets module access, resets passwords (except a System Administrator's), approves at the HR step, and sees sensitive data |
| Accounting | Members of the Accounting department (`ACCT`) | Sees sensitive data per the [Sensitive data](#sensitive-data) rules, and the peso cost of overtime on projects |
| Board of Directors | Members of the Board of Directors department (`BOD`) | Approves payroll runs, final pay and POs; sets `reportingTo`; changes HR staff's pay and bank details; sees company-wide figures in Insight (the Board exception) |
| Managing Director, Sales Director | Those positions (a setting) | Both approve every payment ([Payments](docs/modules/fiscal.md#payments-disbursements)) |
| Supervisor | Anyone in an employee's `reportingTo` | Approves that employee's requests ([Reporting lines](docs/modules/core.md#reporting-lines)) |
| Department head | Set per department | Receives escalations such as SLA breaches ([Departments and positions](docs/modules/core.md#departments-and-positions)) |

The HR, Accounting and Board roles follow the employee's department. Moving someone into or out of one of these departments changes their role from their next request. Their module access doesn't change with it (see [Rules](#rules)).

Record-level roles, such as deal owner, deal team, project lead, project team and the delivering employee on a receipt, are defined in each module spec.

### System Administrator

- The **System Administrator** role is granted only by an existing System Administrator (the first one is the bootstrap account); HR cannot grant it. It is normally given to the Web Administrator – Developer, but never automatically: a new Developer account starts with no module access like every other new user.
- Manages user accounts (create, reset password, deactivate), module access (shared with HR), departments and positions, allowed email domains, and system-wide settings.
- The System Administrator has **full access to everything**, including sensitive data (salary, payslips, government IDs, bank accounts, 201 files, disciplinary cases). Revealing and changing sensitive data is still audit-logged like any other user.

## Module access (RWO)

Every user account has an access level for each ERP module, stored on the account in Pulse Core.

| Level | Code | Allows |
|---|---|---|
| None | `-` | Module hidden from the sidebar; all of its pages and actions are blocked |
| Read | `R` | View the module's records |
| Write | `W` | Read + create and edit records |
| Owner | `O` | Write + approve the module's own approvals (those not routed through `reportingTo` and not reserved for the Board of Directors, such as payroll runs, purchase orders and payments), cancel/void, delete (soft), and manage the module's settings and reference data |

```typescript
export const MODULES = ["engage", "ops", "supply", "desk", "fiscal", "talent", "insight"] as const;
export type ModuleKey = (typeof MODULES)[number];

export const ACCESS_LEVELS = ["none", "read", "write", "owner"] as const; // cumulative, lowest to highest
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export type ModuleAccess = Record<ModuleKey, AccessLevel>; // missing module = "none"
```

### Rules

- Levels are cumulative: None < Read < Write < Owner.
- Pulse Insight is read-only, so it only takes None or Read. Insight dashboards show only data from modules the user has at least Read access to, except Board of Directors members with Insight Read, who see company-wide totals for every module, even modules where they have None (see [Who sees what](docs/modules/insight.md#who-sees-what)). Setting Insight targets (the yearly revenue target and the SLA compliance target) is limited to Board of Directors members with Insight Read and the System Administrator. It needs no Owner level (Insight has none).
- Pulse Core (sign-in, home, own profile, directory, org chart, notifications) is open to every active user and has no access level. Its administration area is HR and System Administrator only.
- **New users start with no module access.** When an account is created, every module is set to None, so the user sees only Pulse Core (home, own profile, directory, org chart, notifications) and self-service. **HR or the System Administrator** then sets the user's access per module on the [User access page](docs/modules/core.md#user-access-page).
- On a position change, HR and the System Administrator are prompted to review the user's access; access is never changed automatically.
- No one can change their own module access. HR cannot change the System Administrator's access.
- The System Administrator always has Owner on every module (Read on Insight, which has no Owner level); this cannot be lowered.
- Enforce on the server in every page, Server Action and Route Handler with one helper (e.g. `requireModuleAccess("fiscal", "write")`). Hiding a sidebar item or button is never access control on its own.
- Module access never overrides the [Sensitive data](#sensitive-data) rules: Talent Read or Write does not reveal salary, payslips, government IDs, bank accounts, 201 files or disciplinary cases.
- Every access change is audit-logged (module, old level, new level, changed by).

### Exceptions to module access

These actions don't need module access. Each one still needs a server-side check that the user is the right person, such as the assigned technician, the named approver, or the employee viewing their own record.

- **Self-service is outside module access.** Every active user can always view their own record, submit change requests, fill in and submit their timesheet (time entries, activities, overtime or offset, reimbursements), file leave and offset time off, view their own project assignments, file daily site reports and complete checklists for the projects they're assigned to, sign delivery receipts they're named on as the delivering employee, file service reports for support visits they're assigned to, view their own payslips, request a COE, reply to notices addressed to them, and use the directory and org chart, even with no Pulse Talent access.
- **Approvals through `reportingTo` are outside module access.** A supervisor can approve their team's leave, offset time off, timesheets, quotations and purchase requests regardless of their module access level. For a quotation, the approver can open that deal's detail page read-only while the approval is pending and afterwards, even if they aren't on the deal team. For a purchase request, the approver can open it read-only.
- **Deal owners can follow their projects.** The owner of a won deal can open the project created from it read-only, even without Pulse Ops access.
- **PO approvers can open the PO.** A Board of Directors member asked to approve a purchase order can open it (and its linked purchase requests and project summary) read-only, even without Pulse Supply access.
- **Payment approvers can open the payment.** The Managing Director and the Sales Director, when asked to approve a payment, can open it, with its supplier bills and supporting documents, read-only, even without Pulse Fiscal access.
- **Confirming non-stock purchases.** When a bill includes non-stock PO lines (services, subcontractors, licenses), the project lead confirms that the work or item was delivered, or returns it with remarks, from their Approvals list or on the project. For a PO with no project, the purchase request's requester confirms the same way. When the PO links several purchase requests, any one of their requesters can confirm, and the first decision settles it (as with any one supervisor). The confirmer can open that PO and bill read-only, even without Pulse Supply or Pulse Fiscal access.

## Sensitive data

These rules apply the Data Privacy Act of 2012 (RA 10173). See also [COMPLIANCE.md](docs/COMPLIANCE.md#data-privacy-act-of-2012-ra-10173).

- Salary, allowances, payslips, government IDs, bank accounts, medical certificates, 201 file documents and disciplinary cases are sensitive personal information.
- Encrypt these fields at rest (MongoDB Client-Side Field Level Encryption or Queryable Encryption); store 201 files, receipts, medical certificates and payslip PDFs in the private [file storage](docs/ARCHITECTURE.md#file-storage) folder, served only after an access check.
- Access limited to HR, Accounting and the System Administrator (and the employee viewing their own record). Module access levels do not change this. Board of Directors members see payroll run totals and per-employee net pay when approving a run, and disciplinary cases as described in [Termination due process](docs/modules/talent.md#termination-due-process).
- Board of Directors members can also view and change the salary, allowances, government IDs and bank accounts of employees in the HR department, because HR can't change these for their own department (see [Self-service & record changes](docs/modules/talent.md#self-service--record-changes)).
- Medical certificates are visible to the employee, HR, the System Administrator, and the approving supervisor for that request only.
- Mask in the UI by default (show last 4 digits); revealing the full value is audit-logged.
- Never log, cache or send these fields to analytics or Pulse Insight in raw form.

**Encryption choice:** automatic or explicit field encryption depends on the MongoDB edition. Build step 0.8 settles it and records the choice in [ADR 0005](docs/adr/0005-field-level-encryption.md).

## Secrets

- Real values live in `.env.local` locally and in the server environment in production. They never go in the repo, the docs, seed files or logs. `.env.example` lists every variable name without a value (see [Environment variables](docs/DEPLOYMENT.md#environment-variables)).
- `SEED_ADMIN_PASSWORD` is only needed for the first run of `pnpm seed:admin`. Remove it from the server environment once the System Administrator has signed in and changed the password.
- `FIELD_ENCRYPTION_LOCAL_KEY` must be a new value on the real server, with a safe copy kept outside the server. Encrypted fields can't be read without it (see [Runbook](docs/RUNBOOK.md#encryption-key-lost-or-changed)).
- `AUTH_SECRET` is a long random value. Changing it signs everyone out.
- Never log, cache or return passwords, reset tokens, session secrets, or the fields listed under [Sensitive data](#sensitive-data).

## Audit logging

Every create, update and delete on business records writes an audit log entry (see [Architecture rules](docs/ARCHITECTURE.md#architecture-rules)). The entry format is in [Audit log](docs/modules/core.md#audit-log). The security-relevant events, and where each rule lives:

- Module access changes: module, old level, new level, changed by ([Rules](#rules))
- Revealing or changing a sensitive field. Log the field name, never the value ([Sensitive data](#sensitive-data))
- Exports of sensitive data ([HR reports](docs/modules/talent.md#hr-reports))
- Changing or applying an e-signature ([Profile photo & e-signature](docs/modules/talent.md#profile-photo--e-signature))
- Manual payroll entries, with old value, new value, reason and author ([Manual inputs & adjustments](docs/modules/talent.md#manual-inputs--adjustments))
- Opening balances at go-live ([Opening balances at go-live](docs/modules/talent.md#opening-balances-at-go-live))
- Password changes and resets, logged without the password

## Development-only pages

`/dev/ui` (the design tokens and components) and `/dev/health` (database, Redis, worker, storage and encryption checks) exist only in development. They are never served in production builds.

## Review checklist

Use this list in every phase review and in the whole-app review (build step 7.8). Each item points to its rule.

- [ ] Every page, Server Action and Route Handler calls `requireModuleAccess`, or is one of the [exceptions](#exceptions-to-module-access) with its own check.
- [ ] Record-level visibility (deal team, project team, project costs, confidential cases) is enforced on the server, and hidden data is never sent to the browser.
- [ ] Account status is checked on every request ([Account status](#account-status)).
- [ ] All input is validated with Zod ([Architecture rules](docs/ARCHITECTURE.md#architecture-rules)).
- [ ] Sensitive fields are encrypted, masked in the UI, and never raw in logs, Insight or snapshots ([Sensitive data](#sensitive-data)).
- [ ] Uploaded and generated files are in `storage/`, never under `public/` or in Git, and open only through the access-checked file route ([File storage](docs/ARCHITECTURE.md#file-storage)).
- [ ] Every mutation is audit-logged ([Audit logging](#audit-logging)).
- [ ] No secrets in the diff, and `/dev/*` pages are excluded from production builds.

## Open questions

None right now. The four questions raised when the spec was split were answered on September 25, 2026:

1. The HR, Accounting and Board roles come from the employee's department ([Roles](#roles)).
2. Only a System Administrator can reset a System Administrator's password ([Sign-in and passwords](#sign-in-and-passwords)).
3. Pay and bank details of HR staff are changed only by the System Administrator or a Board member ([Self-service & record changes](docs/modules/talent.md#self-service--record-changes)).
4. Sessions last 24 hours ([Sign-in and passwords](#sign-in-and-passwords)).

Add new questions here as they come up, with the build step that needs the answer.
