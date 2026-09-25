# Code style

How Xtreme Pulse code is written. Rules marked _(proposed)_ weren't in the original spec. They're sensible defaults, so keep, change or drop each one, and remove the marker once it's settled.

## Language and tooling

- TypeScript in strict mode everywhere, with ESLint and Prettier (build step 0.1). Code is done only when `pnpm typecheck` and `pnpm lint` pass.
- No `any` or non-null assertions (`!`) without a comment saying why. _(proposed)_
- Let Prettier decide formatting. Don't hand-format or argue about it in review. _(proposed)_

## Naming

- Files: kebab-case; React components: PascalCase
- Database collections and fields follow [DATA_MODEL.md › Naming](DATA_MODEL.md#naming), and document numbers follow [Document numbers](DATA_MODEL.md#document-numbers).
- Use the domain words from the [Glossary](GLOSSARY.md) in code as well as in the UI: `deal`, not `salesProject`; `brand` in code for what the UI calls a product.

## File organization

- Keep schemas, services and Zod validators for an entity side by side in its module package
- Each module package exposes its service functions as its public API. Other packages import those services, never another module's models. _(proposed: enforce with ESLint `no-restricted-imports`)_
- One entity per folder, for example `packages/supply/src/purchase-orders/` holding the model, service and Zod schema. _(proposed)_

## Pages, Server Actions and Route Handlers

- Follow the shape in [Architecture rules](ARCHITECTURE.md#architecture-rules): validate with Zod, check access, call a service. No business logic in pages or actions.
- Server Actions return field errors in one shared shape, so forms can show them inline next to the field (build step 0.6).
- Put the access check first, before reading any data (see [Module access](../SECURITY.md#module-access-rwo)).

## Constants versus data

The spec is strict about which lists are code and which are data.

- **Fixed sets are code.** They are `as const` arrays with derived types, defined once in the owning package. For example: `MODULES`, `ACCESS_LEVELS` ([Module access](../SECURITY.md#module-access-rwo)), `EMPLOYMENT_STATUS` ([Account status](../SECURITY.md#account-status)), `TIMESHEET_TYPES` ([Timesheet types](modules/talent.md#timesheet-types)) and `ALLOWED_EMAIL_DOMAINS`.
- **Anything the spec calls configurable is data.** It lives in records an admin or module Owner can change, never in an enum. Examples: departments and positions, products, deal and project stages, business lines, lost reasons, payment term templates, leave types, allowance types, reimbursement types, checklist templates, ticket queues, stock locations and the holiday seed list.
- **Rates and tables are versioned configuration** (see [Versioned configuration](DATA_MODEL.md#versioned-configuration)).
- **Company details come from company settings** (see [Company details](modules/core.md#company-details-pending-from-the-client)).
- **Colors, type sizes, radii and spacing come from design tokens** (see [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#color-cobalt-palette)).

## Money and dates

- Use the shared money helpers (build step 0.6) for every amount: integer centavos, half-up rounding at the line level, PHP display. Never do arithmetic on floats (see [Money](DATA_MODEL.md#money)).
- Use the date helpers: store UTC, display Asia/Manila. Don't call `new Date()` for business dates in module code. _(proposed)_

## Errors and messages

- A user-facing error says what to do next. For example, a blocked onboarding gate names the item to complete, and the 100th hire in a year gets a clear error for HR.
- Label wording follows [Writing](DESIGN_SYSTEM.md#writing).
- Never put passwords, tokens or sensitive fields in errors or logs (see [Secrets](../SECURITY.md#secrets)).

## Comments

- Where code implements a specific spec rule, add a short comment linking to it, for example `// Spec: docs/modules/talent.md#rates`. This makes it easy to find the code when the rule changes. _(proposed)_
- Comments explain why, not what.
