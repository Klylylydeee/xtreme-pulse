# ADR 0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-09-25

## Context

The spec used to be a single `CLAUDE.md` that mixed rules, product requirements and the reasons behind them. Coding agents and future developers need the rules to be short and findable, and still need to know why a rule exists before changing it.

## Decision

Keep significant decisions as short, numbered records in `docs/adr/`. Rules stay in the doc that owns them, and each ADR links to them.

## Consequences

- Changing a decision means writing a new ADR, so the history stays visible.
- ADRs 0002 to 0010 record decisions that were already made in the original spec and build plan.

## Where the rules live

[CONTRIBUTING.md](../../CONTRIBUTING.md#change-the-spec-first)
