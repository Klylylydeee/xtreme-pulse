# Design system

How every Xtreme Pulse screen looks, moves and reads. The approved look is shown on the [Xtreme Pulse screens](https://claude.ai/artifact/REqSjEy78c7ZQUGwy3dQ9e) design canvas. When a screen appears there, match it.

The whole app follows Apple's design principles. It should feel like a native Apple app: calm, clear and consistent across every module.

## Principles
- **Clarity:** content comes first. Legible text, clear icons, generous whitespace, and one obvious primary action per screen.
- **Deference:** the interface steps back so the data stands out. Minimal borders and chrome, subtle shadows, no decoration without a purpose.
- **Depth:** layers show hierarchy. Sheets, popovers and dialogs sit visibly above the page, and motion shows where things come from and go.
- **Consistency:** the same job uses the same component and pattern in every module. A timesheet, a leave request and a purchase order are laid out the same way.

## Typography
- Font stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif`. Apple devices render SF Pro; others fall back to Inter. Never bundle SF Pro font files (Apple's license limits them to Apple platforms).
- Type scale modeled on Apple's text styles, defined once as tokens (px): Display 40 (page titles and big numbers, weight 700, tight letter-spacing), Large Title 34, Title 1 28, Title 2 22, Title 3 20, Headline 17 semibold, Body 17, Callout 16, Subheadline 15, Footnote 13, Caption 12. Data-dense desktop screens (tables, payroll runs) may use Subheadline or Footnote for rows.
- Use `rem` units so browser zoom scales everything.

## Color: Cobalt palette

The app uses the **Cobalt** palette: a saturated cobalt accent with a violet cast, on cool blue-tinted neutrals (blue-black in dark mode). Every text and control pairing below meets WCAG 2.1 AA.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#FAFBFE` | `#040815` | Page background |
| `bg-grouped` | `#EEF1F8` | `#030610` | Behind grouped cards and sections |
| `surface` | `#FFFFFF` | `#111827` | Cards, sheets, popovers |
| `sidebar` | `#F1F4FC` | `#0A101E` | Sidebar base (about 80% opacity with backdrop blur) |
| `separator` | `#D5D9E3` | `#262E3F` | Hairline borders and dividers |
| `text-primary` | `#141926` | `#EBF0FC` | Body text and titles |
| `text-secondary` | `#585F6E` | `#A7B1C7` | Supporting text |
| `text-tertiary` | `#666C7A` | `#7F889C` | Placeholders and metadata |
| `accent` | `#3040CD` | `#7593FF` | Primary buttons, links, focus rings, selected states |
| `accent-hover` | `#2327B7` | `#8AA6FF` | Hover and pressed accent |
| `accent-text` | `#FFFFFF` | `#0D1329` | Text and icons on accent fills |
| `accent-subtle` | `#E1E9FF` | `#1C2441` | Selected sidebar item, accent badges |
| `success` | `#34C759` | `#30D158` | Success icons and dots (approved) |
| `warning` | `#FF9500` | `#FF9F0A` | Warning icons and dots (pending) |
| `destructive` | `#FF3B30` | `#FF453A` | Destructive icons and dots (errors) |
| `success-text` | `#127C3A` | `#5AD87E` | Success text on `bg` or `surface` |
| `warning-text` | `#AD5907` | `#FEAE43` | Warning text on `bg` or `surface` |
| `destructive-text` | `#C52525` | `#FF716D` | Error and destructive text on `bg` or `surface` |
| `hero` | `#3040CD` | `#16207A` | Solid cobalt hero areas (Home, Login) |
| `hero-text` | `#FFFFFF` | `#EBF0FC` | Text on `hero` |
| `hero-text-secondary` | `#D6DCFF` | `#B8C3F0` | Supporting text on `hero` |
| `logo-tile` | `#FFFFFF` | `#FFFFFF` | Tile behind an uploaded company logo (the same in both appearances) |

- **One accent:** cobalt is the only color for interactive elements. Semantic colors are used only for meaning (success, warning, destructive), never for decoration, and never as the only signal; always pair them with a label or icon.
- Use the `*-text` tokens for status text and status icons. The plain `success`, `warning` and `destructive` tokens are only for small dots placed next to a text label.
- On `accent-subtle` (selected sidebar item, accent badges), use `text-secondary` or `accent` for small text, never `text-tertiary`.
- Text on a semantic fill (e.g. a red "Delete draft" button or a status badge): use the matching `*-text` token as the fill, with white text in light mode and `#0D1329` text in dark mode.
- In dark mode, text on accent-filled buttons is dark (`accent-text`), not white, so it meets contrast.
- An uploaded company logo always sits on a `logo-tile` square with a hairline `separator` border, a small inner padding and the placeholder mark's radius, wherever it appears (login hero, sidebar, settings preview). The tile doesn't change with appearance, because most logos are drawn for a light background. The placeholder mark keeps its own styling.
- Support **light and dark appearance**, following the operating system setting.
- All colors, type sizes, radii and spacing live as design tokens (CSS variables in the Tailwind theme, in `packages/ui`). Never hardcode them in components. Changing the palette later means changing only these tokens.

## Layout & components
- Sidebar styled like a macOS source list: module icons and names, the current module highlighted, collapsible. The sidebar and top bar are translucent (backdrop blur); use translucency sparingly elsewhere.
- A sidebar item can carry a count badge after its label (from build step 1.7, User access's "need access" count; from build step 1.9, Approvals' "waiting" count): the accent colour like the notification bell's badge, capped at "99+", hidden at zero, and included in the link's accessible name (for example "User access, 3 need access").
- A long sidebar section can split its items into collapsible sub-groups (the Administration section's groups are in [Administration area](modules/core.md#administration-area)). Items outside any group stay at the top, always shown. Each group has a header row that is a disclosure button (`aria-expanded`, `aria-controls` naming its list), at least 44px tall, with a chevron that turns when it opens (no turn with reduced motion). A group is built from the items the user can see, so a group with none isn't shown; when only one group is left in the section, its items are listed plainly, with no header and no toggle. The group holding the current page opens on its own when the user arrives there; otherwise each group opens or closes when the user clicks its header, and that choice is remembered in the browser (local storage, per device; the sidebar still works when storage is unavailable, with every group closed except the current page's). While a group is closed, its header shows the sum of its items' count badges, in the same style, with the count in the header's accessible name ("People and organization, 3 need access"), and its label is in the accent colour when it holds the current page. The phone drawer shows the same groups.
- Page header: a large title that shrinks into the top bar on scroll, with the primary action at the top right.
- Forms use inset grouped sections (like iOS Settings): related fields on rounded cards, each with a short section header and optional footer help text.
- Create and edit flows open in **sheets** (slide-over panels) instead of new pages, so the list stays in view.
- Segmented controls switch between views (e.g. Daily entries / Reimbursements on a timesheet); popovers and menus hold secondary actions.
- Rounded corners: about 12px on cards and sheets, about 8px on controls. Spacing follows a 4px/8px grid.
- Minimum touch target 44×44px. Timesheets, leave, offset time off and approvals must work well on a phone, since technicians and drivers fill them in on site.
- Icons: Lucide (the shadcn/ui default) with a consistent stroke weight. Don't use SF Symbols (Apple licenses them for Apple platforms only).
- **Command bar** (build step 1.11). Groups in this order: **Go to** (the navigation items the user can open, matched as they type) and then one group per search provider, **People** first ([Command bar](modules/core.md#command-bar)). Each result row has an icon tile, the title and an optional subtitle in `text-secondary`. While a search runs, the provider groups show a skeleton row; a failed search shows "Search isn't available right now." under Go to, which keeps working; with no match anywhere: "No matches. Try a name, an employee number or a page." Arrow keys move, Enter opens, Esc closes and focus returns to the trigger.
- **Directory and inspector** (build step 1.11). The directory is a data table on desktop and a list on a phone, each row an Avatar with the name, then the employee number, position, department and email. The directory card opens in the inspector panel; reporting lines are edited inline there, not in a sheet ([Company directory](modules/core.md#company-directory)).
- **Org chart** (build step 1.11). Person cards (Avatar, name, position, department) on `surface` with the card radius, joined by hairline `separator` lines drawn in one SVG layer hidden from assistive technology, one line per supervisor. The chart sits in one scrollable region with zoom out, zoom in and Fit icon buttons (44×44px); the page never scrolls sideways. A search match gets an `accent` ring and the label "Match", and the other cards dim, so color is never the only signal. Zooming and scrolling to a match don't animate with reduced motion ([Org chart](modules/core.md#org-chart)).
- **Home tiles** (build step 1.11). Under the hero, a grid of one column on a phone, two on a tablet and three on a desktop. Each tile is a `surface` card with a tinted icon tile, a Headline title, a Display-size count in tabular numerals where it has one, and one link; each has its own skeleton, its own zero state and its own error state, so one failing tile never blanks Home ([Home](modules/core.md#home)).
- **Employee record** (build step 2.1). The employee list follows the directory's pattern: a data table on a desktop, cards on a phone, an Avatar with the name, and the record in the inspector panel (a full-height sheet on a phone). Above it, stat tiles count employees by status.
  - **Sections.** The inspector holds inset grouped sections, each with an Edit action that opens a sheet; Save is ⌘S or Ctrl+S. Core's fields carry a "Managed in Users" footnote.
  - **Masked values.** Sensitive values use the Masked field: the last 4 digits for IDs and account numbers, and `••••` with no digits for amounts. A section the viewer can't see is replaced by one `text-secondary` line on the card, never an empty or locked field.
  - **Sensitive inputs.** In a sheet they start empty, with the hint "Ends in 1234" in `text-secondary`.
  - **Compensation history.** A list, newest first, with "Scheduled" and "Superseded" badges that carry text, so color is never the only signal ([The employee record](modules/talent.md#the-employee-record-build-step-21)).
  - **Documents and certifications** (build step 2.2). The 201 file and the certifications are lists, newest first, each row with its expiry badge carrying text:
    - "Expired": `destructive-text`
    - "Expires in N days": `warning-text`
    - "Valid": neutral

    Archived documents hide behind a "Show archived" switch. Uploads use a sheet with a file field that names the accepted types and the size limit.
  - **Photo and e-signature** (build step 2.2). The photo shows as a large Avatar with Change and Remove. The signature preview sits on a `logo-tile` square with a hairline `separator` border, like the company logo, so a dark-ink signature reads in both appearances. Its version history is a list of versions with their dates ([Documents, photo, e-signature and certifications](modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22)).
  - **Change requests** (build step 2.6). On the employee's own record, a section's Edit sheet says in its footer what saves straight away and what goes for approval, and its primary button reads "Save" or "Send for approval" accordingly. A section with an open request shows a "Waiting for approval" (or "Returned") badge with text instead of Edit. The change request page lists each changed field as a row with Current and Proposed, masked like the record. Verification shows as a text badge in the Government IDs and Payroll bank account sections: "Verified" with who and when, or "Not verified" in `warning-text`.
- **Timesheets on a phone** (build step 2.4; the reference designs' Overtime timesheet on a phone and Standard timesheet). One page serves both timesheet types, built from shared parts; only the extra-hours card differs ([Work schedules and daily time entries](modules/talent.md#work-schedules-and-daily-time-entries-build-step-24)).
  - **Order, top to bottom:** the large title "Timesheet" with "Cut-off Sep 11 – 25, 2026 · Overtime timesheet" under it, the Today card, the extra-hours card, the segmented control "Daily entries | Reimbursements", the day list, and a sticky glass footer with the cut-off's total.
  - **Today card:** a `surface` card with a ring of worked against scheduled hours (its value also given as text for assistive technology), "Timed in 7:58 AM" in tabular numerals, and one full-width primary button at least 52px tall: Time in or Time out.
  - **Overtime by kind:** a card with a tinted icon tile, the total in Display size, and one bar per kind (Ordinary day, Rest day, Holiday, Night differential), each with its hours as text. A line under it says that night differential overlaps the other hours. **Offset** instead shows the cut-off's offset, the balance, and "+X h this cut-off, credited when HR approves your timesheet".
  - **Day rows:** at least 72px tall. Each has a date tile (weekday and day number in an `accent-subtle` rounded square), the times, the activity and client on one truncated line, and the day's hours on the right ("OT 2.0 h" over "Ordinary day", or "Offset 2.6 h"). A manual time carries a "Manual" badge in `warning-text` with an icon. "Not claimed" and "No time out" are text badges too, so color is never the only signal. Rest days and holidays carry their label, and a run of empty rest days folds into one row. Days are listed newest first.
  - **Sheets:** a day opens a sheet (full height on a phone) with its entries and "Add entry". The entry sheet has native time inputs, a "Next day" switch for the time out, the activity, a client picker, the project and ticket pickers disabled with their "Available when…" hint, and the extra-hours switch with its required reason.
  - **Phone width:** the page never scrolls sideways. The day list is a list, never a table, below the desktop breakpoint.
  - **Reimbursements** (build step 2.5, [Reimbursements](modules/talent.md#reimbursements-build-step-25)). The segment lists the lines as a list, never a table, grouped by receipt date, newest first.
    - **Rows** are at least 72px tall: a tinted icon tile for the type, the merchant over the type and client on one truncated line, and the amount on the right in tabular numerals. A receipt thumbnail (or a PDF icon) sits in the row. An over-limit line carries an "Over limit" badge in `warning-text` with an icon and the text "₱120.00 over the daily limit", so color is never the only signal.
    - **"Add reimbursement"** (the employee's own open timesheet, within the filing window) opens a sheet, full height on a phone, in inset grouped sections. The receipt comes first: a file field "Take a photo or choose a file" with no `capture` attribute, so the phone offers the camera and the files, naming the accepted types and size limit, with a preview. Then the type, a native date input limited to the filing window with "Receipts dated <from> – <to>" under it, the merchant, the merchant TIN (`inputmode="numeric"`), the receipt or invoice number, the amount (`inputmode="decimal"`), the client picker with the footer "For tracking only. Reimbursements are never billed to the client.", the disabled project picker with its "Available when…" hint, pick-up and drop-off when the type needs them, and the description. A duplicate receipt shows under the receipt or invoice number.
    - **A line** opens the same sheet to edit, with "Delete reimbursement" behind a confirmation, or a read-only detail with "Open receipt" for anyone else.
    - **The sticky footer** shows "Reimbursements ₱1,234.50 · 3 receipts" while the segment is shown.
  - **Submission, approval and the DTR** (build step 2.7, [Timesheet approval, the DTR and the offset balance](modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27)).
    - **The status banner** sits under the title, above the Today card: an inset `surface` row with an icon and text ("Waiting for supervisor", "Waiting for HR", "Returned by <name>" with the remarks quoted under it, "Approved · Locked", "Not submitted · Due Sep 26"). Returned uses `warning-text`, approved `success-text`, overdue `destructive-text`, each with its icon and words, so color is never the only signal. "Submitted late" is a text badge.
    - **Submit** is the sticky footer's full-width primary button ("Submit timesheet", or "Resubmit"), at least 52px tall, beside the total. It opens a confirmation sheet (full height on a phone) with the cut-off's summary in an inset grouped list, any blocking problem named with a link to fix it, and the primary "Submit". A locked or pending timesheet hides every add, edit and delete control rather than disabling it.
    - **The DTR segment** is the third option of the segmented control ("Daily entries | Reimbursements | DTR"). Rows, at least 64px tall and newest first, show the date tile, the status as a text badge (Present, Absent, Rest day, Holiday), and on the right the late and undertime minutes, night differential, and overtime or offset in tabular numerals. A preview carries "Not approved yet".
    - **The timesheets list** (`/talent/timesheets`) leads with the status tiles as small trend tiles ([Data-rich](#data-rich)), then a list of people, never a table below the desktop breakpoint.
    - **Time off on the DTR** (build step 2.8): a covered day's row carries a text badge ("On leave (paid) · VL", "Half day VL (paid)", "Offset (paid) 4.0 h", "Leave without pay" in `warning-text` with an icon), and a partly covered day shows its absent minutes beside late and undertime.
- **Time off on a phone** (build step 2.8, [Leave, offset time off and opening balances](modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28)). `/talent/time-off` is laid out like the timesheet: the large title "Time off", then the balances, the requests and a sticky footer with "File time off".
  - **Balance cards:** one `surface` card per balance (VL, SL, Offset), each with a tinted icon tile, the balance in Display size with its unit as text ("4.5 days", "12.5 h"), and "Available 3.5 days" under it when a pending request holds some. On a phone they scroll as a row of cards, never wider than the page. The statutory types used this year sit under them as a grouped list ("Solo parent leave · 2 of 7 days used").
  - **Request rows:** at least 72px tall, newest first: a date tile, the type's short name and number, the days or hours, and a status badge with text ("Waiting for supervisor", "Approved", "Returned", "Rejected", "Cancelled"). Leave without pay adds "1 day without pay" in `warning-text` with an icon, so color is never the only signal.
  - **The request sheet** (full height on a phone, inset grouped sections): the segmented control "Leave | Offset", the type picker, native date inputs with the filing window under them, a segmented control "Whole day | First half | Second half" (or native time inputs for part of a day of offset), the attachment field ("Take a photo or choose a file", with no `capture` attribute, naming the accepted types and size limit), the reason, and a summary section before the primary "Submit": chargeable days or hours, the rest days and holidays left out, and the paid and unpaid split, with "1 day without pay (deducted from pay)" in `warning-text`. A refusal shows next to its field in the server's words. The gated-action notice shows above the sheet's fields when `reportingTo` isn't set.
  - **The request page** (`/talent/time-off-requests/<id>`) shows the days, the split, "Open attachment" (never a preview thumbnail of a medical file), the reason, and the approval history as a list. An approver sees "Waiting for your approval · Open in Approvals"; nothing is decided on this page.
  - **Opening balances** (`/talent/opening-balances`) is a list of people on a phone and a data table on a desktop, with each person's VL, SL and offset in tabular numerals, and "Year-to-date pay: Entered" or "Not entered" as a text badge, never an amount. "Enter" opens a sheet.
- **Payroll runs on a phone** (build step 2.9, [Payroll run computation](modules/talent.md#payroll-run-computation-build-step-29)).
  - **The runs list** (`/talent/payroll`): rows at least 64px tall, newest first, each with a date tile for the pay date, the period and number, the status as a text badge ("Draft"), the employee count and "Computed <when>". "Compute draft run" is the page's primary button; its sheet lists the ended cut-offs with no run as a radio list.
  - **The run page** (`/talent/payroll/<runId>`): the large title (the period), the pay date and status badge, then small trend tiles ([Data-rich](#data-rich)) for Employees, "Timesheet not approved", "Net pay below zero" and "Left out", each a filter. Amounts are hidden behind one secondary button, "Show amounts", with the note "Viewing amounts is recorded in the audit log."; afterwards the totals sit in an inset grouped list and each row shows its net pay in tabular numerals. "Recompute" is a secondary button with a confirmation sheet, and the draft note ("Draft: amounts change until the run is finalized.") sits under the title in `text-secondary`.
  - **People** are a list on a phone (name, number, department, badges with text and an icon: "Timesheet not approved · basic pay only" and "Net pay below zero" in `warning-text`, "Settles earlier cut-offs" neutral) and a data table on a desktop, never a table below the desktop breakpoint.
  - **The breakdown sheet** (full height on a phone, inset grouped sections): Earnings, Deductions, "Settled from earlier cut-offs" (each line naming its period), Employer shares, then "How it was computed" (daily and hourly rate, base days, minutes, contribution bases, taxable compensation). Amounts are right-aligned tabular numerals, negatives with a minus sign, never color alone; gross, total deductions and net pay close the sheet in bold.

## Advanced look (approved direction)

Every screen combines four things, while staying calm and legible:

### Depth and glass

The sidebar, top toolbar, inspector panels and sheets are frosted glass: `backdrop-filter: blur(24px) saturate(180%)` over a semi-transparent surface fill, a hairline inner highlight, and soft layered shadows on floating layers only. Keep the fill at least 85% opaque wherever glass holds `text-primary` or `text-secondary`, and never put `text-tertiary` on glass (use a solid surface for metadata), so contrast meets AA whatever scrolls underneath. Fall back to a solid fill where `backdrop-filter` isn't supported or the user prefers reduced transparency.

### Pro-app layout

Every desktop screen has a top toolbar with the page title or breadcrumb, a command bar ("Search or jump to…", opened with ⌘K on Mac and Ctrl+K on Windows) that searches people, records and actions across the modules the user can access, and icon buttons for notifications and help. Key actions have keyboard shortcuts shown as hints (e.g. Submit ⌘↵ / Ctrl+Enter; show the key for the user's platform). The selected item's details open in an **inspector panel** on the right instead of a new page; on phones, inspectors become full-height sheets.

### Data-rich

Home and module screens lead with small charts and trend tiles built from the user's own data (bars, sparklines, rings, deltas). Chart style: `accent` for the main series, neutral grays for context, direct labels instead of legends, tabular numerals, and an accessible name for every chart (`role="img"` + `aria-label`, or a data table alternative).

### Bolder identity

Display-size titles and big numbers, solid `hero` areas on Home and Login (never gradients; a button on a light-mode hero is a `surface` fill with `accent` text, since `hero` and `accent` are the same color; in dark mode the normal accent button is fine), tinted icon tiles (`accent-subtle` rounded squares holding `accent` icons) for sections and navigation, and designed empty states (icon tile, one line of explanation, one action).

### Reference designs

The [Xtreme Pulse screens](https://claude.ai/artifact/REqSjEy78c7ZQUGwy3dQ9e) design canvas (Login, Home light and dark, User access, Standard timesheet, Payslip, Overtime timesheet on a phone).

## Feedback & motion
- Every screen has designed loading (skeletons), empty (what this is and what to do next) and error states.
- **No access** (build step 1.6). A blocked page shows, inside the shell, a designed empty state: an icon tile (Lucide `Lock`), the title "You don't have access to Pulse <Module>" ("You don't have access to this page" on an admin page), the line "Ask HR or the System Administrator if you need it.", and one action, "Go to Home". The rule behind it is in [Resolving and enforcing](../SECURITY.md#resolving-and-enforcing-build-step-16).
- **Not found** (build step 1.6). An unknown URL gets a real 404 page outside the shell: a centred empty state with "Go to Home". A record or page that calls not-found inside the shell shows the same state there.
- **Home access card** (build step 1.6). While a user has None on every module, Home shows a card under the hero: an icon tile and "Your access is being set up. HR will give you access to the modules you need." It took the place of the "Nothing needs your attention" empty state; from build step 1.11 that empty state is gone and the card sits under the hero, above the Home tiles ([User access page](modules/core.md#user-access-page), [Home](modules/core.md#home)).
- **Onboarding progress** (build step 2.6). A persistent, non-blocking reminder while any of the user's own onboarding items is To do ([Onboarding checklist and change requests](modules/talent.md#onboarding-checklist-and-change-requests-build-step-26)):
  - **In the top toolbar**, before the notification bell, a pill with a small progress ring and "Onboarding 5 of 8", linking to `/talent/onboarding`. On a phone it shrinks to the ring and "5/8", still a 44×44px target. Its accessible name is "Onboarding, 5 of 8 done". It never animates with reduced motion.
  - **On Home**, a card under the hero, above the access card: an icon tile, "Finish setting up your profile", a progress bar with "5 of 8 done" as text, and "Continue".
  - **The checklist page** lists items in inset grouped sections, each row with a text status badge ("Done", "To do", "Waiting for HR to verify"), so color is never the only signal, and its action on the right.
  - Never a modal and never a blocked page: "Skip for now" always leads on.
- **Gated actions** (build step 2.6). When an action needs an onboarding item the user hasn't completed, the screen says so before they try: a notice in `warning-text` with an icon, naming the item and linking to where it is done ("Approving needs your e-signature. Upload it in My record."), and the action's button disabled. Other actions stay available. The server's refusal uses the same words.
- Validate inline, next to the field.
- **Non-blocking warnings** (build step 1.8). When a value is allowed but probably a mistake, such as a client name another client already has ([Managing master data](modules/core.md#managing-master-data)), the form shows the warning inline under the field, in `warning-text` with a warning icon, never in red. The primary button then reads "Save anyway", so saving is a deliberate second click; changing the field clears the warning and the button goes back to its usual label. The server runs the same check and refuses the save unless it was confirmed.
- Destructive actions are red, name the action ("Delete draft", not "OK"), and ask for confirmation.
- Motion is subtle and quick (about 200–300ms, ease-out) and is turned off when the user prefers reduced motion (`prefers-reduced-motion`).

## Accessibility
- WCAG 2.1 AA contrast in both appearances, full keyboard navigation, visible focus rings, and a label on every control.

## Writing
- Short, plain labels. Use the terms in the [Glossary](GLOSSARY.md) consistently (timesheet, offset, cut-off, payslip).

## Tokens in code

All tokens are CSS variables in the Tailwind theme in `packages/ui`, and shadcn/ui is set up on top of them (build step 0.2). The development-only `/dev/ui` page shows every token and shared component in light and dark, so check new tokens and components there first.

## Shared components

Build these once in `packages/ui` (build steps 0.3, 0.4 and 0.8) and reuse them everywhere. Per the Consistency principle, a screen never gets its own variant of a job one of these already does.

| Component | Use |
|---|---|
| Sidebar | Glass macOS-style source list of the modules the user can open |
| Top toolbar | Page title or breadcrumb, command bar (⌘K / Ctrl+K), notifications and help |
| Page header | Large title that shrinks into the toolbar, primary action at the top right |
| Sheet | Create and edit flows |
| Inspector panel | Details of the selected item; a full-height sheet on phones |
| Avatar | A person's profile photo; from build step 1.11 the initials (first letter of the first and the last name) in an `accent-subtle` circle with `accent` text, hidden from assistive technology because the name always shows beside it. From build step 2.2 a photo fills the circle when the person has one (`photoUrl`, a lazily loaded image with an empty `alt`, cropped to cover), falling back to the initials if it fails to load. The User access page uses it too |
| Segmented control | Switching views, and the None / Read / Write / Owner access picker |
| Inset grouped form section | Forms, with inline validation |
| Data table | Lists, on TanStack Table |
| Chart wrapper | Recharts charts; requires an accessible name |
| Destructive confirm dialog | Delete, cancel and void actions |
| Shortcut hint | Key hints such as ⌘↵ / Ctrl+Enter, shown for the user's platform |
| Masked field | Sensitive values, last 4 digits until revealed; from build step 2.1, amounts show no digits (see [Sensitive data](../SECURITY.md#sensitive-data)) |
| Loading, empty and error states | Skeletons, designed empty states and error messages on every screen |

## Checking a screen

Before a UI change is done, check it:

- in light and dark appearance
- at phone width, with 44×44px touch targets
- by keyboard alone, with visible focus
- with reduced motion and reduced transparency turned on

This is part of [Before finishing a change](../AGENTS.md#before-finishing-a-change).
