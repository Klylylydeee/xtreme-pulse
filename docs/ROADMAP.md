# Roadmap

What gets built, in what order, and what's deliberately left for later. The step-by-step plan is in [BUILD_PLAN.md](BUILD_PLAN.md).

## Build order

Build order: Core → Talent → Engage → Ops + Supply → Fiscal → Desk → Insight.

| Phase | Builds | Plan |
|---|---|---|
| 0 | Foundation: monorepo, design system, app shell, database, shared helpers, files, jobs, encryption | [Phase 0](BUILD_PLAN.md#phase-0-foundation) |
| 1 | [Pulse Core](modules/core.md) | [Phase 1](BUILD_PLAN.md#phase-1-pulse-core) |
| 2 | [Pulse Talent](modules/talent.md) | [Phase 2](BUILD_PLAN.md#phase-2-pulse-talent) |
| 3 | [Pulse Engage](modules/engage.md) | [Phase 3](BUILD_PLAN.md#phase-3-pulse-engage) |
| 4 | [Pulse Ops](modules/ops.md) and [Pulse Supply](modules/supply.md) | [Phase 4](BUILD_PLAN.md#phase-4-pulse-ops-and-pulse-supply) |
| 5 | [Pulse Fiscal](modules/fiscal.md) | [Phase 5](BUILD_PLAN.md#phase-5-pulse-fiscal) |
| 6 | [Pulse Desk](modules/desk.md) | [Phase 6](BUILD_PLAN.md#phase-6-pulse-desk) |
| 7 | [Pulse Insight](modules/insight.md), then a whole-app review | [Phase 7](BUILD_PLAN.md#phase-7-pulse-insight) |

Go-live can be staged, for example Core and Talent after Phase 2 (see [Going live](DEPLOYMENT.md#going-live)). Until a later module ships, earlier modules show placeholders for its handoffs (see [Placeholders during the staged build](ARCHITECTURE.md#placeholders-during-the-staged-build)).

**Status:** planning. Update this line as phases finish, and record each release in [CHANGELOG.md](../CHANGELOG.md).

## Future releases (not in current scope)

Do not build these yet; they are recorded so current designs leave room for them.

- **Forgot password by email** (see [Sign-in and passwords](../SECURITY.md#sign-in-and-passwords)).
- **Resignation filing:** employees file their resignation in self-service with the required 30-day notice. A supervisor or HR accepts it, which sets the separation date and starts clearance. Until then, HR records resignations directly.
- **Monthly-rated holiday pay correction:** with the 261 factor, a monthly-rated employee's salary already covers unworked regular holidays and special non-working days. Only work on those days should add a premium (e.g. +100% on a regular holiday, +30% on a special non-working day), instead of paying the unworked 100% on top of the monthly salary.
- **Client portal:** clients log and follow their own tickets.
- **Client email updates** on tickets (see [Client updates](modules/desk.md#client-updates-later-phase)), once the email system ships.
- **Weekly summary by email** for the Board of Directors (see [Weekly Board summary](modules/insight.md#weekly-board-summary)), once the email system ships.

## Waiting on others

| Item | Needed before | Details |
|---|---|---|
| Company details (logo, registered name, address, TIN, employer numbers) | Go-live; placeholders until then | [Company details](modules/core.md#company-details-pending-from-the-client) |
| Government upload formats and BIR file formats | Build steps 2.11, 2.12 and 5.12 | [Inputs to get before building](COMPLIANCE.md#inputs-to-get-before-building) |
| BIR CAS/CBA acknowledgment or permit | Issuing invoices from Pulse | [CAS/CBA registration](COMPLIANCE.md#cascba-registration) |
| Hosting, backups and monitoring decisions | Go-live | [Still to decide](DEPLOYMENT.md#still-to-decide) |
