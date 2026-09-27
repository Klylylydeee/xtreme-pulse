# Testing

How changes are checked. The short version: **no automated tests yet** (see [ADR 0010](adr/0010-manual-verification-before-automated-tests.md)), except the [sensitive-data guard tests](#sensitive-data-guard-tests). Every build step is checked with typecheck, lint and a browser check, and every phase ends with a review and a hands-on phase check.

## What happens today

| Check | When | How |
|---|---|---|
| Typecheck and lint | After every build step | `pnpm typecheck` and `pnpm lint` must pass |
| Guard tests | After every build step | `pnpm test` must pass (see [Sensitive-data guard tests](#sensitive-data-guard-tests)) |
| Browser check | After every build step | Open the step's screens in light and dark appearance and at phone width (see [Checking a screen](DESIGN_SYSTEM.md#checking-a-screen)) |
| "Done when" | After every build step | Each step in the [build plan](BUILD_PLAN.md) ends with a concrete "Done when" line. That line is the step's acceptance test |
| Phase review | End of every phase | A review sub-agent checks the whole phase against the docs, using the [security review checklist](../SECURITY.md#review-checklist) |
| Phase check | End of every phase | The hands-on walkthrough listed under each phase in the build plan |
| Whole-app review | Build step 7.8 | Review sub-agents check every module in parallel |

Development aids: `/dev/ui` shows every token and component, and `/dev/health` checks MongoDB (with a transaction), Redis, the worker, storage and encryption. Both are development-only.

`pnpm test` runs the committed automated tests. Today that's only the sensitive-data guard suite.

## Sensitive-data guard tests

The guard that keeps sensitive fields encrypted is the one area with committed automated tests ([ADR 0012](adr/0012-fail-closed-sensitive-fields.md)). A missed write path stores plain text silently, so a hand check isn't enough. Other areas still have no automated tests until this doc says so.

- **Scope.** The `sensitiveField()` guard and the `$jsonSchema` validator described in [Sensitive data](../SECURITY.md#sensitive-data). Nothing else.
- **Where.** Next to the code they test, as `*.test.ts`: the guard's tests in `packages/core/src/server/encryption/`, and the validator's beside the code that builds and installs it.
- **What `pnpm test` runs.** Every `*.test.ts` in the workspace, once, without watch mode. It must pass after every build step.
- **Framework (proposed).** Vitest, the runner already named below. The repo has none yet; Vitest suits the ESM, TypeScript setup (`"type": "module"`, run through `tsx` today) with no extra build step.
- **Database.** A real MongoDB replica set that the suite starts and throws away, such as `mongodb-memory-server` in replica-set mode. Never the development database, and never real employee data.
- **What it covers.**
  - Schema shapes refused when defined: a sensitive field in an array of plain values, in a Map, or only on a discriminator's child schema.
  - Writes the guard refuses: `strict: false`, `$rename` into or out of a sensitive path, an upsert with a sensitive path in its filter, and plain values in `$setOnInsert`.
  - Arrays of sensitive subdocuments: `$push` and `$addToSet` with encrypted values pass and with plain values fail; `$pull` and `$pop` pass.
  - Writes only the validator stops: `bulkWrite`, `replaceOne` and `findOneAndReplace`, update pipelines, `$merge` and `$out`, and raw calls through `Model.collection`. Each must fail with plain text and succeed with encrypted values.
  - The validator is installed on every collection with sensitive paths, and installing it again changes nothing.

## Hand calculations

The riskiest code computes money, time and deadlines. Until automated tests exist, check these by hand against a worked example and keep the example in the step's notes:

- A payroll line for one Overtime-timesheet and one Standard-timesheet employee, from the seeded rates (build step 2.9)
- Billing milestones that sum exactly to the contract value, with the remainder on the last one (step 4.3)
- SLA due times across business hours, weekends and holidays (step 6.4)
- Holy Week dates from the Easter computation (step 1.10)

## When automated tests arrive (proposed)

Apart from the [sensitive-data guard tests](#sensitive-data-guard-tests), none of this is in use yet. It's a plan for when tests are added, in priority order:

1. **Unit tests for pure computations**, with Vitest: money rounding, pay computation, DTR, leave and offset balances, 13th month, milestone split, SLA business-hours math, employee and document numbers, Holy Week dates.
2. **Service tests against a real MongoDB replica set**, for example `mongodb-memory-server` in replica-set mode: transactions, balanced journal entries, stock movements and derived on-hand, duplicate receipts, the approvals engine.
3. **Access-control tests**: a matrix of module (Engage, Ops, …) × access level (None, Read, Write, Owner) × action, run against `requireModuleAccess` and the [exceptions](../SECURITY.md#exceptions-to-module-access), plus record-level visibility (deal team, project team, project costs).
4. **End-to-end tests** with Playwright for the phone flows: timesheet, leave, delivery receipt signing, site report, service report.

Tests go next to the code they test (`*.test.ts`). Test data comes from the seed loaders plus small, named fixtures. Never use real employee data.

## Rates and law

Seeded rates and tables must be checked against official issuances before the first real payroll and before go-live. That duty is in [Keeping rates current](COMPLIANCE.md#keeping-rates-current), not here.
