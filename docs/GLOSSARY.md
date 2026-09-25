# Glossary

The words Xtreme Pulse uses, in the UI and in code. Use these terms consistently (see [Writing](DESIGN_SYSTEM.md#writing)). Each term links to where its rules live.

## Words to use

| Say | Not | Why |
|---|---|---|
| deal | sales project, opportunity | The spec's term, in the app and in code ([Pulse Engage](modules/engage.md)) |
| product (UI), `brand` (code) | vendor, make | Products are the brands a deal involves ([Deals and stages](modules/engage.md#deals-and-stages)) |
| timesheet | DTR form, time card | One per employee per cut-off ([Timesheets & attendance](modules/talent.md#timesheets--attendance)) |
| offset | comp time, overtime credit | Extra hours banked as paid time off ([Offset balance & offset time off](modules/talent.md#offset-balance--offset-time-off)) |
| cut-off | pay period | The semi-monthly period a timesheet and payroll run cover ([Pay schedule](modules/talent.md#pay-schedule)) |
| payslip | pay stub | Generated for each employee in a finalized run |

## The company and the app

| Term | Meaning |
|---|---|
| Xtreme Works | The client: a Philippine systems integrator (data center, network and cybersecurity, CCTV, POS) |
| SI | Systems integrator |
| Xtreme Pulse | The ERP. One application with eight modules ([ARCHITECTURE.md](ARCHITECTURE.md#one-application)) |
| Pulse Core, Talent, Engage, Ops, Supply, Fiscal, Desk, Insight | The modules ([Module specs](modules/README.md#modules)) |
| Business line | The part of the business a deal falls under: Data Center, Network, CCTV, Point of Sales |
| Principal, brand principal | The brand owner, such as Extreme Networks or Verifone |
| Distributor | A company that resells a principal's products to integrators |

## Access and people

| Term | Meaning |
|---|---|
| Module access, RWO | Each user's level per module: None, Read, Write or Owner ([Module access](../SECURITY.md#module-access-rwo)) |
| Owner (access level) | The highest module level: approve, void, soft-delete and manage settings. Not the same as a deal owner |
| System Administrator | The role with full access, granted only by another System Administrator ([System Administrator](../SECURITY.md#system-administrator)) |
| Bootstrap account | The first System Administrator (`sysadmin@xtreme-works.com`), a system account rather than an employee ([Bootstrap System Administrator account](modules/core.md#bootstrap-system-administrator-account)) |
| `reportingTo` | An employee's supervisors, one or more ([Reporting lines](modules/core.md#reporting-lines)) |
| Supervisor | Anyone in an employee's `reportingTo` |
| Department head | The employee who receives a department's escalations |
| Board, Board of Directors | Managing Director, Sales Director, Operations Director and Strategic Director |
| Self-service | What every active user can do for themselves without module access ([Exceptions to module access](../SECURITY.md#exceptions-to-module-access)) |
| Employee number, company ID | `YYYY-NN`, for example `2027-01` ([Employee number](modules/core.md#employee-number-company-id)) |

## HR and payroll

| Term | Meaning |
|---|---|
| 201 file | An employee's personnel file: contract, evaluations, IDs, clearances and other HR documents ([Documents (201 file)](modules/talent.md#documents-201-file)) |
| Probationary, Regular, Contractual | Active employment statuses. Resigned, Terminated and Retired deactivate the account |
| Regularization | Moving from Probationary to Regular after an evaluation |
| Overtime timesheet | Timesheet type whose extra hours are paid as overtime (HVAC technicians, drivers) |
| Standard timesheet | Timesheet type whose extra hours become offset hours (all other positions) |
| DTR | Daily Time Record: the per-day attendance computed from the timesheet ([Daily Time Record (DTR)](modules/talent.md#daily-time-record-dtr)) |
| Undertime | Leaving before the scheduled end of the day |
| Night differential | The premium for work between 10:00 PM and 6:00 AM |
| VL, SL | Vacation Leave, Sick Leave |
| SIL | Service Incentive Leave, the Labor Code's 5 days, met by paid VL |
| Leave without pay | Days not covered by a leave balance, deducted from pay |
| VAWC leave | Leave for victims of violence against women and their children (RA 9262) |
| Daily rate factor | The divisor that turns a monthly salary into a daily rate: monthly salary × 12 ÷ 261 ([Rates](modules/talent.md#rates)) |
| De minimis | Small non-taxable benefits up to BIR limits |
| 13th month pay | 1/12 of basic salary earned in the year, due by December 24 (PD 851) |
| Final pay | What a separated employee is owed, released after clearance |
| Clearance (CLR) | Sign-off that assets are returned and work is reassigned before final pay |
| COE | Certificate of Employment |
| NTE, NOD, TN | Notice to Explain, Notice of Decision, Termination Notice ([Termination due process](modules/talent.md#termination-due-process)) |
| Twin-notice rule | Just-cause dismissal needs an NTE and an NOD |
| SSS, EC | Social Security System; Employees' Compensation, the employer-paid contribution collected with SSS |
| PhilHealth, PIN | National health insurance; PhilHealth Identification Number |
| Pag-IBIG, HDMF, MID | Home Development Mutual Fund; its Membership ID number. Not the POS merchant ID, which is also called MID |
| TIN, RDO | Tax Identification Number; Revenue District Office |
| Minimum wage earner | An employee paid the regional minimum wage, exempt from income tax |

## Sales, projects and supply

| Term | Meaning |
|---|---|
| Lead | The first deal stage |
| Deal team | The owner plus the people added to a deal. Only they open its detail page |
| Deal registration | Registering a deal with a brand principal, one entry per product |
| Presales, postsales | Engineers who design solutions before a sale, and who support them after |
| Site survey | A visit to assess a client site, recorded on the deal (pre-sale) or the project |
| BOQ | Bill of quantities: the itemized solution design a quotation is made from |
| Payment terms | Percentages of the contract value with triggers. They become billing milestones |
| Billing milestone | A portion of the contract value that becomes Ready to bill when its trigger is met |
| Project lead | The engineer or manager running a project |
| Rollout | A project across many sites, tracked site by site |
| Handover, acceptance | The client's sign-off that a project or site is complete. It starts the warranty |
| Catalog item | A part number belonging to a product, with an item kind |
| Serialized, bulk, non-stock | Item kinds: tracked by serial, tracked by quantity, or services and licenses |
| Client-owned | Stock that belongs to the client, such as bank-owned terminals. Never counted in inventory value |
| Weighted average cost | The average unit cost per catalog item, updated on each receipt |
| PR, PO, RCV, DR | Purchase request, purchase order, receiving record, delivery receipt |
| Three-way match | Matching a supplier bill to its PO and receiving record |
| RMA | Return merchandise authorization: sending a defective unit back for replacement |

## Finance and tax

| Term | Meaning |
|---|---|
| AR, AP | Accounts receivable, accounts payable |
| Collection (CR) | A payment received from a client |
| Disbursement voucher (DV) | A payment to a supplier or other payee, approved by the Managing Director and the Sales Director |
| Petty cash voucher (PCV) | An expense paid from a petty cash fund |
| JE | Manual journal entry |
| Reversal entry | The only way to correct a posted journal entry |
| Period close | Locking a month so it accepts no new postings |
| VATable, zero-rated, VAT-exempt | A client's VAT treatment |
| EWT, ATC | Expanded withholding tax on supplier payments; the BIR Alphanumeric Tax Code for each type |
| Creditable withholding | Tax a client withholds from its payment to Xtreme Works |
| BIR Form 2307 | Certificate of creditable tax withheld at source. Issued to suppliers, received from clients |
| SAWT | Summary Alphalist of Withholding Taxes (from client 2307s) |
| QAP | Quarterly Alphalist of Payees (EWT withheld from suppliers) |
| 0619-E, 1601-EQ, 1604-E | Expanded withholding: monthly remittance form, quarterly return, annual information return |
| 1601-C, 1604-C, alphalist, 2316 | Withholding on compensation: monthly remittance return, annual information return with the alphalist of employees, and each employee's certificate |
| 2550Q | Quarterly VAT return |
| OR number | The official receipt number printed on a receipt |
| CAS/CBA | BIR registration of a computerized accounting system and computerized books ([CAS/CBA registration](COMPLIANCE.md#cascba-registration)) |

## Support

| Term | Meaning |
|---|---|
| Ticket (TKT) | A support request logged by staff |
| Queue | A team's ticket list, by business line |
| SLA | Response and resolution targets per priority ([SLA and escalation](modules/desk.md#sla-and-escalation)) |
| Business hours | Monday to Friday, 8:00 AM to 5:00 PM, less confirmed holidays |
| Warranty | Coverage that starts at acceptance, per serial |
| Support contract (SC) | Paid coverage with its own SLA targets and billing schedule |
| Renewal deal | A deal Desk creates in Engage when coverage nears its end |
| Chargeable work | Service outside warranty and contract coverage, invoiced to the client |
| Service report (SR) | The technician's record of a site visit, signed by the client |
| TID, MID | POS terminal ID and merchant ID |
| Swap, pull-out | Replacing a deployed terminal; returning it to stock |

## Interface

| Term | Meaning |
|---|---|
| Sheet | A slide-over panel for create and edit flows |
| Inspector | The right-hand panel with the selected item's details |
| Command bar | "Search or jump to…", opened with ⌘K or Ctrl+K |
| Hero | The solid cobalt area on Home and Login |
| Segmented control | A row of buttons that switches between views |
