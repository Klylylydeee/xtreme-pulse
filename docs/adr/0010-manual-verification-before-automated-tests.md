# ADR 0010: Manual verification before automated tests

- **Status:** Accepted, to be revisited. Narrowed twice: by [ADR 0012](0012-fail-closed-sensitive-fields.md), so the sensitive-data guard has automated tests, and in build step 1.3 (2026-10-03), so the audit log, notifications and sensitive reveal have them too ([TESTING.md](../TESTING.md#audit-notification-and-reveal-tests)).
- **Date:** 2026-09-24 (build plan)

## Context

The app is built step by step with Claude Code, and each step is small and checked by hand before it's committed.

## Decision

Skip automated tests for now, except the areas [TESTING.md](../TESTING.md#what-happens-today) lists: the sensitive-data guard (ADR 0012), and the audit log, notifications and sensitive reveal (build step 1.3), where a silent failure would leak a value or lose a security record. Each step is checked with `pnpm typecheck`, `pnpm lint`, its "Done when" line and a browser check in light, dark and phone width. Each phase ends with a review sub-agent and a hands-on phase check.

## Consequences

- Faster early progress.
- Regressions in payroll, ledger and access rules can slip through unnoticed. Revisit this decision before the first real payroll run, and add tests in the order proposed in [TESTING.md](../TESTING.md#when-automated-tests-arrive-proposed).

## Where the rules live

[TESTING.md](../TESTING.md)
