# Module specs

These files are the product specification for Xtreme Pulse: what each module does and the business rules it follows. There is no separate PRD. When a rule here changes, change it here first, then the code (see [CONTRIBUTING.md](../../CONTRIBUTING.md#change-the-spec-first)).

Rules that apply to every module live in their own docs, and the module specs link to them:

- Sign-in, roles, module access and sensitive data: [SECURITY.md](../../SECURITY.md)
- Money, ledger, inventory and general data rules: [DATA_MODEL.md](../DATA_MODEL.md)
- Screens, components and writing: [DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md)
- Labor, payroll, tax and privacy obligations: [COMPLIANCE.md](../COMPLIANCE.md)
- Terms such as cut-off, offset, BOQ and 2307: [GLOSSARY.md](../GLOSSARY.md)

Looking for a section of the old single-file `CLAUDE.md`? See [SPEC_INDEX.md](../SPEC_INDEX.md).

## Modules

| Module | Domain | Scope |
|---|---|---|
| [Pulse Core](core.md) | Platform | Password auth (allowed email domains only), user accounts and status, module access (RWO), system administration, company directory, org chart, holiday calendar, shared master data (clients with sites and contacts, products (brands), catalog items, suppliers), approvals, notifications, audit log |
| [Pulse Engage](engage.md) | Sales & Growth | Deals from lead to won/lost, business lines and products, deal teams, deal registration, clients with sites and contacts, presales BOQ, quotations (VAT per client, approval, validity), won deals handed to Pulse Ops, sales quotas, account and product assignments |
| [Pulse Ops](ops.md) | Project Delivery | Projects from won deals, stages, project lead and team, billing milestones from payment terms, scheduling, daily site reports and checklists, installed equipment by serial and site, multi-site rollouts, handover and acceptance, project costs |
| [Pulse Supply](supply.md) | Inventory & Procurement | Suppliers, purchase requests, purchase orders, receiving with serials, stock (serialized and bulk, company- and client-owned, weighted average cost), delivery receipts and delivery status, RMA, company-issued assets |
| [Pulse Desk](desk.md) | Customer Success | Tickets with routing, SLA timers and escalation, warranties, support contracts and subscriptions, renewals (with renewal deals in Pulse Engage), POS terminal fleet and POS service requests, on-site visits and service reports, chargeable work |
| [Pulse Fiscal](fiscal.md) | Finance & Accounting | Chart of accounts and general ledger, sales invoices from billing milestones, collections and client 2307s, supplier bills with PO matching and EWT, payments (Managing Director and Sales Director approval), bank reconciliation, petty cash, payroll and final pay posting, project cost accounting (Pulse Ops shows the project cost view), BIR tax reports, financial statements and books of accounts |
| [Pulse Talent](talent.md) | People & Culture | Employee records, onboarding, 201 files, skills & certifications, timesheets & attendance (Overtime and Standard types), overtime, offset, reimbursements, leave, probation & contract tracking, payroll (SSS, PhilHealth, Pag-IBIG, withholding tax), employer contributions & remittances, payslips, 13th month pay, final pay, termination due process, HR documents, HR reports |
| [Pulse Insight](insight.md) | Business Intelligence | Read-only dashboards (Executive, Sales, Operations, Support, Finance, People), targets, month-end snapshots, filters, PDF and Excel exports, weekly Board summary |

The modules are built in this order: see [Build order](../ROADMAP.md#build-order).
