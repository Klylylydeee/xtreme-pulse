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
| return (a request) | send back, decline | An approver sends a request back with remarks so the requester can fix it and submit again; the resubmission is a new request that starts from the first step ([Approvals](modules/core.md#approvals)) |
| reject (a request) | deny, return | An approver turns a request down, with remarks. Only request types that allow it offer Reject; timesheets, payroll runs and payments don't ([Approvals](modules/core.md#approvals)) |
| retire, restore (a record) | delete, archive | A soft delete of a department, position or master data record, undone by Restore. Not the Retired employment status ([Managing master data](modules/core.md#managing-master-data)) |

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
| Approval step | One stage of an approval request, with its approvers fixed at submit. An any-one step is settled by the first decision; an all-of step needs every approver to approve ([Approvals](modules/core.md#approvals)) |
| Draft holiday, confirmed holiday | A draft is a proposed holiday that only HR and the System Administrator see; once checked against the proclamation and given its legal basis, it is confirmed, and only confirmed holidays affect attendance, leave and payroll ([Holiday calendar](modules/core.md#holiday-calendar)) |
| Declared holiday | A holiday announced at short notice (for example Eid'l Fitr or a weather-related special non-working day), added already confirmed, with every user notified ([Holiday calendar](modules/core.md#holiday-calendar)) |
| Onboarding checklist | A new employee's items (theirs and HR's), derived from their records, required but not enforced ([Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26)) |
| Onboarding gate | An action that needs certain onboarding items first, such as applying an e-signature; listed in one map in code, `ONBOARDING_GATES` ([Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26)) |
| Change request | An employee's request to change a filled-in detail of their own record, approved by HR or a supervisor (sensitive details by HR, or a Board member for HR staff) ([Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26)) |
| Department head | The employee who receives a department's escalations |
| Board, Board of Directors | Managing Director, Sales Director, Operations Director and Strategic Director |
| Self-service | What every active user can do for themselves without module access ([Exceptions to module access](../SECURITY.md#exceptions-to-module-access)) |
| Employee number, company ID | `YYYY-NN`, for example `2027-01` ([Employee number](modules/core.md#employee-number-company-id)) |
| Employee record | Pulse Talent's record of one employee (personal, employment, compensation, government IDs, payroll bank account), beside Core's identity under the same `employeeId` ([The employee record](modules/talent.md#the-employee-record-build-step-21)) |
| My record | The employee's own record at `/talent/me`, read-only self-service open to every user with an employee record ([The employee record](modules/talent.md#the-employee-record-build-step-21)) |
| Reveal | Pressing a masked field's Reveal to see the full sensitive value; access-checked and audit-logged ([Sensitive data](../SECURITY.md#sensitive-data)) |

## HR and payroll

| Term | Meaning |
|---|---|
| 201 file | An employee's personnel file: contract, evaluations, IDs, clearances and other HR documents ([Documents (201 file)](modules/talent.md#documents-201-file)) |
| Probationary, Regular, Contractual | Active employment statuses. Resigned, Terminated and Retired deactivate the account |
| Regularization | Moving from Probationary to Regular after an evaluation |
| Overtime timesheet | Timesheet type whose extra hours are paid as overtime (HVAC technicians, drivers) |
| Standard timesheet | Timesheet type whose extra hours become offset hours (all other positions) |
| DTR | Daily Time Record: the per-day attendance computed from the timesheet ([Daily Time Record (DTR)](modules/talent.md#daily-time-record-dtr)) |
| Undertime | Leaving before the scheduled end of the day. From build step 2.7, any scheduled minutes after the first time in that no time entry covers |
| Late | A first time in more than the grace period after the scheduled start; the late minutes count from the scheduled start (build step 2.7) |
| Grace period | The minutes after the scheduled start within which a time in isn't late (seeded 15 minutes, set on the work schedule) |
| Submission deadline | The last day to submit a timesheet: a set number of days after the cut-off ends (seeded 1). Later submissions are accepted and marked "Submitted late" |
| Returned (timesheet) | Sent back to the employee by an approver with remarks; the employee fixes it and resubmits, and approval starts again from the supervisor |
| Offset entry | One dated line of the offset balance: an opening, a credit (when HR approves a timesheet), an adjustment (when a holiday change alters it) or a usage (offset time off). The balance is their sum |
| Night differential | The premium for work between 10:00 PM and 6:00 AM |
| VL, SL | Vacation Leave, Sick Leave |
| SIL | Service Incentive Leave, the Labor Code's 5 days, met by paid VL |
| Leave without pay | Days not covered by a leave balance, deducted from pay |
| VAWC leave | Leave for victims of violence against women and their children (RA 9262). A confidential leave type: HR approves it, and others see only "Leave" (build step 2.8) |
| Time off request | One leave or offset time off request (`LV-` or `OFS-` number), filed on one request sheet and approved by any one supervisor, or HR for an empty `reportingTo` (build step 2.8) |
| Leave entry | One dated line of a VL or SL balance: an opening, a credit, a carry-over, a usage or an adjustment, in half days. The balance is their sum (build step 2.8) |
| Credited, per-event, per-year leave | How a leave type limits use: a running balance credited each year (VL, SL); a maximum per request (maternity, paternity, special leave for women); or a maximum per calendar year (solo parent, VAWC) |
| Chargeable day | A day a leave request actually uses: a scheduled work day that isn't a confirmed holiday, or every day for a calendar-day type such as maternity leave |
| Half day | The first half (scheduled start to the break) or the second half (end of the break to the scheduled end) of a work day, charged as half a day of leave |
| Available balance | A leave or offset balance less what pending requests already hold |
| Go-live date | The day Pulse Talent goes live (`talent.leaveSettings.goLiveDate`), as of which HR enters opening balances and year-to-date pay once |
| Opening entry | A balance or year-to-date pay figure HR enters once per existing employee as of the go-live date, never an edit to a balance |
| Absent minutes | On a day partly covered by time off with nothing worked, the scheduled minutes the time off doesn't cover (build step 2.8) |
| Payroll run, draft run | One cut-off's pay for every employee (`PAY-` number). A draft is recomputed as a whole until HR submits it and a Board member approves it (build steps 2.9 and 2.10) |
| Finalized run | A payroll run a Board member approved: locked for good, its payslips issued; corrections go into a later run (build step 2.10) |
| Returned run | A payroll run a Board member sent back to HR with remarks; HR edits and submits it again (build step 2.10) |
| Review flag | A mark on an employee's payroll line that HR must clear or acknowledge before submitting: onboarding incomplete, timesheet not approved, below minimum wage; net pay below zero and a stale manual entry must be fixed (build step 2.10) |
| Manual entry | An earning, deduction or override HR adds to a run with a required reason, printed on the payslip as an adjustment and highlighted for the Board (build step 2.10) |
| Override | A manual entry that replaces a computed line's amount (basic pay, a per cut-off allowance, a contribution share or the withholding tax), never an attendance item (build step 2.10) |
| Back pay | Pay owed for an earlier period, such as a back-dated salary increase; added by HR as a taxable manual earning (build step 2.10) |
| Payslip | An employee's statement for one finalized run, as a PDF in self-service, with the year-to-date figures frozen at finalizing (build step 2.10) |
| Payroll register | A finalized run's list of employees with their bank, account number and net pay, used to credit salaries (build step 2.10) |
| First payroll cut-off | The first cut-off that starts on or after the go-live date; earlier cut-offs were paid by the old system (build step 2.9) |
| Base days | An employee's scheduled work days in a cut-off, holidays included, used to prorate basic pay and per cut-off allowances (build step 2.9) |
| Workday before | The last scheduled work day before a holiday that isn't itself a holiday; being present or on paid leave then makes an unworked regular holiday paid (build step 2.9) |
| Provisional pay | What an employee whose timesheet isn't fully approved still gets: basic pay, per cut-off allowances and daily-rated holiday pay (build step 2.9) |
| Attendance item | A pay line that depends on the approved DTR: overtime, premiums, night differential, holiday pay and deductions, per day present allowances, reimbursements, and the attendance deductions (build step 2.9) |
| Settlement | A line in a later run paying the difference between a period's attendance items now and what finalized runs paid for it ("Settled from earlier cut-offs", build step 2.9) |
| Contribution month | The month of a cut-off's pay date; both cut-offs paid in it share one month's SSS, PhilHealth and Pag-IBIG contribution (build step 2.9) |
| Compensation for contributions | A month's taxable pay less attendance deductions, from both cut-offs paid that month; the SSS and Pag-IBIG basis by default (build step 2.9) |
| Taxable compensation | A cut-off's compensation for contributions less the employee's SSS, PhilHealth and Pag-IBIG shares, the basis of the semi-monthly withholding (build step 2.9) |
| Basic salary earned | Basic pay less attendance and holiday deductions, the basis of 13th month pay (build step 2.9) |
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
| Compensation entry | One effective-dated salary change (basic salary, rate type, minimum wage earner flag, reason). Entries are never edited; a correction is a new entry with the same effective date ([The employee record](modules/talent.md#the-employee-record-build-step-21)) |
| Monthly-rated, daily-rated | The rate type: whether the basic salary is a monthly amount or a daily rate ([Compensation](modules/talent.md#compensation)) |
| Work region | The region whose minimum wage applies to the employee, NCR by default ([Employment](modules/talent.md#employment)) |

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
| Command provider | A module's source of command bar results (its records or actions), registered with Core and called only for users it is visible to ([Command bar](modules/core.md#command-bar)) |
| Directory card | One person's directory fields, opened in the inspector from the directory, the org chart, the command bar or Home ([Company directory](modules/core.md#company-directory)) |
| Hero | The solid cobalt area on Home and Login |
| Segmented control | A row of buttons that switches between views |
