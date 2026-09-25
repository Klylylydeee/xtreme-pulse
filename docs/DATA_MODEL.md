# Data model

How data is stored, owned, numbered and changed in Xtreme Pulse. The business meaning of each record is in the [module specs](modules/README.md). This file holds the rules every collection follows.

## Data rules (critical)

### Money
- Never use floating point for money. Store amounts as integers in centavos (`amountCentavos`) or `Decimal128`. Currency default: PHP.
- Round only at the line level (half-up to the centavo), never on intermediate values.
- Any operation touching more than one collection (e.g. posting an invoice → ledger + AR + the billing milestone's status) runs inside a MongoDB transaction (`session.withTransaction`).

### Ledger (Pulse Fiscal)
- Journal entries are append-only. Never update or delete a posted entry; correct with a reversal entry.
- Debits must equal credits; validate before commit.
- VAT is 12% unless the client is zero-rated or VAT-exempt (set per client; see [Clients, sites and contacts](modules/engage.md#clients-sites-and-contacts)). Support EWT and BIR Form 2307 generation.

### Inventory (Pulse Supply)
- Stock is tracked as movement documents (receipt, transfer, issue-to-project, issue-to-ticket, issue-to-employee, delivery to client, return, RMA). On-hand quantity is derived, never edited directly.
- Serialized items live in their own collection with a status history: supplier (or the client, for client-owned units received without a PO) → office stock → project / employee → client site (delivered → installed) → RMA / retired.
- The serial number is the cross-module thread: it must be traceable to supplier, PO, project, client site, assigned employee, warranty and tickets.

### General
- Soft delete (`deletedAt`) for business records; no hard deletes outside admin tooling.
- All documents have `createdAt`, `updatedAt`, `createdBy`, `updatedBy`.
- Index frequent lookups: serial number, client, project, ticket status, renewal/due dates, employee + cut-off period, merchant TIN + receipt number.
- Store dates in UTC; display in Asia/Manila.

## Collection ownership

Each module owns its collections, and no module writes to another module's collections (see [Architecture rules](ARCHITECTURE.md#architecture-rules)). The owner of each record below comes from the spec section that defines it. Collection names in `code` are the ones the spec or build plan already fixes. Name the rest when they're built, following [Naming](#naming), and add them here.

| Module | Owns |
|---|---|
| Core | User accounts (`users`), employee identity (`employees`), departments, positions, employee number counters (`employeeNumberCounters`), company settings (`companySettings`), clients with sites and contacts, products (`brands`), catalog items, suppliers, holidays, approvals, notifications, audit log |
| Talent | Employee records (personal, employment, compensation history, government IDs, bank account), 201 documents, e-signatures, certifications, work schedules, timesheets (time entries and reimbursements), leave and offset entries and requests, payroll settings, allowance types and assignments, payroll runs and payslips, remittances, HR documents, due-process cases, onboarding checklists, change requests, the register of claimed receipts |
| Engage | Deals and deal teams, deal registrations, pre-sale site surveys, BOQs, quotations, sales quotas and assignments, Engage settings (stages, business lines, lost reasons, payment term templates) |
| Ops | Projects and project teams, project site surveys, billing milestones, assignments (the calendar), daily site reports, checklist templates and results, rollout sites, acceptance records, manual subcontractor cost rows |
| Supply | Purchase requests, purchase orders (`purchaseOrders`), receiving records, stock movements, serial items (`serialItems`), stock locations, delivery receipts, RMAs |
| Fiscal | Chart of accounts, journal entries, accounting periods, sales invoices, collections, supplier bills, disbursement vouchers, bank accounts and statements, petty cash funds and vouchers |
| Desk | Tickets, queues, SLA targets and timers, warranties, support contracts, subscriptions, POS terminals, service reports, chargeable work |
| Insight | Targets, month-end snapshots |

Core and Talent describe the same person under one `employeeId` (see [People data ownership](modules/core.md#people-data-ownership)). The serial number links Supply, Ops and Desk records (see [Inventory](#inventory-pulse-supply)).

## Naming

- Collections: plural camelCase (`purchaseOrders`, `serialItems`)
- Fields: camelCase; references end in `Id` (`clientId`, `projectId`)

## Document numbers

- Human-readable document numbers per module with a prefix: `DL-` deals, `QT-` quotes, `PRJ-` projects, `PR-` purchase requests, `PO-` purchase orders, `RCV-` receiving records, `DR-` delivery receipts, `RMA-` returns, `INV-` invoices (the actual series is a setting so it can follow the BIR-registered series), `CR-` collections, `DV-` disbursement vouchers, `JE-` journal entries, `PCV-` petty cash vouchers, `TKT-` tickets, `SC-` support contracts, `SR-` service reports, `CTR-` contracts, `EVL-` evaluations, `COE-` certificates of employment, `CLR-` clearances, `NTE-` notices to explain, `NOD-` notices of decision, `TN-` termination notices
- Employee numbers use `YYYY-NN` (see [Employee number](modules/core.md#employee-number-company-id))
- Business documents use the format `PREFIX-YYYY-NNNN`, for example `QT-2026-0012`. Quotation revisions add `Rev N` (see [Quotations](modules/engage.md#quotations)), and HR documents use the same pattern (for example `COE-2027-0001`).
- Numbers come from atomic per-prefix, per-year counters (build step 0.6), so two records can never share a number.

## Versioned configuration

Rates and tables that change by law or policy are stored as versioned, effective-dated configuration, never hardcoded. A calculation uses the version in effect on the date it applies to. A change is a new version with its own effective date, never an edit to an old one. The configuration store is built in step 0.6.

The spec calls for versioning for:

| Configuration | Spec |
|---|---|
| SSS, PhilHealth and Pag-IBIG contribution tables (with EC), BIR withholding tax tables, holiday and overtime premium rates, de minimis limits | [Pay computation per cut-off](modules/talent.md#pay-computation-per-cut-off) |
| 13th month and other benefits tax-exempt ceiling | [13th month pay](modules/talent.md#13th-month-pay) |
| Regional minimum wage rates | [Minimum wage check](modules/talent.md#minimum-wage-check) |
| VAT rate | [Quotations](modules/engage.md#quotations) |
| BIR ATC codes and EWT rates, tax forms, tax due dates | [Supplier bills (AP)](modules/fiscal.md#supplier-bills-ap), [BIR tax reports](modules/fiscal.md#bir-tax-reports) |
| Salary and allowance history, work schedules | [Compensation](modules/talent.md#compensation), [Work schedule](modules/talent.md#work-schedule) |

Who checks these against official issuances, and when, is in [Keeping rates current](COMPLIANCE.md#keeping-rates-current).

## Derived values

These values are always computed from their source records and never edited directly. To correct one, change or reverse the source record.

| Value | Derived from | Spec |
|---|---|---|
| On-hand stock | Stock movements | [Inventory](#inventory-pulse-supply) |
| Where a serial is and its status | The serial's status history | [Inventory](#inventory-pulse-supply) |
| Ledger and bank balances | Posted journal entries | [Ledger](#ledger-pulse-fiscal), [Bank accounts and reconciliation](modules/fiscal.md#bank-accounts-and-reconciliation) |
| Leave balances | Opening, credit, carry-over and usage entries | [Leave](modules/talent.md#leave) |
| Offset balances | Opening, credit and usage entries | [Offset balance & offset time off](modules/talent.md#offset-balance--offset-time-off) |
| Daily Time Record | Approved timesheets, schedules, leave, offset time off, confirmed holidays | [Daily Time Record (DTR)](modules/talent.md#daily-time-record-dtr) |
| Account status | Employment status | [Account status](../SECURITY.md#account-status) |
| Org chart | `reportingTo` | [Org chart](modules/core.md#org-chart) |
| Delivery status | Accepted quotation, POs, receipts and signed delivery receipts | [Delivery receipts](modules/supply.md#delivery-receipts) |

## Locked and append-only records

Some records can't be edited once they reach a certain state. Corrections go through a new record instead:

- Posted journal entries: reversal entries ([Ledger](#ledger-pulse-fiscal))
- Finalized payroll runs, and approved timesheets after the run: adjustments in the next cut-off ([Payroll run & payslips](modules/talent.md#payroll-run--payslips))
- Closed accounting periods: postings in the current open period ([Chart of accounts and ledger](modules/fiscal.md#chart-of-accounts-and-ledger))
- Salary and allowance history: new effective-dated entries ([Compensation](modules/talent.md#compensation))
- Sent quotations and BOQ versions: a new revision or version ([Quotations](modules/engage.md#quotations), [Presales and BOQ](modules/engage.md#presales-and-boq))
- Audit log entries: never changed ([Audit log](modules/core.md#audit-log))
- Employee records: never deleted ([Record retention](COMPLIANCE.md#record-retention))
