# Pulse Supply (Inventory & Procurement)

Xtreme Works rarely keeps stock: brand principals and distributors deliver to the office, and the items go straight to the client. Supply tracks every unit from purchase to delivery, so the team can always confirm what was ordered, received, delivered and still pending.

Built in [Phase 4](../BUILD_PLAN.md#phase-4-pulse-ops-and-pulse-supply), together with Pulse Ops. Route: `/supply`. Package: `packages/supply`. The stock and serial rules every movement follows are in [Inventory data rules](../DATA_MODEL.md#inventory-pulse-supply).

## Suppliers

- Suppliers are Pulse Core master data, managed from Supply through Core's service functions.
- Each supplier: name, TIN, address, payment terms, contacts, the products (brands) they supply, supplier type (distributor, brand principal, subcontractor, other) and notes.
- Supply Owners create, edit, retire and restore suppliers and catalog items; Supply Read lists them. The System Administrator also manages them on `/admin/suppliers` and `/admin/catalog-items` (from build step 1.8, before Supply's own screens in step 4.4). Retiring, uniqueness and audit are in [Managing master data](core.md#managing-master-data).

Field rules (build step 1.8):

- **Name:** required, unique ignoring case, retired suppliers included (re-adding a retired name points to Restore).
- **TIN:** optional, with the same format and display as a client's ([Clients, sites and contacts](engage.md#clients-sites-and-contacts)). Not unique. Company data, not [sensitive personal data](../../SECURITY.md#sensitive-data).
- **Payment terms:** optional, a whole number of days from 0 to 365.
- **Contacts:** kept on the supplier, at most 20, each with a name (required), position, email and mobile, checked like a client contact's. Suppliers have no primary contact.
- **Products supplied:** optional, any number. A newly picked product must be live; a product retired later stays on the supplier and shows "Retired".
- **Supplier type:** `distributor`, `brandPrincipal`, `subcontractor` or `other` (a fixed set), distributor by default.
- **Address and notes:** optional free text.

## Purchase requests

- Anyone with Pulse Supply Write access raises a purchase request (`PR-YYYY-NNNN`): items (catalog items or free text), quantities, needed-by date, project (optional) and reason.
- From a project, a purchase request can be created from the accepted quotation's lines, pre-filled with the items and quantities, then edited. The project lead can raise purchase requests for their own project this way even without Pulse Supply access.
- Approved by any one supervisor in the requester's `reportingTo`, or returned with remarks. A requester with an empty `reportingTo` skips this step.
- Someone with Supply Owner access converts approved requests into purchase orders; one request can be split across several suppliers.

## Purchase orders

- `PO-YYYY-NNNN`: supplier, items with quantity and unit cost (PHP), VAT, delivery address, expected delivery date, payment terms, and the linked purchase requests and project.
- **Approval:** any one Board of Directors member approves the PO or returns it with remarks before it is sent. It is generated as a PDF from an editable template with company details, and the approver's e-signature is applied.
- Status: Draft → Pending approval → Approved → Sent → Partially received → Received → Closed, or Cancelled. A confirmed non-stock line counts as received for PO status (see [Confirming non-stock purchases](../../SECURITY.md#exceptions-to-module-access)), so a PO with only services or licenses moves to Received once every line is confirmed.
- POs to subcontractors (supplier type subcontractor) are services, not stock. They count toward the project's subcontractor costs (see [Project costs](ops.md#project-costs)).

## Receiving

- Goods are received against a PO, fully or partially, on a receiving record (`RCV-YYYY-NNNN`): date, received by, the supplier's delivery or invoice number, items and quantities.
- Serial numbers are typed in or scanned (barcode scanner or phone camera) for serialized items; each gets its serial record (see the [Inventory data rules](../DATA_MODEL.md#inventory-pulse-supply)).
- Receiving adds the items to office stock as a receipt movement. Shortages, extra items and damaged items are recorded on the receiving record.
- Client-owned units that arrive without a PO (e.g. bank-owned terminals delivered to the office for deployment) are received on a client-owned receipt movement with no PO. That receipt creates their serial records.

## Stock

- **Locations** are data: Office (where deliveries arrive) and In transit, so a warehouse can be added later without a code change.
- Every catalog item has an **item kind**: **serialized** (tracked by serial number), **bulk** (cables, connectors, consumables, tracked by quantity) or **non-stock** (services and licenses). Non-stock items never go on a delivery receipt or into stock.
- **Catalog item fields** (build step 1.8): product, part number, description, unit and item kind are required. The product must be live when the item is added. The part number is unique within its product ignoring case, retired items included. The unit is free text, with suggestions (pc, unit, set, lot, box, roll, m, license, service). The item kind is `serialized`, `bulk` or `nonStock` (a fixed set). **Default warranty months** is a whole number from 0 to 120, 12 by default; choosing non-stock sets it to 0, and it can still be changed. The product and the item kind are fixed once the item is created; to change either, add a new item. Retiring and access are in [Managing master data](core.md#managing-master-data).
- **Ownership:** every unit or quantity is company-owned or client-owned. Client-owned stock (e.g. bank-owned POS terminals waiting to be deployed) is tracked the same way but never counts toward inventory value. Client-owned units add nothing to a project's equipment cost.
- **Costing:** weighted average cost in PHP per catalog item, updated on each receipt. The cost of items delivered or issued to a project feeds the project's equipment cost.
- There are no low-stock alerts or reorder points, since the company rarely keeps stock.
- Views per item and per project show ordered, received, delivered, on hand, and still to deliver.

## Delivery receipts

- Items go to the client on a **delivery receipt** (`DR-YYYY-NNNN`): client, site, project, items with quantities and serial numbers, delivered by, date and notes. Partial deliveries are allowed, and a project can have many delivery receipts.
- Someone with Supply Write prepares the delivery receipt and names the delivering employee (e.g. a Driver or technician). The delivering employee captures the client's signature and applies their own e-signature from their phone as self-service, with no Supply access needed.
- The client signs on paper (scanned and uploaded) or on a phone at the site (name, position, signature, date). The delivering employee's e-signature is applied too. The PDF comes from an editable template with company details.
- A signed delivery receipt creates the delivery movement: serials move to the client site in their status history, and quantities leave stock.
- **Delivery status** per project compares what the accepted quotation calls for with what was ordered, received and delivered, so the team can confirm everything was delivered and see what's still pending. Complete delivery counts only the serialized and bulk lines on the accepted quotation; non-stock lines never count, and the project lead marks free-text lines delivered. Complete delivery can trigger an "upon delivery" billing milestone (see [Billing milestones](ops.md#billing-milestones-from-payment-terms)).

## RMA (defective units)

- `RMA-YYYY-NNNN`: the defective serial, client, project and site, fault description, supplier or brand, the RMA number they issued, dates sent and returned, the replacement serial, and status (Open → Sent to supplier → Replacement received → Delivered to client → Closed).
- The replacement serial takes the defective unit's place at the client site, and the defective serial's history ends as returned (RMA). Warranty in Pulse Desk continues on the replacement.

## Company-issued assets

- Owned by Pulse Supply. Laptops, phones, tools and test equipment are serialized items assigned to an employee through an issue-to-employee movement.
- Pulse Talent shows each employee's assigned assets read-only, via Supply's service functions.
- Every asset must be returned (return movement) before separation clearance.

## Notifications

- **Requester:** purchase request approved or returned; items for their project received; non-stock purchases waiting for their confirmation (POs with no project).
- **Supervisors:** purchase requests waiting for approval. **Board of Directors:** POs waiting for approval.
- **Supply Owners:** approved purchase requests waiting to become POs; POs past their expected delivery date.
- **Project lead:** items received for the project, deliveries still pending, RMA replacements received.
