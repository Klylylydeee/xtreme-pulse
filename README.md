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
- **MongoDB 8.x Community Server** and **mongosh**, run locally as a single-node replica set (set up below)
- **Redis 7 or later**, run locally. On Windows, use [Memurai](https://www.memurai.com/) or a Windows port of Redis.
- **Claude Code**
- **A code editor**, such as VS Code

### MongoDB replica set (once)

Transactions need a replica set, so they fail on a standalone MongoDB. A fresh install, or an existing standalone MongoDB service, is converted like this:

1. Open the MongoDB config file: on Windows usually `C:\Program Files\MongoDB\Server\<version>\bin\mongod.cfg`, on macOS (Homebrew) `$(brew --prefix)/etc/mongod.conf`, on Linux `/etc/mongod.conf`. Keep `bindIp: 127.0.0.1`, and add:

   ```yaml
   replication:
     replSetName: rs0
   ```

   YAML needs spaces here, not tabs. On Windows, the stock file has a commented-out `#replication:` line. Replace that line with the two lines above. The file is under Program Files, so edit it as administrator. In VS Code, saving offers **Retry as Admin**.

2. Restart MongoDB: on Windows, restart the **MongoDB Server** service (Services, or `Restart-Service MongoDB` in an administrator PowerShell); on macOS, `brew services restart mongodb-community`; on Linux, `sudo systemctl restart mongod`.
3. Install mongosh if you don't have it. On Windows it isn't bundled with the server: run `winget install MongoDB.Shell`, or use the MSI from [mongodb.com/try/download/shell](https://www.mongodb.com/try/download/shell). Open a new terminal afterwards, so `mongosh` is on the PATH.
4. Start the replica set:

   ```bash
   mongosh --eval "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] })"
   ```

5. Check it with `mongosh --eval "rs.status()"`: `ok` is `1` and the member's `stateStr` is `PRIMARY`. For a quick check, `mongosh --eval "rs.status().ok"` prints `1`.

### Redis (once)

Keep Redis bound to localhost (`bind 127.0.0.1`) and set `maxmemory-policy noeviction` in its config file (`memurai.conf` for Memurai, `redis.conf` elsewhere), because BullMQ loses jobs if Redis evicts keys; `/dev/health` flags any other policy. Persistence (`appendonly yes`) is recommended, so queued jobs survive a restart. Restart Redis after changing the config.

On Windows, with Memurai:

1. Install it with `winget install Memurai.MemuraiDeveloper`.
2. Edit `C:\Program Files\Memurai\memurai.conf` as administrator, and set `bind 127.0.0.1`, `maxmemory-policy noeviction` and `appendonly yes`.
3. Restart it with `Restart-Service Memurai` in an administrator PowerShell.
4. Check it. `memurai-cli` isn't on the PATH, so run `& "C:\Program Files\Memurai\memurai-cli.exe" ping`. It prints `PONG`.

### Run the app

Once Phase 0 has scaffolded the repo:

```bash
pnpm install
cp .env.example .env.local   # fill in the values
pnpm seed:admin              # first System Administrator and base data
pnpm dev                     # the app and the background worker
```

`.env.local` lives at the repo root. For the local services above, use:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017/xtreme-pulse?replicaSet=rs0
REDIS_URL=redis://127.0.0.1:6379
```

Then fill in the values that have no default:

- `FIELD_ENCRYPTION_LOCAL_KEY`: exactly 96 random bytes, base64-encoded (128 characters). Generate one with `node -e "console.log(require('crypto').randomBytes(96).toString('base64'))"`. Keep a safe copy. If you lose it, the encrypted data can't be read.
- `AUTH_SECRET`: a long random value, for example 32 random bytes, base64-encoded (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
- `SEED_ADMIN_PASSWORD`: set it before running `pnpm seed:admin` on a fresh database.

The other values are described in [Environment variables](docs/DEPLOYMENT.md#environment-variables).

Sign in as `sysadmin@xtreme-works.com` with the `SEED_ADMIN_PASSWORD` you set, then change the password. The variables are described in [DEPLOYMENT.md](docs/DEPLOYMENT.md#environment-variables), and all commands are in [AGENTS.md](AGENTS.md#commands).

To try the app on a phone or tablet, open `http://<this computer's IP>:3000` from the same network. The dev server allows the computer's own IPv4 addresses; add any other host name you use (such as `mybox.local`) to `DEV_ALLOWED_ORIGINS`.

### Run the tests

`pnpm test` runs the sensitive-data guard tests, the audit log, notification and sensitive reveal tests, the Core administration tests (departments, positions, company settings, the company details reminder, allowed email domains, upload settings and the company logo route), the user account tests (employee numbers, reporting lines, users, the user account schemas, the employee model, sessions and temporary passwords), the module access tests (access levels, effective access, file access and the sidebar), the user access tests (setting access, the access reminder and the access-change notifications), and from step 1.8 the master data tests (clients with sites and contacts, products, catalog items, suppliers and the product seed). They start their own throwaway MongoDB, so they need neither the local replica set nor `.env.local`, and never touch the development database. The first run needs internet access: it downloads a MongoDB binary (about 75 MB, cached afterwards). On Windows on Arm it uses the x64 build, which Windows runs under emulation. Details, and how to point the tests at another server, are in [TESTING.md](docs/TESTING.md#sensitive-data-guard-tests).

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
