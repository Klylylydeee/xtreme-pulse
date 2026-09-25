# AGENTS.md

Instructions for AI coding agents working on Xtreme Pulse, the internal ERP for Xtreme Works (a Philippine systems integrator). People should start with [README.md](README.md).

This file is short on purpose. It says where the rules are. The rules themselves live in the linked docs.

## Commands

<!-- Fill in once the repo is scaffolded -->
- `pnpm dev` — run the app
- `pnpm lint` / `pnpm typecheck` / `pnpm test`
- `pnpm seed:admin` — create the bootstrap System Administrator and base data (safe to run again: it skips an existing System Administrator and adds only missing base data)

`pnpm test` is reserved. There are no automated tests yet (see [TESTING.md](docs/TESTING.md)).

## How to work

- **One build step at a time.** Build steps come from [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md). Build only the requested step, and nothing from a later step or from [Future releases](docs/ROADMAP.md#future-releases-not-in-current-scope).
- **Read before planning.** Read the docs linked in the step's **Spec** line. For anything else, use the map below. Don't load every doc.
- **Plan first.** Show the plan and wait for approval before writing code.
- **Don't guess.** If the docs are unclear or contradict each other, say so. List what was unclear and what you assumed at the end of the step. Spec changes are made in the docs first (see [CONTRIBUTING.md](CONTRIBUTING.md#change-the-spec-first)).

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
