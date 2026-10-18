# Compliance

The Philippine legal and regulatory obligations Xtreme Pulse implements. Each row gives the legal basis the spec cites and links to the rule that implements it. The rule itself lives in the linked section. This file is the register.

> This register is a developer's map, not legal advice. Have HR, the company's accountant or counsel confirm the obligations, and check rates against current issuances before go-live.

## Data Privacy Act of 2012 (RA 10173)

| Obligation | Where it's implemented |
|---|---|
| Treat salary, allowances, payslips, government IDs, bank accounts, medical certificates, 201 files and disciplinary cases as sensitive personal information: encrypted, access-limited, masked, reveals audit-logged | [Sensitive data](../SECURITY.md#sensitive-data) |
| Keep sensitive files private: never publicly reachable, opened only after an access check | [Sensitive data](../SECURITY.md#sensitive-data), [File storage](ARCHITECTURE.md#file-storage) |
| Never send raw sensitive fields to analytics or dashboards | [Sensitive data](../SECURITY.md#sensitive-data), [Who sees what](modules/insight.md#who-sees-what) |
| Limit who sees an employee's date of birth and civil status (age and marital status are sensitive personal information under RA 10173 Section 3(l)) to HR, Accounting, the System Administrator and the employee, without encrypting them. *Assumption, to be confirmed by HR or counsel* (build step 2.1) | [Sensitive data](../SECURITY.md#sensitive-data), [The employee record](modules/talent.md#the-employee-record-build-step-21) |
| Store government IDs and bank account numbers in the formats the agencies and banks issue (TIN 9, 12 or 14 digits; SSS 10; PhilHealth PIN 12; Pag-IBIG MID 12; UnionBank and RCBC account numbers 10 to 16 digits). *Assumption, to be confirmed by HR or counsel* (build step 2.1) | [The employee record](modules/talent.md#the-employee-record-build-step-21) |
| Medical certificates go only to the employee, HR, the System Administrator (and later the approving supervisor), not Accounting. Opening any 201 document is audit-logged. *Assumption, to be confirmed by HR or counsel* (build step 2.2) | [Sensitive data](../SECURITY.md#sensitive-data), [Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22) |
| Profile photos are shown to every employee, wherever a person appears. *Assumption, to be confirmed by HR or counsel* (build step 2.2): the company's privacy notice covers this, with no separate consent | [Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22) |
| Let employees keep their own data accurate (RA 10173 Section 16(d), the right to rectification): they fill in their own empty fields and ask for changes through change requests, each keeping the old value, the new value, the requester, the approver and when. Supervisors approve contact detail and skill changes but get no wider view of their team's records. Government IDs and bank details an employee enters are verified by HR before payroll. *Assumption, to be confirmed by counsel* (build step 2.6) | [Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26), [Sensitive data](../SECURITY.md#sensitive-data) |
| Pay can't be worked out from the ledger or project costs | [Chart of accounts and ledger](modules/fiscal.md#chart-of-accounts-and-ledger), [Project costs](modules/ops.md#project-costs) |

## Record retention

- Employee records are retained indefinitely. Never delete or auto-archive employees, including separated ones; they remain as deactivated users.
- 201 documents (build step 2.2) are part of the employee record. They are never deleted, only archived by HR with a reason, and they are kept forever, separated employees' included. E-signature versions and every use of one are kept forever too, so signed records keep their signature. *Assumption, to be confirmed by counsel:* keeping archived 201 documents forever is proportionate under the Data Privacy Act ([Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22)).
- Profile photos and e-signatures are re-encoded on upload, which strips metadata such as the GPS location a phone camera adds (build step 2.2).
- Audit log entries and notifications are kept forever, with no expiry (project owner's decision, 2026-10-03, build step 1.3; see [Retention](DATA_MODEL.md#retention)). For this internal app the owner set aside Data Privacy Act retention limits and erasure requests for these two records, so the app has no way to delete them. The audit log still never holds passwords or sensitive values ([Audit logging](../SECURITY.md#audit-logging)).

## Labor Code and DOLE

| Obligation | Basis cited in the spec | Where it's implemented |
|---|---|---|
| Probation of at most 6 months. An employee allowed to work past probation is deemed Regular | Labor Code | [Probation & contract tracking](modules/talent.md#probation--contract-tracking) |
| Regularization standards made known at hiring, or the employee is deemed Regular | Labor Code | [HR documents](modules/talent.md#hr-documents) |
| 5-day Service Incentive Leave, met by the 5 days of paid VL | Labor Code | [Leave](modules/talent.md#leave) |
| Maternity leave, 105 days | RA 11210 | [Leave](modules/talent.md#leave) |
| Paternity leave, 7 days | RA 8187 | [Leave](modules/talent.md#leave) |
| Solo parent leave, 7 days | RA 11861 | [Leave](modules/talent.md#leave) |
| VAWC leave, 10 days | RA 9262 | [Leave](modules/talent.md#leave) |
| Special leave for women, up to 2 months | RA 9710 | [Leave](modules/talent.md#leave) |
| Holiday, rest day, overtime and night differential premiums | DOLE defaults (seeded) | [Pay computation per cut-off](modules/talent.md#pay-computation-per-cut-off) |
| Regional minimum wage, with a warning when a salary is below it | Wage orders (NCR seeded: NCR-26 and NCR-28, build step 2.3) | [Minimum wage check](modules/talent.md#minimum-wage-check), [Seeded payroll rates](#seeded-payroll-rates-build-step-23) |
| 13th month pay, paid on or before December 24 | PD 851 | [13th month pay](modules/talent.md#13th-month-pay) |
| Final pay within 30 days of separation | DOLE Labor Advisory No. 06-2020 | [Final pay](modules/talent.md#separation-final-pay--certificate-of-employment) |
| Certificate of Employment within 3 days of the request | DOLE Labor Advisory No. 06-2020 | [HR documents](modules/talent.md#hr-documents) |
| Just-cause dismissal: twin notices, at least 5 calendar days to reply | Labor Code Art. 297 | [Termination due process](modules/talent.md#termination-due-process) |
| Authorized-cause termination: 30-day notice to the employee and DOLE, and separation pay minimums | Labor Code Arts. 298–299 | [Termination due process](modules/talent.md#termination-due-process) |
| Holidays as declared by Presidential Proclamation. The seeded auto-draft types follow RA 9492 as amended for regular holidays; every draft is checked against the year's proclamation before it is confirmed | Official Gazette; RA 9492 as amended | [Holiday calendar](modules/core.md#holiday-calendar) |

The offset arrangement for Standard-timesheet positions (extra hours become offset time off instead of overtime pay) is company policy set in the employment contract. See [Extra hours: Standard timesheet (offset)](modules/talent.md#extra-hours-standard-timesheet-offset). Have it reviewed along with the contract templates.

## Government contributions

| Obligation | Where it's implemented |
|---|---|
| SSS, PhilHealth and Pag-IBIG employee and employer shares, plus the SSS EC contribution, from versioned tables | [Pay computation per cut-off](modules/talent.md#pay-computation-per-cut-off), [Employer contributions & monthly remittances](modules/talent.md#employer-contributions--monthly-remittances) |
| Monthly remittance reports in each agency's upload format, with due-date reminders | [Employer contributions & monthly remittances](modules/talent.md#employer-contributions--monthly-remittances) |
| Employer numbers (SSS, PhilHealth, Pag-IBIG) on reports | [Company details](modules/core.md#company-details-pending-from-the-client) |

## BIR (taxes)

| Obligation | Where it's implemented |
|---|---|
| Withholding tax on compensation (semi-monthly table). Minimum wage earners exempt | [Pay computation per cut-off](modules/talent.md#pay-computation-per-cut-off), [Compensation](modules/talent.md#compensation) |
| De minimis limits (RR 29-2025 seeded, build step 2.3), and the 13th month and other benefits ceiling | [Allowances](modules/talent.md#allowances), [13th month pay](modules/talent.md#13th-month-pay), [Seeded payroll rates](#seeded-payroll-rates-build-step-23) |
| BIR Form 1601-C monthly; 2316 per employee (and on separation); 1604-C and alphalist yearly | [Year-end](modules/talent.md#year-end), [Employer contributions & monthly remittances](modules/talent.md#employer-contributions--monthly-remittances) |
| VAT at 12%, or zero-rated or exempt per client; 2550Q with summary lists of sales and purchases | [Ledger](DATA_MODEL.md#ledger-pulse-fiscal), [Clients, sites and contacts](modules/engage.md#clients-sites-and-contacts), [BIR tax reports](modules/fiscal.md#bir-tax-reports) |
| Expanded withholding on supplier payments: ATC codes, 2307 to suppliers, 0619-E, 1601-EQ with QAP, 1604-E | [Supplier bills (AP)](modules/fiscal.md#supplier-bills-ap), [BIR tax reports](modules/fiscal.md#bir-tax-reports) |
| Creditable tax withheld by clients: track client 2307s, SAWT | [Collections](modules/fiscal.md#collections) |
| Invoices follow the BIR-registered series and show the required seller details | [Sales invoices (AR)](modules/fiscal.md#sales-invoices-ar) |
| Books of accounts: general journal, general ledger, sales, purchase, cash receipts and cash disbursements journals | [Financial reports and books](modules/fiscal.md#financial-reports-and-books) |
| Reimbursements backed by a receipt or invoice with merchant TIN and number, never claimed twice | [Reimbursements](modules/talent.md#reimbursements), [Reimbursement receipts](#reimbursement-receipts-build-step-25) |

### CAS/CBA registration

Pulse must not issue system-generated invoices or keep computerized books until the company has BIR's acknowledgment or permit for its computerized accounting system (CAS/CBA). Apply early. When it arrives, enter the details in company settings and set the invoice series to the registered one (see [Going live](DEPLOYMENT.md#going-live), item 8).

## Keeping rates current

- Every rate and table that changes by law is versioned configuration (see [Versioned configuration](DATA_MODEL.md#versioned-configuration)). A new issuance becomes a new effective-dated version, and existing versions are never edited.
- **Before the first real payroll**, HR checks the seeded SSS, PhilHealth, Pag-IBIG, BIR withholding and minimum wage tables against current issuances (build step 2.3). What was seeded, and how far it was verified, is in [Seeded payroll rates](#seeded-payroll-rates-build-step-23).
- **Before go-live**, every seeded rate is checked against its latest official issuance, including the VAT rate, ATC codes and EWT rates once Fiscal is in use (see [Going live](DEPLOYMENT.md#going-live), item 3).
- **When a new wage order takes effect**, HR reviews the employees who fall below it (see [Minimum wage check](modules/talent.md#minimum-wage-check)).
- **Every year**, HR confirms the holidays against the proclamation, checking each auto-draft's date and type and entering its legal basis (see [Holiday calendar](modules/core.md#holiday-calendar)). From build step 1.10 the auto-draft rules are versioned configuration (`core.holidayRules`); a holiday added or changed by law becomes a new version.

## Timesheet hours (build step 2.4)

Step 2.4 counts hours for display; pay follows in step 2.9 ([Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24)). Each rule below is an *Assumption, to be confirmed by HR or counsel* ([HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check), items 46–61):

- **Overtime is work beyond the day's scheduled hours** (Labor Code Art. 87, work beyond eight hours), counted as the day's last worked minutes. Starting early doesn't count unless the day's total exceeds the schedule, and a late start made up at the end of the day earns none, in line with Art. 88 (undertime isn't offset by overtime).
- **Every minute on a rest day or a holiday is extra work**, on both timesheet types, and counts only when the employee marks it with a reason. On a rest day or a holiday, the first `hoursPerDay` hours and the hours beyond are kept apart, since premiums differ (the payroll step applies them).
- **Holidays.** Only confirmed nationwide holidays apply; local holidays don't yet, as no work location is recorded. A special working day is an ordinary day. Two holidays on one date count as one holiday: a regular holiday when either is regular, otherwise a special day (double holiday pay isn't seeded, decision 210).
- **An entry past midnight** belongs to the day it started. DOLE practice splits holiday hours by calendar day, so check this before night work on a holiday eve is paid.
- **The break is unpaid** and deducted where entries overlap it, even when the employee works through it.
- **Night differential** (Labor Code Art. 86) counts paid hours inside the `talent.premiumRates` night window (10:00 PM to 6:00 AM): the scheduled worked minutes plus, on the Overtime timesheet, the claimed extra minutes. For Standard employees it counts the scheduled worked minutes only, since claimed extra minutes become offset hours, not pay; the DTR (step 2.7) uses that figure.
- **No minimum overtime block** and no rounding to 15 or 30 minutes: hours come from exact minutes. Seconds are dropped from each time in and time out, so a clocked 08:00:42 counts as 08:00.

## Attendance and the DTR (build step 2.7)

Step 2.7 derives the Daily Time Record and records attendance; the deductions at the daily rate follow in step 2.9 ([Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27)). Each rule below is an *Assumption, to be confirmed by HR or counsel* ([HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check), items 123–137):

- **Lates and the grace period.** A first time in more than the grace period (seeded 15 minutes) after the scheduled start counts as late from the scheduled start; within it, nothing is late. The grace period is company policy, not law.
- **Undertime and no make-up.** Scheduled minutes after the first time in that no entry covers are undertime, whether at the end or in the middle of the day. Work after the scheduled end doesn't offset a late start or undertime (Labor Code Art. 88: undertime isn't offset by overtime).
- **Absences.** A scheduled work day with no worked minutes and no approved leave or offset time off is absent (unpaid). A confirmed holiday is never an absence, worked or not. Whether an unworked regular holiday is paid depends on the day before (the 100% rule in [Pay computation per cut-off](modules/talent.md#pay-computation-per-cut-off)); step 2.9 applies it.
- **Offset hours** are credited only when HR approves the timesheet, and change afterwards only through a holiday change. They are never paid or converted to cash, so a holiday change adjusts them even for a finalized payroll period. The offset arrangement is company policy in the Standard-timesheet employment contract (see [Labor Code and DOLE](#labor-code-and-dole)).
- **Submission.** Late timesheets are accepted. Approval covers the whole timesheet; claimed overtime is paid only once the timesheet is approved ([Submission & approval](modules/talent.md#submission--approval)).

## Leave and time off (build step 2.8)

Step 2.8 records leave and offset time off and shows them on the DTR; pay for leave (including maternity pay and leave without pay) follows in step 2.9 ([Leave, offset time off and opening balances](modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28)). The seeded leave types are versioned configuration (`talent.leaveSettings`), so a change in the law is a new version, never a code change. The figures below were taken from the spec and from the laws as the agent understood them on 2026-10-18; **none was checked online**. Each is an *Assumption, to be confirmed by HR and counsel* ([HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check), items 150–180):

| Leave | Seeded as | Basis, as understood | To confirm |
|---|---|---|---|
| Vacation and sick leave | 5 days each a year, credited from the regularization date (prorated) and every January 1; carried over with no cap; never converted to cash; Regular employees only | Company policy (the spec) | The proration (nearest half day, halves up; the regularization month counts when on or before the 15th) |
| Service Incentive Leave | Not a separate type: the 5 days of VL stand in for it | Labor Code Art. 95 and its implementing rules (Book III, Rule V) | **Two conflicts with the spec** (decision 322): the rules make unused SIL commutable to cash at the end of the year, while the spec never converts leave to cash and carries it over; and SIL is due to every employee with a year of service, Contractual included, while VL is credited only from regularization. See [Open questions](#open-questions) |
| Maternity leave | 105 calendar days per pregnancy; 120 for a solo parent; 60 for a miscarriage or emergency termination; an optional 30-day extension without pay; for every female employee whatever her civil or employment status | RA 11210 (the 105-Day Expanded Maternity Leave Law) | Whether the 7 days a mother may allocate to the child's father (not seeded) are needed; how the SSS maternity benefit and the employer's salary differential are paid (step 2.9, with the accountant) |
| Paternity leave | 7 work days per delivery, at most 4 deliveries, male employees | RA 8187 (married employee, cohabiting with the spouse, the first four deliveries; HR checks the marriage and cohabitation, the app doesn't) | Whether the 7 days are work days or calendar days |
| Solo parent leave | 7 work days a year, after 6 months of service, with the Solo Parent ID | RA 11861 (the Expanded Solo Parents Welfare Act) | The service rule (6 months since the date hired) and the ID requirement |
| VAWC leave | 10 work days a year, female employees, with a barangay, police, prosecutor or court certification; confidential: HR approves, and the type is hidden from supervisors and Talent Read | RA 9262 Sec. 43 (up to 10 days, extendable when the protection order requires) and Sec. 44 (confidentiality) | The yearly limit (an extension needs HR to add a version or file another type), and that HR alone handles it |
| Special leave for women | 60 calendar days ("two months") per surgery, female employees, after 6 months of service, with a medical certificate | RA 9710 (the Magna Carta of Women) Sec. 18 | "Two months" as 60 days, and the service rule (the law counts 6 months of aggregate service in the last 12 months; the app counts 6 months since the date hired) |

- **Statutory leaves ignore probation.** They are open to Probationary, Regular and Contractual employees, as the spec says ("maternity leave applies regardless of employment status").
- **Medical certificates and the other attachments** are sensitive personal information (RA 10173): each opens only for the employee, HR, the System Administrator and the request's approvers, never Accounting, and every open is audit-logged ([Sensitive data](../SECURITY.md#sensitive-data)).
- **Offset time off** is company policy, never law: it must start after it is filed, so it never covers an absence, a late or undertime ([Labor Code and DOLE](#labor-code-and-dole)).
- **Leave without pay** is deducted at the daily rate (half for a half day) in step 2.9. A partly covered day's uncovered, unworked minutes are deducted at the hourly rate.

## Reimbursement receipts (build step 2.5)

Step 2.5 records reimbursement lines with their receipts; payment as a separate non-taxable line follows in step 2.9 ([Reimbursements](modules/talent.md#reimbursements-build-step-25)). Each rule below is an *Assumption, to be confirmed by the accountant* ([HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check), items 62–65 and 73):

- **Invoices count as receipts.** Under RA 11976 (the Ease of Paying Taxes Act) and RR 7-2024, the invoice replaced the official receipt as the primary document from April 2024. The field reads "Receipt or invoice number" and takes either.
- **The merchant TIN includes the branch code.** BIR requires the seller's TIN with its branch code on an invoice, and invoice series are registered per branch. A TIN typed without a branch code counts as the head office (`00000`); a 3-digit branch code is padded to 5 digits.
- **The receipt number matches** ignoring case, separators and leading zeros.
- **The receipt isn't checked for the buyer.** The app doesn't check that it is made out to the company's name or TIN, though that may be needed for the reimbursement to be a deductible business expense and to stay non-taxable to the employee (substantiated expenses of the employer).
- **No receipt, no claim.** Every type needs a receipt with a merchant TIN and number, so a ride with no receipt (jeepney, tricycle) can't be claimed.
- **Retention** of receipt images is an open question, with the other payroll and accounting records ([Open questions](#open-questions)).

## Seeded payroll rates (build step 2.3)

`pnpm seed:admin` seeds these as versioned settings ([Payroll settings and allowances](modules/talent.md#payroll-settings-and-allowances-build-step-23)). They were checked on **2026-10-12** against the issuances found online. **Every figure is an *Assumption, to be confirmed by HR or the accountant*,** whatever its verification status. Each version's `source` holds the issuance and the link below.

Verification status:

- **Official:** read on the issuing agency's website.
- **Secondary:** confirmed by a news agency, a professional firm or payroll guides, but the issuance itself wasn't read.
- **Spec:** taken from the spec, not re-checked.

| Setting | Seeded | Issuance | Effective | Source | Status |
|---|---|---|---|---|---|
| SSS (`talent.sssContributions`) | MSC ₱5,000 to ₱35,000 in ₱500 steps (compensation below ₱5,250 → ₱5,000; ₱34,750 and up → ₱35,000; each MSC covers ₱250 either side). 15% of the MSC: employee 5%, employer 10%. Regular SS up to an MSC of ₱20,000, the rest MPF. EC ₱10 below an MSC of ₱15,000, ₱30 from ₱15,000 | SSS Circular No. 2024-006, Schedule of SSS Contributions for All Business Employers and Employees Effective January 2025 | 2025-01-01 | [sss.gov.ph circulars](https://www.sss.gov.ph/sss-circulars/) | Official: the circular is listed as the latest schedule, and SSS Circular No. 2026-002 (pension reform) changes no contribution. The row figures follow the published schedule and weren't re-read |
| PhilHealth (`talent.philhealthContributions`) | 5% of the monthly basic salary, half each; floor ₱10,000, ceiling ₱100,000 (₱500 to ₱5,000 a month) | PhilHealth Circular No. 2020-0005 (Revision 1), under RA 11223; confirmed for 2025 by PhilHealth Advisory No. 2025-0002 | 2024-01-01 | [PA2025-0002](https://www.philhealth.gov.ph/advisories/2025/PA2025-0002.pdf) | Official for 2025. 2026 unchanged per secondary sources and PhilHealth Advisory No. 2026-0042, which couldn't be read |
| Pag-IBIG (`talent.pagibigContributions`) | Employee 1% and employer 2% up to ₱1,500; 2% and 2% above; maximum fund salary ₱10,000 (₱200 each at most) | HDMF Circular No. 460 | 2024-02-01 | [PNA](https://www.pna.gov.ph/articles/1217214) | Secondary. No later change found for 2026 |
| BIR withholding (`talent.withholdingTaxSemiMonthly`) | Semi-monthly: ₱10,417 and below, nil; over ₱10,417, 15% of the excess; over ₱16,667, ₱937.50 + 20%; over ₱33,333, ₱4,270.70 + 25%; over ₱83,333, ₱16,770.70 + 30%; over ₱333,333, ₱91,770.70 + 35% | RR 11-2018 Annex E, under RA 10963 (TRAIN), the table from January 1, 2023 | 2023-01-01 | [payroll guide](https://www.pesohub.ph/government/bir/withholding-tax-table-philippines/) | Secondary. No newer table found |
| Minimum wage, NCR (`talent.minimumWages`) | ₱695 a day (non-agriculture) | Wage Order No. NCR-26 | 2025-07-18 | [NWPC NCR](https://nwpc.dole.gov.ph/ncr/) | Secondary for the date; the ₱695 base is on NWPC's matrix |
| Minimum wage, NCR (`talent.minimumWages`) | ₱755 a day (non-agriculture; ₱718 for agriculture and small retail, service and manufacturing employers, not seeded) | Wage Order No. NCR-28, issued 2026-09-07, published 2026-09-11 | 2026-09-26 | [NWPC NCR](https://nwpc.dole.gov.ph/ncr/), [Wage Order NCR-28](https://nwpc.dole.gov.ph/wp-content/uploads/2026/09/Wage-Order-No.-NCR-28.pdf) | Official. Wage Order NCR-27 (₱755 from 2026-07-25, then ₱780 from 2027-01-20) is **not seeded**: a Pasig RTC injunction blocked it, NCR-28 replaced it, and its case is before the Supreme Court. If the Court revives it, HR adds a new version |
| De minimis (`talent.deMinimisLimits`) | Rice ₱2,500 a month; uniform and clothing ₱8,000 a year; medical cash allowance to dependents ₱2,000 a semester; actual medical assistance ₱12,000 a year; laundry ₱400 a month; employee achievement awards ₱12,000 a year; Christmas and major anniversary gifts ₱6,000 a year; overtime or night-shift meals up to 30% of the regional basic minimum wage a day; CBA and productivity incentives ₱12,000 a year combined | RR 29-2025, issued 2025-12-22, amending RR 2-98 as last amended by RR 4-2025 | 2026-01-06 | [Grant Thornton](https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/updated-de-minimis-benefits-threshold/) | Secondary. Monetized unused leave (12 days) isn't seeded |
| 13th month and other benefits (`talent.thirteenthMonthExemption`) | ₱90,000 | RA 10963 (TRAIN) | 2018-01-01 | RA 10963 | Secondary. House Bill 7661 (₱150,000) is pending, not law |
| Premium rates (`talent.premiumRates`) | Regular holiday 200% worked, 100% unworked; special day 130% worked, 0% unworked; rest day 130%; special day on a rest day 150%; regular holiday on a rest day 260%; overtime +25% (ordinary days), +30% (rest days and holidays); night differential +10%, 10:00 PM to 6:00 AM | Labor Code and DOLE defaults, as in the spec | 2000-01-01 (seed policy date) | [Pay computation per cut-off](modules/talent.md#pay-computation-per-cut-off) | Spec. Check this year's DOLE holiday pay advisory |
| Pay schedule, factor and split (`talent.payrollSettings`) | 26th–10th paid on the 15th; 11th–25th paid on the 30th (the last day of a shorter month); factor 261; 8 hours; contributions half in each cut-off; no moving for weekends or holidays | Company policy | 2000-01-01 | [Pay schedule](modules/talent.md#pay-schedule) | Spec, plus the no-moving assumption |
| Internet allowance (`talent.allowanceTypes`) | ₱500 per cut-off (₱1,000 a month), non-taxable, automatic from the date hired | Company policy | 2000-01-01 | [Allowances](modules/talent.md#allowances) | Spec. The non-taxable treatment needs the accountant, since an internet allowance isn't BIR de minimis |

## Inputs to get before building

| Needed | Before | Source |
|---|---|---|
| Confirmation of the government ID and bank account number formats, and of the date of birth and civil status handling, assumed in build step 2.1 ([HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check)) | Before HR enters real records | HR, counsel, UnionBank and RCBC |
| SSS, PhilHealth and Pag-IBIG upload file specifications | Build step 2.11 | Each agency |
| BIR alphalist format | Build step 2.12 | BIR |
| BIR data file formats for VAT and withholding reports | Build step 5.12 | BIR |
| Company registration numbers and BIR registration details | Go-live | The company ([Company details](modules/core.md#company-details-pending-from-the-client)) |

## Open questions

The spec doesn't cover these yet. Confirm them with the company's accountant or counsel:

1. **Retention of payroll, tax and accounting records.** The spec keeps employee records indefinitely but says nothing about payslips, payroll runs, invoices, books or receipt images.
2. **Data Privacy Act duties beyond data handling.** The spec doesn't cover a privacy notice to employees, a Data Protection Officer, or a procedure for reporting a personal data breach to the National Privacy Commission.
3. **Consent for client signatures captured on phones.** Delivery receipts, acceptance certificates and service reports store client representatives' names and signatures.
4. **Uploaded e-signature images** (build step 2.2). Employees upload an image of their signature, and the app applies it on their own action, recording the version used. *Assumption, to be confirmed by counsel:* this is enough for approvals now, and for HR documents, contracts and the other signed documents later, under RA 8792 (the E-Commerce Act) and the Rules on Electronic Evidence.
5. **Service Incentive Leave** (build step 2.8). The spec meets the Labor Code's 5-day SIL with paid VL, never converts leave to cash, and credits VL only from regularization. The implementing rules make unused SIL commutable to cash at the end of the year and give it after one year of service, Contractual employees included. Confirm whether carrying VL over satisfies the law, and whether Contractual employees with a year of service need VL or SIL ([Leave and time off](#leave-and-time-off-build-step-28)).
