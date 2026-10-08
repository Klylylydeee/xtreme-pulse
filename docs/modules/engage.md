# Pulse Engage (Sales & Growth)

Tracks every sale from the first lead to a won deal, then hands won deals to Pulse Ops. People may call a deal a "sales project"; in the app and in code it is a **deal**.

Built in [Phase 3](../BUILD_PLAN.md#phase-3-pulse-engage). Route: `/engage`. Package: `packages/engage`. Clients, sites, contacts and products are Pulse Core master data that Engage manages through Core's service functions (see [Shared master data](core.md#shared-master-data)).

## Deals and stages

- A deal moves through these stages (configurable data, in this order): **Lead → Qualified → Site survey → Solution design (BOQ) → Quotation sent → Negotiation → Won / Lost**.
- Each deal has: deal number (`DL-YYYY-NNNN`), name, client, site(s), business line, products, owner (the Account Manager), deal team, stage, expected close date, estimated value (PHP), source, notes, and an activity history (stage changes, notes, files).
- **Business line** (required, exactly one): the part of the business the deal falls under. Seed: Data Center, Network, CCTV, Point of Sales (configurable data).
- **Products** (required, one or more, chosen with checkboxes): the brands the deal involves. Products are shared master data in Pulse Core (`brands` in code), because Supply and Desk use them too; catalog items (the part numbers used in BOQ lines, stock and serials) belong to a product and have an item kind (see [Stock](supply.md#stock)). Seed: Extreme Networks, Barracuda Networks, Palo Alto Networks, i-PRO, Luxriot, Cradlepoint, Verifone, Docusign, Airedale, Oper8 Global, ebm-papst, Ziehl-Abegg, General (for items that don't belong to a brand). Engage Owners add or retire products from Engage settings, through Pulse Core's service functions; other modules only read them. Products are records, never a hardcoded enum or type: adding one is a settings change, not a code change.
- **Product rules** (build step 1.8): a product has a name, required and unique ignoring case, retired products included (re-adding a retired name points to Restore). Renaming is allowed, the seeded ones and "General" included. A product can't be retired while it has live catalog items; a retired product can be restored. The System Administrator also manages them on `/admin/products`, before Engage settings exist (step 3.1) and after ([Managing master data](core.md#managing-master-data)).
- Moving a deal to **Lost** requires a reason (configurable list, e.g. price, competitor, timing, no budget, other) and a note.
- All amounts are in **PHP**. There is no multi-currency or exchange-rate handling, and no margin tracking or margin checks on quotations (actual project costs are tracked in Pulse Ops).
- **Pre-sale site surveys** belong to the deal: during the Site survey stage the team records the survey on the deal (date, site, findings, photos, attachments). Pulse Ops owns site surveys done for a project; when a deal is won, its pre-sale surveys are linked to the new project.
- **Renewal deals** are created automatically by Pulse Desk when a warranty, support contract or subscription nears its end (see [Renewals](desk.md#renewals)). They start at Qualified, are owned by the client's Account Manager and link to the expiring item.

## Deal team and visibility

- Every deal has a **deal team**: the owner plus the people added to it (e.g. presales engineers, other account managers). The owner and Engage Owners add or remove members.
- The person who creates a deal is its owner by default. The owner or an Engage Owner can hand ownership to another team member; usually this is the client's owning Account Manager.
- The team picker lists only people with at least Read access to Pulse Engage. Members need Write to work on the deal (BOQ, notes, files); members with Read can view it. If someone who's needed has no Engage access, the picker says so and points the owner to HR or the System Administrator. Channel Account Managers need at least Read to see deal registrations for their products.
- **Everyone with Pulse Engage access sees the deal list**: deal number, name, client, business line, products, stage, owner and expected close date.
- **Only deal team members can open a deal's detail page** (value, BOQ, quotations, deal registration, files, activity), plus Engage Owners, the System Administrator, and a supervisor asked to approve one of its quotations (read-only). Anyone else sees the row, and opening it shows "Only the deal team can open this deal" with the owner's name to ask.
- Enforce this on the server: detail data, quotations and files are never sent to someone who isn't allowed to open the deal. The one exception is the deal registration fields, which the Channel Account Manager assigned to that product can see.
- Access levels (see [Module access](../../SECURITY.md#module-access-rwo)): **Read** = see the list and open deals they're on; **Write** = also create deals and edit deals they're on; **Owner** = open and edit every deal, and manage Engage settings (stages, business lines, products, lost reasons, quotation terms).

## Deal registration

- When a deal is created (at Lead, or at Qualified for renewal deals), a **deal registration** entry is created for each selected product; entries are added or removed as the deal's products change.
- Each entry: product, status (Not submitted → Submitted → Approved / Rejected → Expired), registration number, submitted date, approved date, expiry date, principal contact, notes, attachment.
- A registration still without a number is flagged on the deal. The owner and the Channel Account Manager assigned to that product are alerted 30 and 7 days before a registration expires (configurable).
- Channel Account Managers see the registration entries for their assigned products across all deals (registration fields only, not the rest of the deal).

## Clients, sites and contacts

- Clients are shared master data in Pulse Core (Ops, Desk and Fiscal use them too); Engage creates and edits them through Pulse Core's service functions, never by writing to Core's collections directly. The System Administrator also manages them on `/admin/clients` (from build step 1.8, before Engage's client screens in step 3.2).
- Each client: name, TIN, billing address, **VAT treatment** (VAT-registered, zero-rated, or VAT-exempt; the VAT rate comes from [Quotations](#quotations)), **price display on quotations** (VAT-exclusive with a separate VAT line, or VAT-inclusive), credit terms (days), industry, owning Account Manager, notes.
- A client has many **sites** (name, address, city, site contact), e.g. bank branches or stores for CCTV and POS rollouts, and many **contacts** (name, position, email, mobile, primary contact flag).

Field rules (build step 1.8; retiring, removal, uniqueness and access are in [Managing master data](core.md#managing-master-data)):

- **Name:** required. Client names aren't unique: a name that matches another client's ignoring case, retired ones included, shows a warning and needs "Save anyway".
- **TIN:** optional. Dashes and spaces may be typed; it is stored as digits only and must be 9, 12 or 14 digits. Shown in groups of three, the last group taking the remaining digits: `000-000-000`, `000-000-000-000` or `000-000-000-00000`. Not unique. Client TINs are company data, not [sensitive personal data](../../SECURITY.md#sensitive-data).
- **VAT treatment:** one of `vatRegistered`, `zeroRated`, `vatExempt` (a fixed set), VAT-registered by default. Labels name no rate.
- **Price display:** `vatExclusive` or `vatInclusive` (a fixed set), VAT-exclusive by default.
- **Credit terms:** optional, a whole number of days from 0 to 365. When empty, the Fiscal default credit term applies ([Sales invoices (AR)](fiscal.md#sales-invoices-ar)).
- **Industry:** optional free text, up to 100 characters.
- **Owning Account Manager:** optional. When set or changed, it must be an employee whose account is active, never the bootstrap system account. One who later becomes inactive stays set, unchanged, and shows an "Inactive" badge until someone picks another ([Sales assignments](#sales-assignments)).
- **Billing address and notes:** optional free text.
- **Sites:** a name (required, unique within the client ignoring case, removed sites included), and optional address, city and site contact, all free text. The site contact isn't linked to the client's contacts.
- **Contacts:** a name (required), and optional position, email and mobile. The email is lowercased and must look like an email. The mobile is checked leniently: with spaces, dashes and parentheses taken out it must be `+63`, `63` or `0`, then `9` and 9 more digits (for example `0917 123 4567` or `+63 917 123 4567`); it is stored as typed. At most one contact is the **primary contact**.

## Presales and BOQ

1. The owner requests presales support on the deal and picks one or more Presales Engineers, who are added to the deal team. The deal moves to Solution design.
2. Presales builds the **BOQ**: sections (e.g. hardware, licenses, services) holding lines with product (brand), item description, part number, quantity, unit, unit price (PHP) and line total, plus notes and design attachments.
3. Presales marks the BOQ ready; the owner reviews it and creates the quotation from it.
- BOQs are versioned. A quotation always points to the BOQ version it was made from.

## Quotations

- Created from a BOQ version. Number `QT-YYYY-NNNN`, with revisions (e.g. `QT-2026-0012 Rev 2`): editing a sent quotation creates a new revision, and earlier revisions stay read-only. Every new revision goes through approval again before it can be sent.
- **VAT comes from the client:** 12% for VAT-registered clients, 0% for zero-rated or VAT-exempt clients, displayed VAT-exclusive or VAT-inclusive according to the client's setting. The VAT rate is versioned configuration, never hardcoded.
- **Validity:** 30 days from the quotation date by default (the default is configurable). On each quotation the owner can instead set a number of days or a specific valid-until date.
- **Payment terms (required):** a list of terms, each with a name, a percentage and a trigger: upon PO or downpayment, upon delivery, upon installation, upon acceptance, or on a set date. Percentages must total 100%. Reusable templates (e.g. "30% downpayment / 60% delivery / 10% acceptance", "100% upon acceptance") are configurable. Payment terms print on the quotation and, when the deal is won, become the project's billing milestones (see [Billing milestones](ops.md#billing-milestones-from-payment-terms)).
- **Approval before sending:** the owner submits the quotation; any one supervisor in the owner's `reportingTo` approves it or returns it with remarks. Only approved quotations can be sent, and the approver's e-signature is applied to the PDF. Engage Owners do not approve quotations unless they are in the owner's `reportingTo`. An owner with an empty `reportingTo` (e.g. a Board of Directors member) sends quotations without the approval step.
- Generated as a PDF from an editable template, with company details from company settings. Status: Draft → Pending approval → Approved → Sent → Accepted / Rejected / Expired. Marking it sent records the date and the client contact it went to.
- A quotation past its valid-until date becomes Expired automatically; the owner is alerted 3 days before.

## Won deals → Pulse Ops

- Marking a deal **Won** records the accepted quotation (and the client's PO number and date, if given) and creates the project in Pulse Ops through Ops's service functions, linked to the deal, client, sites and accepted quotation.
- Until Pulse Ops is built, a won deal shows "Ready for project" and appears in a handoff list; the project link is created once Ops ships.
- After that, the deal shows the project's status.

## Sales assignments

- Quotas/targets per sales user per period (monthly or quarterly), stored in centavos.
- Each client account has an owning Account Manager.
- Channel Account Managers are assigned the products (brands) they manage (see [Deals and stages](#deals-and-stages), e.g. Extreme Networks, Barracuda Networks).
- Assignments are reassigned on separation (see [Separation](talent.md#separation)).

## Notifications

- **Owner and deal team:** added to a deal team, presales requested, BOQ ready, quotation approved or returned, quotation expiring, deal registration expiring.
- **Supervisors:** quotations waiting for their approval.
- **Channel Account Managers:** registrations for their products expiring or still without a number.
