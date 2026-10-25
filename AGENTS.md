# AGENTS.md

Instructions for AI coding agents working on Xtreme Pulse, the internal ERP for Xtreme Works (a Philippine systems integrator). People should start with [README.md](README.md).

This file is short on purpose. It says where the rules are. The rules themselves live in the linked docs.

## Commands

<!-- Fill in once the repo is scaffolded -->
- `pnpm dev` — run the app
- `pnpm lint` / `pnpm typecheck` / `pnpm test`
- `pnpm seed:admin` — create the bootstrap System Administrator and base data, from step 2.3 including the Talent payroll settings, from step 2.4 the company work schedule and timesheet settings, from step 2.5 the reimbursement settings, from step 2.6 the onboarding required documents, from step 2.8 the leave settings, from step 2.9 the payroll run settings, and from step 2.11 the remittance settings (safe to run again: it skips an existing System Administrator and adds only missing base data)
- `pnpm recover:admin` — from step 1.7, re-enable the bootstrap system account when no System Administrator is active ([RUNBOOK.md](docs/RUNBOOK.md#the-only-system-administrator-is-disabled))
- `pnpm dev:approval --requester <email> --step supervisors|board|all:<email,email>|self` — from step 1.9, development only (refuses in production): submit a sample approval request ([Approvals](docs/modules/core.md#approvals))
- `pnpm dev:expiry-alerts [--date YYYY-MM-DD]` — from step 2.2, development only (refuses in production): run the 201 document and certification expiry alert job once, as of today or the given Manila date ([Documents, photo, e-signature and certifications](docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22))
- `pnpm dev:timesheet-reminders [--date YYYY-MM-DD]` — from step 2.7, development only (refuses in production): run the timesheet reminder job once, as of today or the given Manila date ([Timesheet approval, the DTR and the offset balance](docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27))
- `pnpm dev:leave-credits [--date YYYY-MM-DD]` — from step 2.8, development only (refuses in production): run the leave credit job once, as of today or the given Manila date ([Leave, offset time off and opening balances](docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28))
- `pnpm dev:payroll-drafts [--date YYYY-MM-DD]` — from step 2.9, development only (refuses in production): run the draft payroll job once, as of now or 5:00 AM Manila on the given date ([Payroll run computation](docs/modules/talent.md#payroll-run-computation-build-step-29))
- `pnpm dev:remittance-reminders [--date YYYY-MM-DD]` — from step 2.11, development only (refuses in production): run the remittance reminder job once, as of today or the given Manila date ([Employer contributions and remittances](docs/modules/talent.md#employer-contributions-and-remittances-build-step-211))

`pnpm test` runs the committed automated tests: the sensitive-data guard tests, from step 1.3 the audit log, notification and sensitive reveal tests, from step 1.4 the departments, positions, company settings, reminder, allowed email domain, upload settings and company logo route tests, from step 1.5 the employee number, reporting line, user, user account schema, employee model, session and temporary password tests, from step 1.6 the module access level, effective access, file access and navigation tests, from step 1.7 the user access, access reminder, duplicate notification, access-change notification, system account disable and enable, and admin recovery tests, from step 1.8 the master data tests, from step 1.9 the approvals tests, from step 1.10 the holiday calendar and worker job wiring tests, from step 1.11 the directory, org chart and command bar tests, from step 2.1 the employee record tests, from step 2.2 the document, e-signature and certification tests, from step 2.3 the payroll settings, allowance and minimum wage tests, from step 2.4 the timesheet and work schedule tests, from step 2.5 the reimbursement and receipt claim tests, from step 2.6 the onboarding and change request tests, from step 2.7 the timesheet approval, DTR, offset and reminder tests, from step 2.8 the time off, leave balance, crediting, opening balance and leave credits job tests, from step 2.9 the payroll run engine, payroll run settings, payroll run model, payroll run service and payroll drafts job tests, from step 2.10 the payroll review, manual entry, flag acknowledgement, payroll approval, payroll register, payslip and payslip PDF job tests, and from step 2.11 the remittance engine and upload format, remittance settings, remittance model, remittance service, go-live month, remittance reminders job and generated text file tests. Everything else is still checked by hand (see [TESTING.md](docs/TESTING.md#what-happens-today)).

## How to work

- **One build step at a time.** Build steps come from [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md). Build only the requested step, and nothing from a later step or from [Future releases](docs/ROADMAP.md#future-releases-not-in-current-scope).
- **Read before planning.** Read the docs linked in the step's **Spec** line. For anything else, use the map below. Don't load every doc.
- **Plan first.** Show the plan and wait for approval before writing code.
- **Don't guess.** If the docs are unclear or contradict each other, say so. List what was unclear and what you assumed at the end of the step. Spec changes are made in the docs first (see [CONTRIBUTING.md](CONTRIBUTING.md#change-the-spec-first)).
- **Keep the review list current.** Each step adds its legal, rate and business assumptions and its hands-on checks to [docs/REVIEW_LIST.md](docs/REVIEW_LIST.md), with the next free ID, as well as to [HANDOFF](docs/HANDOFF.md#assumptions-to-check).

## Where the rules are

| Working on… | Read |
|---|---|
| A module feature | That module's spec in [docs/modules/](docs/modules/README.md) |
| Any page, Server Action or Route Handler | [Module access](SECURITY.md#module-access-rwo) and its [exceptions](SECURITY.md#exceptions-to-module-access) |
| Salary, IDs, bank accounts, payslips, 201 files, medical certificates, disciplinary cases | [Sensitive data](SECURITY.md#sensitive-data) |
| Money, invoices, payroll amounts | [Money](docs/DATA_MODEL.md#money) and [Ledger](docs/DATA_MODEL.md#ledger-pulse-fiscal) |
| Stock, serials, deliveries | [Inventory](docs/DATA_MODEL.md#inventory-pulse-supply) |
| A new collection or field | [DATA_MODEL.md](docs/DATA_MODEL.md) |
| Calls between modules | [Architecture rules](docs/ARCHITECTURE.md#architecture-rules) and [Cross-module integration](docs/ARCHITECTURE.md#cross-module-integration) |
| Any screen | [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md), and the [reference designs](docs/DESIGN_SYSTEM.md#reference-designs) |
| Rates, taxes, contributions, labor rules | The module spec, plus [COMPLIANCE.md](docs/COMPLIANCE.md) |
| File uploads, photos, generated PDFs | [File storage](docs/ARCHITECTURE.md#file-storage) |
| Scheduled jobs | [Background jobs](docs/ARCHITECTURE.md#background-jobs) |
| An unfamiliar term | [GLOSSARY.md](docs/GLOSSARY.md) |
| A section name from the old single-file spec | [SPEC_INDEX.md](docs/SPEC_INDEX.md) |

## Never

- Write to another module's collections. Call its service functions instead.
- Rely on hiding a button or sidebar item for access control. Check on the server.
- Use floating point for money, or edit a posted journal entry, a finalized payroll run or an on-hand quantity.
- Hardcode rates, company details, design tokens, or anything the spec calls configurable.
- Log, cache or send sensitive fields, passwords or secrets anywhere.
- Commit `.env.local` or any secret, or serve `/dev/*` pages in production.
- Save files under `public/`, link to them directly, or commit anything in `storage/`.

## Before finishing a change

- Typecheck and lint pass
- Money and stock changes use transactions and follow the [data rules](docs/DATA_MODEL.md#data-rules-critical)
- New mutations check module access, are permission-checked and audit-logged
- UI changes follow the [design system](docs/DESIGN_SYSTEM.md) and are checked in both light and dark appearance and at phone width
- The step's "Done when" line holds
