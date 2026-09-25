# Pulse Fiscal (Finance & Accounting)

Xtreme Pulse becomes the company's books, replacing the current Excel-based accounting. The fiscal year is January to December (a setting).

Built in [Phase 5](../BUILD_PLAN.md#phase-5-pulse-fiscal). Route: `/fiscal`. Package: `packages/fiscal`. Ledger rules (append-only entries, balanced debits and credits) are in [Ledger data rules](../DATA_MODEL.md#ledger-pulse-fiscal), and the BIR obligations behind these screens are listed in [COMPLIANCE.md](../COMPLIANCE.md#bir-taxes).

## Chart of accounts and ledger

- Seed a standard Philippine chart of accounts (assets, liabilities, equity, revenue, cost of sales, expenses). Accounts are data (code, name, type, parent, active) that Fiscal Owners can edit.
- Every financial event in other modules posts a balanced journal entry through Fiscal's service functions: sales invoices, collections, supplier bills, payments, payroll runs, final pay, petty cash and project costs. See the [Ledger data rules](../DATA_MODEL.md#ledger-pulse-fiscal) (append-only, corrections by reversal, debits equal credits).
- Journal lines can carry dimensions for reporting: project, client, supplier, business line and department. Payroll runs post company-wide totals per account, never split by employee or department, so no one's pay can be read from the ledger.
- **Manual journal entries** (`JE-YYYY-NNNN`): drafted by Fiscal Write users with a description and attachments; posted by a Fiscal Owner.
- **Period close:** a Fiscal Owner closes each month. A closed period accepts no new postings; corrections go into the current open period. Year-end closing moves net income to retained earnings.

## Going live (replacing Excel)

- A one-time import from Excel templates: opening balances per account as of the go-live date, open client invoices (for AR aging), open supplier bills (for AP aging) and bank balances.
- The import is rejected unless the opening balances balance (debits equal credits) and the open invoices and bills agree with the AR and AP control accounts.

## Sales invoices (AR)

- Created from billing milestones marked Ready to bill in Pulse Ops, from Pulse Desk (support contract billing and approved chargeable work), or manually for other sales.
- The invoice number series (prefix and next number) is a setting, so it can follow the BIR-registered series.
- VAT follows the client's VAT treatment (see [Clients, sites and contacts](engage.md#clients-sites-and-contacts)). The invoice shows VATable sales, VAT, zero-rated and VAT-exempt amounts separately; milestone amounts for VAT-registered clients include VAT, and Fiscal splits it out.
- The client's credit terms (days; see [Clients, sites and contacts](engage.md#clients-sites-and-contacts)) set the due date. Clients without credit terms use the default credit term, a Fiscal setting seeded at 30 days. Overdue invoices are flagged.
- Every invoice shows its **status** in the list and on the invoice: Draft → Issued → Partially paid → Paid, or Cancelled. **Overdue** is shown automatically for an Issued or Partially paid invoice past its due date. A cancelled invoice keeps its number and is voided, never deleted.
- **Exports:** each invoice exports individually as a PDF; any filtered list of invoices (e.g. by date range, client, project or status) exports together as one Excel file with one row per invoice. The PDF template includes the BIR-required seller details from company settings (registered name, TIN, address and BIR registration details).
- When a milestone's invoice is fully paid, the milestone shows Paid in Pulse Ops.

## Collections

- Payments received are recorded against one or more invoices (`CR-YYYY-NNNN`): date, amount, method (bank transfer, check, cash), reference (e.g. check number or bank reference) and the bank account it was deposited to.
- **Creditable withholding tax:** when a client withholds tax (e.g. 1% or 2%), the withheld amount is recorded on the collection, and the client's **BIR Form 2307** is tracked as received or missing, with reminders for missing ones. These feed the SAWT.

## Supplier bills (AP)

- Supplier bills are entered against POs. Serialized and bulk lines use a **three-way match** of PO, receiving record and bill (quantities and amounts); mismatches are flagged for Accounting.
- Non-stock PO lines (services, subcontractors and licenses) use a two-way match of PO and bill, plus a confirmation that the work or item was delivered: by the project lead for project POs, or by the purchase request's requester for POs with no project (see [Confirming non-stock purchases](../../SECURITY.md#exceptions-to-module-access)).
- Bills without a PO (e.g. utilities, rent) are entered directly against an expense account.
- Input VAT is captured on each bill.
- **Expanded withholding tax (EWT):** each bill line has a BIR ATC code and rate from versioned configuration. EWT is deducted when the bill is paid, and a **BIR Form 2307** is generated for the supplier. These feed the 0619-E, 1601-EQ and QAP.

## Payments (disbursements)

- Accounting prepares a payment on a disbursement voucher (`DV-YYYY-NNNN`): one or more bills for a supplier, or another disbursement, with the amount net of EWT, the bank account, the method (bank transfer or check) and the check number.
- **Approval:** both the **Managing Director** and the **Sales Director** must approve the payment before it is released, in either order; either one can return it with remarks, which sends it back to Accounting. Both approvers' e-signatures are applied to the voucher. Which positions approve payments is a setting.
- Payroll net pay, approved final pay, and statutory remittances (SSS, PhilHealth, Pag-IBIG and BIR taxes) are recorded as disbursements without a second approval, since their amounts were already approved by the Board (payroll runs, final pay, and the payments they were withheld from).

## Bank accounts and reconciliation

- Company bank accounts are data (bank, account name, account number, linked ledger account). Balances are derived from postings.
- Bank statement files (CSV or Excel) are imported and matched to recorded collections and payments, with suggested matches by amount, date and reference. Bank charges and interest are recorded from the statement. Unmatched lines are listed, and each month is marked reconciled when everything matches.

## Petty cash

- Petty cash funds are data (fund name, custodian, fund amount).
- Expenses paid from petty cash are recorded on petty cash vouchers (`PCV-YYYY-NNNN`) with the receipt details (merchant, merchant TIN, receipt number, amount, photo), under the same no-duplicate receipt rule as reimbursements.
- Replenishment totals the vouchers since the last replenishment and is paid through the normal payment flow, so it needs the Managing Director's and the Sales Director's approval.

## BIR tax reports

- **VAT:** quarterly BIR Form 2550Q data, with the summary lists of sales and purchases.
- **Expanded withholding:** monthly 0619-E and quarterly 1601-EQ data with the QAP, and the annual 1604-E.
- **Creditable withholding received:** the SAWT.
- **Withholding on compensation:** the 1601-C, 2316, 1604-C and alphalist are produced by Pulse Talent from payroll; Fiscal lists them alongside the other BIR reports, read-only.
- Every report exports as PDF and Excel, and in BIR's data file formats where BIR requires them. Due dates are configurable, with reminders. Tax rates, ATC codes and forms are versioned configuration, never hardcoded.

## Financial reports and books

- Balance sheet, income statement (monthly, quarterly and yearly, with comparisons), trial balance, general ledger detail, AR and AP aging, cash position, and income by business line and by project.
- Books of accounts: general journal, general ledger, sales journal, purchase journal, cash receipts journal and cash disbursements journal.
- Every report and book exports as PDF and Excel.

## Access

- Fiscal Read, Write and Owner follow [Module access](../../SECURITY.md#module-access-rwo). Fiscal Owners manage the chart of accounts, post manual journal entries and close periods. Payment approval is reserved for the Managing Director and the Sales Director.

## Notifications

- **Accounting:** milestones ready to bill, overdue invoices, client 2307s not yet received, bills waiting for a match, tax due dates, bank reconciliation pending, month-end close reminders.
- **Managing Director and Sales Director:** payments waiting for their approval; **Accounting** is told when a payment is fully approved or returned.
- **Deal owner and project lead:** an invoice for their project paid.
