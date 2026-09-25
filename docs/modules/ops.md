# Pulse Ops (Project Delivery)

Runs every project from kickoff to handover. A project is created from a won deal in Pulse Engage.

Built in [Phase 4](../BUILD_PLAN.md#phase-4-pulse-ops-and-pulse-supply), together with Pulse Supply. Route: `/ops`. Package: `packages/ops`.

## Projects and stages

- Created automatically when a deal is marked Won (see [Won deals → Pulse Ops](engage.md#won-deals--pulse-ops)), linked to the deal, client, sites, accepted quotation and the deal's pre-sale site surveys. Number `PRJ-YYYY-NNNN`.
- Stages (configurable data, in this order): **Kickoff → Site survey → Procurement → Installation → Testing and commissioning → Handover → Closed**. At any stage a project can be put **On hold** or **Cancelled**, each with a reason.
- Each project has: name, client, sites, business line and products (from the deal), project lead, project team, start and target end dates, contract value (the accepted quotation's total), billing milestones, stage, and an activity history.
- **Visibility** follows the same pattern as deals: everyone with Pulse Ops access sees the project list; the project team, Ops Owners and the System Administrator can open a project's details, and the deal owner can open it read-only (see [Module access](../../SECURITY.md#module-access-rwo)). Team members need Ops Write to update the project, and Read to view it. Filing site reports and checklists on an assigned project is self-service and needs no Ops access.

## Project lead and team

- **Project lead:** chosen per project from employees in the **Network** or **Data Center** departments, or with the **Business Development Manager** position. Which departments and positions can lead is a setting.
- The lead and Ops Owners add engineers and technicians to the project team.

## Billing milestones (from payment terms)

- Payment terms are agreed during the sales cycle, on the quotation (see [Quotations](engage.md#quotations)).
- When the project is created, each payment term becomes a **billing milestone**: name, percentage, amount and trigger. The contract value is the accepted quotation's total as quoted to the client (VAT included where the client is VAT-registered); each amount is its percentage of that total, rounded half-up to the centavo, and the last milestone takes the remainder so the amounts always add up to the contract value exactly. Pulse Fiscal shows the VAT on each invoice.
- When a trigger is met (e.g. delivery recorded, or the client's acceptance at Handover), the milestone becomes **Ready to bill** and Pulse Fiscal creates the invoice through its service functions. Until Fiscal is built, Ops shows a "Ready to bill" list for Accounting. An "upon delivery" milestone is met when the project's delivery status is complete (every serialized and bulk line on the accepted quotation delivered on signed delivery receipts, and every free-text line marked delivered by the project lead; see [Delivery status](supply.md#delivery-receipts)) or the project lead marks delivery complete.
- **Upon PO or downpayment** becomes Ready to bill when the project is created, and **upon installation** when the project moves past the Installation stage. The project lead can also mark either one met early. The other triggers are unchanged: upon delivery (above), upon acceptance (see [Handover and acceptance](#handover-and-acceptance)) and on a set date.
- Milestone status: Pending → Ready to bill → Invoiced → Paid (Invoiced and Paid are set by Fiscal).

## Scheduling

- A calendar of assignments: person, project or support ticket, site, date and time, and task.
- Approved leave and offset time off (from Pulse Talent) block people out. Double-booking (same person, overlapping times) is prevented. When assigning, the calendar shows who is available and who holds the relevant certifications (see [Skills & certifications](talent.md#skills--certifications)).
- People see their assignments in self-service and on their phone, and an assignment pre-fills the client and project on their timesheet entry.

## Daily site reports and checklists

- Each assigned person, or the lead, files a **daily site report** per project site and day: work done, photos, issues and blockers, next steps, and who was on site. Reports are designed to be filed from a phone; photos are saved in [file storage](../ARCHITECTURE.md#file-storage).
- **Checklists** per business line are configurable templates (e.g. CCTV installation, POS terminal deployment, network cutover, precision cooling installation). They are completed per site, with pass / fail / not applicable and photos per item.

## Equipment installed (with Pulse Supply)

- Items delivered to the client on delivery receipts, or issued to the project for installation, are recorded by serial number (see [Delivery receipts](supply.md#delivery-receipts)). A signed delivery receipt places each serial at the client site as delivered; when the team installs it, its status there changes to installed. Items issued to the project directly (not delivered on a receipt) are placed at the site when installed (see the [Inventory data rules](../DATA_MODEL.md#inventory-pulse-supply)).
- The project shows what was issued, installed, returned or still pending, per site.

## Multi-site rollouts

- For projects covering many sites (e.g. Verifone terminals for 200 merchant sites, CCTV for bank branches), a **rollout tracker** lists every site with its status: Not scheduled → Scheduled → Installed → Completed, or Failed → Revisit needed. Each site shows the date, assigned people, serials installed and notes.
- A progress summary (sites completed of total), filters by status, city and assignee, and import of the site list from an Excel file (new sites are created through Pulse Core's service functions, since sites are Core master data).

## Handover and acceptance

- At Handover, the lead records the client's acceptance: a signed acceptance or completion certificate uploaded (signed on paper), or signed on-site on a phone (the client representative's name, position, signature and date). The project lead's e-signature is applied to the acceptance or completion certificate next to the client's signature.
- For multi-site projects, acceptance is recorded per site or for the whole project (a setting per project). With per-site acceptance, acceptance-based billing milestones become Ready to bill when the last site is accepted, and each site's warranties start on that site's acceptance date.
- Acceptance makes acceptance-based billing milestones Ready to bill, and starts the **warranty in Pulse Desk** through Desk's service functions (paid support contracts are sold separately; see [Warranties, support contracts and subscriptions](desk.md#warranties-support-contracts-and-subscriptions)). Until Desk is built, the project shows "Warranty to start".

## Project costs

- Pulse Fiscal owns the accounting entries for project costs. Ops only shows the project cost view, reading each source through that module's service functions.
- Each project shows its actual costs against the contract value, by category:
  - **Equipment:** the weighted average cost of items delivered or issued to the project (from Pulse Supply)
  - **Reimbursements:** approved reimbursements tagged to the project (from timesheets)
  - **Overtime:** approved overtime hours worked on the project (from Pulse Talent). The peso cost of that overtime is shown only to Board of Directors members, HR, Accounting and the System Administrator, and only as a project total.
  - **Subcontractors:** purchase orders raised for the project in Pulse Supply; until Supply and Fiscal exist, Ops Owners enter them manually
  - **Licenses and other non-stock items:** non-stock lines on POs raised for the project, other than subcontractors
- Once subcontractor POs feed the cost view, an Ops Owner links each manual subcontractor row to its PO or marks it "no PO". Linked rows stop counting, because the PO and its bills replace them; "no PO" rows keep counting.
- Shows total cost, contract value and the difference. Regular salaries are not included (there are no internal cost rates).
- Visible to the project lead, Ops Owners, the System Administrator, and Board of Directors members, HR and Accounting staff who have at least Ops Read. The project lead and Ops Owners see overtime as hours, and their total cost excludes overtime pay, so no one's pay can be worked out from a project (see [Sensitive data](../../SECURITY.md#sensitive-data)).
- Offset hours that Standard-timesheet staff work on the project are shown as hours only, with no cost.

## Notifications

- **Assigned people:** new or changed assignments, daily site report not yet filed.
- **Project lead:** rollout sites failed or needing a revisit, checklist items failed, milestones ready to bill, non-stock purchases (service work, licenses) waiting for their confirmation.
- **Accounting:** milestones ready to bill.
- **Deal owner:** project stage changes, acceptance recorded.
