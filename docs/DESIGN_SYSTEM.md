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

- **One accent:** cobalt is the only color for interactive elements. Semantic colors are used only for meaning (success, warning, destructive), never for decoration, and never as the only signal; always pair them with a label or icon.
- Use the `*-text` tokens for status text and status icons. The plain `success`, `warning` and `destructive` tokens are only for small dots placed next to a text label.
- On `accent-subtle` (selected sidebar item, accent badges), use `text-secondary` or `accent` for small text, never `text-tertiary`.
- Text on a semantic fill (e.g. a red "Delete draft" button or a status badge): use the matching `*-text` token as the fill, with white text in light mode and `#0D1329` text in dark mode.
- In dark mode, text on accent-filled buttons is dark (`accent-text`), not white, so it meets contrast.
- Support **light and dark appearance**, following the operating system setting.
- All colors, type sizes, radii and spacing live as design tokens (CSS variables in the Tailwind theme, in `packages/ui`). Never hardcode them in components. Changing the palette later means changing only these tokens.

## Layout & components
- Sidebar styled like a macOS source list: module icons and names, the current module highlighted, collapsible. The sidebar and top bar are translucent (backdrop blur); use translucency sparingly elsewhere.
- Page header: a large title that shrinks into the top bar on scroll, with the primary action at the top right.
- Forms use inset grouped sections (like iOS Settings): related fields on rounded cards, each with a short section header and optional footer help text.
- Create and edit flows open in **sheets** (slide-over panels) instead of new pages, so the list stays in view.
- Segmented controls switch between views (e.g. Daily entries / Reimbursements on a timesheet); popovers and menus hold secondary actions.
- Rounded corners: about 12px on cards and sheets, about 8px on controls. Spacing follows a 4px/8px grid.
- Minimum touch target 44×44px. Timesheets, leave, offset time off and approvals must work well on a phone, since technicians and drivers fill them in on site.
- Icons: Lucide (the shadcn/ui default) with a consistent stroke weight. Don't use SF Symbols (Apple licenses them for Apple platforms only).

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
- Validate inline, next to the field.
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
| Segmented control | Switching views, and the None / Read / Write / Owner access picker |
| Inset grouped form section | Forms, with inline validation |
| Data table | Lists, on TanStack Table |
| Chart wrapper | Recharts charts; requires an accessible name |
| Destructive confirm dialog | Delete, cancel and void actions |
| Shortcut hint | Key hints such as ⌘↵ / Ctrl+Enter, shown for the user's platform |
| Masked field | Sensitive values, last 4 digits until revealed (see [Sensitive data](../SECURITY.md#sensitive-data)) |
| Loading, empty and error states | Skeletons, designed empty states and error messages on every screen |

## Checking a screen

Before a UI change is done, check it:

- in light and dark appearance
- at phone width, with 44×44px touch targets
- by keyboard alone, with visible focus
- with reduced motion and reduced transparency turned on

This is part of [Before finishing a change](../AGENTS.md#before-finishing-a-change).
