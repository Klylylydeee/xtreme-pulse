# Compliance

The Philippine legal and regulatory obligations Xtreme Pulse implements. Each row gives the legal basis the spec cites and links to the rule that implements it. The rule itself lives in the linked section. This file is the register.

> This register is a developer's map, not legal advice. Have HR, the company's accountant or counsel confirm the obligations, and check rates against current issuances before go-live.

## Data Privacy Act of 2012 (RA 10173)

| Obligation | Where it's implemented |
|---|---|
| Treat salary, allowances, payslips, government IDs, bank accounts, medical certificates, 201 files and disciplinary cases as sensitive personal information: encrypted, access-limited, masked, reveals audit-logged | [Sensitive data](../SECURITY.md#sensitive-data) |
| Keep sensitive files private: never publicly reachable, opened only after an access check | [Sensitive data](../SECURITY.md#sensitive-data), [File storage](ARCHITECTURE.md#file-storage) |
| Never send raw sensitive fields to analytics or dashboards | [Sensitive data](../SECURITY.md#sensitive-data), [Who sees what](modules/insight.md#who-sees-what) |
| Pay can't be worked out from the ledger or project costs | [Chart of accounts and ledger](modules/fiscal.md#chart-of-accounts-and-ledger), [Project costs](modules/ops.md#project-costs) |

## Record retention

- Employee records are retained indefinitely. Never delete or auto-archive employees, including separated ones; they remain as deactivated users.

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
| Regional minimum wage | Wage orders (NCR seeded) | [Minimum wage check](modules/talent.md#minimum-wage-check) |
| 13th month pay, paid on or before December 24 | PD 851 | [13th month pay](modules/talent.md#13th-month-pay) |
| Final pay within 30 days of separation | DOLE Labor Advisory No. 06-2020 | [Final pay](modules/talent.md#separation-final-pay--certificate-of-employment) |
| Certificate of Employment within 3 days of the request | DOLE Labor Advisory No. 06-2020 | [HR documents](modules/talent.md#hr-documents) |
| Just-cause dismissal: twin notices, at least 5 calendar days to reply | Labor Code Art. 297 | [Termination due process](modules/talent.md#termination-due-process) |
| Authorized-cause termination: 30-day notice to the employee and DOLE, and separation pay minimums | Labor Code Arts. 298–299 | [Termination due process](modules/talent.md#termination-due-process) |
| Holidays as declared by Presidential Proclamation | Official Gazette | [Holiday calendar](modules/core.md#holiday-calendar) |

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
| De minimis limits, and the 13th month and other benefits ceiling | [Allowances](modules/talent.md#allowances), [13th month pay](modules/talent.md#13th-month-pay) |
| BIR Form 1601-C monthly; 2316 per employee (and on separation); 1604-C and alphalist yearly | [Year-end](modules/talent.md#year-end), [Employer contributions & monthly remittances](modules/talent.md#employer-contributions--monthly-remittances) |
| VAT at 12%, or zero-rated or exempt per client; 2550Q with summary lists of sales and purchases | [Ledger](DATA_MODEL.md#ledger-pulse-fiscal), [Clients, sites and contacts](modules/engage.md#clients-sites-and-contacts), [BIR tax reports](modules/fiscal.md#bir-tax-reports) |
| Expanded withholding on supplier payments: ATC codes, 2307 to suppliers, 0619-E, 1601-EQ with QAP, 1604-E | [Supplier bills (AP)](modules/fiscal.md#supplier-bills-ap), [BIR tax reports](modules/fiscal.md#bir-tax-reports) |
| Creditable tax withheld by clients: track client 2307s, SAWT | [Collections](modules/fiscal.md#collections) |
| Invoices follow the BIR-registered series and show the required seller details | [Sales invoices (AR)](modules/fiscal.md#sales-invoices-ar) |
| Books of accounts: general journal, general ledger, sales, purchase, cash receipts and cash disbursements journals | [Financial reports and books](modules/fiscal.md#financial-reports-and-books) |
| Reimbursements backed by a receipt with merchant TIN and OR number, never claimed twice | [Reimbursements](modules/talent.md#reimbursements) |

### CAS/CBA registration

Pulse must not issue system-generated invoices or keep computerized books until the company has BIR's acknowledgment or permit for its computerized accounting system (CAS/CBA). Apply early. When it arrives, enter the details in company settings and set the invoice series to the registered one (see [Going live](DEPLOYMENT.md#going-live), item 8).

## Keeping rates current

- Every rate and table that changes by law is versioned configuration (see [Versioned configuration](DATA_MODEL.md#versioned-configuration)). A new issuance becomes a new effective-dated version, and existing versions are never edited.
- **Before the first real payroll**, HR checks the seeded SSS, PhilHealth, Pag-IBIG, BIR withholding and minimum wage tables against current issuances (build step 2.3).
- **Before go-live**, every seeded rate is checked against its latest official issuance, including the VAT rate, ATC codes and EWT rates once Fiscal is in use (see [Going live](DEPLOYMENT.md#going-live), item 3).
- **When a new wage order takes effect**, HR reviews the employees who fall below it (see [Minimum wage check](modules/talent.md#minimum-wage-check)).
- **Every year**, HR confirms the holidays against the proclamation (see [Holiday calendar](modules/core.md#holiday-calendar)).

## Inputs to get before building

| Needed | Before | Source |
|---|---|---|
| SSS, PhilHealth and Pag-IBIG upload file specifications | Build step 2.11 | Each agency |
| BIR alphalist format | Build step 2.12 | BIR |
| BIR data file formats for VAT and withholding reports | Build step 5.12 | BIR |
| Company registration numbers and BIR registration details | Go-live | The company ([Company details](modules/core.md#company-details-pending-from-the-client)) |

## Open questions

The spec doesn't cover these yet. Confirm them with the company's accountant or counsel:

1. **Retention of payroll, tax and accounting records.** The spec keeps employee records indefinitely but says nothing about payslips, payroll runs, invoices, books or receipt images.
2. **Data Privacy Act duties beyond data handling.** The spec doesn't cover a privacy notice to employees, a Data Protection Officer, or a procedure for reporting a personal data breach to the National Privacy Commission.
3. **Consent for client signatures captured on phones.** Delivery receipts, acceptance certificates and service reports store client representatives' names and signatures.
