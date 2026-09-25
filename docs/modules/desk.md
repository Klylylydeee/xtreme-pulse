# Pulse Desk (Customer Success)

Handles support after handover: tickets with SLA timers, warranties and support contracts, the POS terminal fleet, on-site service visits, chargeable work and renewals.

Built in [Phase 6](../BUILD_PLAN.md#phase-6-pulse-desk). Route: `/desk`. Package: `packages/desk`.

## Tickets

- Logged by staff from phone calls and emails (`TKT-YYYY-NNNN`): client, site, contact, business line, product, serial (optional), category, priority, description and attachments. Entering a serial fills in the client, site, warranty and contract. A client portal is a future release.
- Status: New → Assigned → In progress → Waiting on client or Waiting on supplier → Resolved → Closed. A ticket reopened within 7 days of being resolved (configurable) goes back to In progress.
- Every ticket shows its coverage: covered by warranty, covered by a support contract, not covered (chargeable), or unknown.
- Activity log: internal and client-facing notes, status changes, attachments and time spent.
- Everyone with Pulse Desk access sees all tickets; Desk Write is needed to work on them.

## Routing and teams

- Tickets route to a team queue by business line (configurable): **Network** and **CCTV** → the Network queue, **Data Center** → the Data Center queue (the HVAC team), **Point of Sales** → the Point of Sales queue (Technology Support). Each queue's members are a setting, seeded from its department.
- Team leads (Lead Postsales Engineer, Lead HVAC Technician, Lead Business Technology Support) assign tickets; team members can also pick up unassigned tickets from their queue.

## SLA and escalation

- Priorities and default targets (response is the first reply; resolution is when the ticket is resolved):

| Priority | Response | Resolution | Clock |
|---|---|---|---|
| Critical | 1 hour | 4 hours | 24/7 |
| High | 4 hours | 1 business day | Business hours |
| Normal | 1 business day | 3 business days | Business hours |
| Low | 2 business days | 5 business days | Business hours |

- **Business hours:** Monday to Friday, 8:00 AM – 5:00 PM, excluding confirmed holidays from the Pulse Core holiday calendar (configurable).
- A support contract can set its own targets, which replace the defaults for that client's tickets.
- The SLA clock pauses while a ticket is Waiting on client (configurable). SLA timers run as background jobs.
- **Escalation:** at 75% of a target (configurable), the assignee and the team lead are alerted. On a breach, the team lead and the department head are alerted, and the breach is recorded on the ticket.

## Warranties, support contracts and subscriptions

- **Warranty** starts automatically when Pulse Ops records the client's acceptance, for every serial delivered or installed on the project. With per-site acceptance, each site's serials start their warranty on that site's acceptance date (see [Handover and acceptance](ops.md#handover-and-acceptance)). The term comes from the catalog item's default warranty (a setting per item, in months) and can be changed on the project. Coverage is parts and labor unless stated otherwise. RMA replacements keep the original warranty (see [RMA](supply.md#rma-defective-units)).
- **Support contracts** (`SC-YYYY-NNNN`) are paid contracts: client, sites, covered serials or scope, coverage (parts, labor, on-site, remote), start and end dates, SLA targets, billing schedule (e.g. annual or quarterly, invoiced through Pulse Fiscal) and an optional preventive maintenance schedule (e.g. quarterly visits), which creates scheduled visits automatically.
- **Subscriptions and licenses** sold to clients (e.g. security subscriptions): product, license or subscription ID, quantity or seats, start and end dates, linked client and serials.
- **Warranty lookup** by serial, client or site shows what is covered, by what, and until when.

## Renewals

- Alerts at 90, 60 and 30 days (configurable) before a warranty, support contract or subscription ends, to the client's Account Manager and the Desk team lead.
- At the first alert, a **renewal deal** is created in Pulse Engage through Engage's service functions for the client's owning Account Manager, linked to the expiring item. Only one renewal deal is created per expiring item.

## POS terminal fleet

- For bank clients, each deployed terminal: serial (from Pulse Supply), terminal ID (**TID**), merchant ID (**MID**), merchant name and site, bank (the client), model (product), status (Deployed, In repair, Swapped, Pulled out), deployment date, last service date and notes. The fleet can be imported from the bank's Excel terminal list. For terminals Supply doesn't know yet, the import creates serial records through Supply's service functions, as client-owned units received without a PO (see [Receiving](supply.md#receiving)), placed at their merchant site as installed, so their history is complete.
- **POS service requests** are tickets with a type: Installation, Swap, Pull-out, Troubleshooting or Merchant training.
  - A **swap** records the outgoing and incoming serials; the TID and MID move to the incoming terminal. It is recorded as an issue-to-ticket of the incoming terminal and a return of the outgoing one.
  - A **pull-out** returns the terminal to stock as client-owned (see [Stock](supply.md#stock)).
- The fleet view filters by bank, merchant, city and status, with counts per status.

## On-site visits and service reports

- A ticket that needs a site visit gets a scheduled visit on the Pulse Ops calendar ([Scheduling](ops.md#scheduling)), with the same availability and double-booking rules.
- The technician files a **service report** (`SR-YYYY-NNNN`) from their phone: work done, parts used (by serial; each part used is an issue-to-ticket movement in Pulse Supply), time on site and photos. The client signs on the phone or on paper (uploaded), and the technician's e-signature is applied.
- Filing a service report for an assigned visit is self-service and needs no Desk access.

## Chargeable work

- Service outside warranty and contract coverage is chargeable. The client's agreement (who, when and how) is recorded before the work starts.
- The ticket records labor hours, parts and other charges (PHP). A Desk Owner approves the charges, and Pulse Fiscal creates the invoice through its service functions, applying the client's VAT treatment.

## Client updates (later phase)

- Once the email system ships, clients get email updates on their tickets (logged, status changed, resolved). Until then, updates are recorded as client-facing notes.

## Notifications

- **Assignee:** ticket assigned, client reply logged, SLA at 75%, visit scheduled.
- **Team lead:** new tickets in the queue, tickets still unassigned, SLA warnings and breaches.
- **Department head:** SLA breaches.
- **Account Manager:** renewal alerts, renewal deal created, chargeable work approved.
- **Accounting:** chargeable work ready to invoice, support contract billing due.
