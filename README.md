# Xtreme Pulse

ERP for **Xtreme Works**, a Philippine systems integrator providing data center solutions, network and cybersecurity infrastructure, CCTV solutions, and POS systems (credit card terminals).

The ERP follows the SI business lifecycle:
Lead → BOQ & quote → won deal → project → procurement → installation & handover → invoicing → warranty/support contract → renewal → new deal.

Xtreme Pulse is an **internal application**. It's reachable only on the office network or via VPN, never from the public internet (see [SECURITY.md](SECURITY.md#network-exposure)). Internal to Xtreme Works; not for public distribution.

## Modules

Everything is one application with one sign-in. Each module is a section of the app.

| Module | Domain | Spec |
|---|---|---|
| Pulse Core | Platform: sign-in, users, access, directory, org chart, holidays, master data, approvals | [core.md](docs/modules/core.md) |
| Pulse Talent | People & Culture: employee records, timesheets, leave, payroll | [talent.md](docs/modules/talent.md) |
| Pulse Engage | Sales & Growth: deals, BOQs, quotations | [engage.md](docs/modules/engage.md) |
| Pulse Ops | Project Delivery: projects, scheduling, site reports, handover | [ops.md](docs/modules/ops.md) |
| Pulse Supply | Inventory & Procurement: purchasing, serials, deliveries | [supply.md](docs/modules/supply.md) |
| Pulse Fiscal | Finance & Accounting: ledger, invoices, payments, BIR reports | [fiscal.md](docs/modules/fiscal.md) |
| Pulse Desk | Customer Success: tickets, SLAs, warranties, POS fleet | [desk.md](docs/modules/desk.md) |
| Pulse Insight | Business Intelligence: read-only dashboards | [insight.md](docs/modules/insight.md) |

**Status:** planning. The build runs in eight phases (see [ROADMAP.md](docs/ROADMAP.md)).

## Tech stack

Next.js (App Router) with TypeScript, MongoDB (replica set) with Mongoose, Auth.js, Tailwind CSS with shadcn/ui, and BullMQ with Redis. Uploaded files are kept in a `storage/` folder with the app. Details are in [ARCHITECTURE.md](docs/ARCHITECTURE.md#tech-stack).

## Getting started

Install these once, then Phase 0 sets up the rest.

- **Node.js**, the current LTS release
- **pnpm**, the package manager for the workspace
- **Git**, to commit after every step
- **Docker Desktop**, to run MongoDB and Redis locally
- **Claude Code**
- **A code editor**, such as VS Code

Then, once Phase 0 has scaffolded the repo:

```bash
pnpm install
cp .env.example .env.local   # fill in the values
docker compose up -d         # MongoDB replica set and Redis
pnpm seed:admin              # first System Administrator and base data
pnpm dev                     # the app and the background worker
```

Sign in as `sysadmin@xtreme-works.com` with the `SEED_ADMIN_PASSWORD` you set, then change the password. The variables are described in [DEPLOYMENT.md](docs/DEPLOYMENT.md#environment-variables), and all commands are in [AGENTS.md](AGENTS.md#commands).

## Documentation

| Doc | Read it when you need… |
|---|---|
| [AGENTS.md](AGENTS.md) · [CLAUDE.md](CLAUDE.md) | Instructions for AI coding agents (loaded automatically) |
| [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) | The step-by-step build plan and the prompt for each step |
| [docs/modules/](docs/modules/README.md) | What each module does: the product spec |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the app is structured, how modules connect, background jobs |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Money, ledger and stock rules, collection ownership, numbering |
| [SECURITY.md](SECURITY.md) | Sign-in, roles, module access, sensitive data, secrets |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Colors, type, components, layout and motion |
| [docs/CODE_STYLE.md](docs/CODE_STYLE.md) | How code is written |
| [docs/TESTING.md](docs/TESTING.md) | How changes are checked |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md) | The labor, payroll, tax and privacy obligations, and where each is implemented |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | What cut-off, offset, BOQ, 2307 and the rest mean |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Environments, variables and the go-live checklist |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | What to do when something goes wrong |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Build order, future releases, what's pending |
| [docs/adr/](docs/adr/README.md) | Why the main technical decisions were made |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to work on the repo, and which doc to edit for which change |
| [CHANGELOG.md](CHANGELOG.md) | What changed, and when |
| [docs/SPEC_INDEX.md](docs/SPEC_INDEX.md) | Where each section of the old single-file spec lives now |
