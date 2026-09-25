# ADR 0006: Money as integer centavos

- **Status:** Accepted
- **Date:** 2026-09-24 (original spec and build plan)

## Context

Payroll, invoices, VAT, withholding and milestone splits must match to the centavo. Floating-point numbers can't represent most decimal amounts exactly. The spec allows integer centavos or `Decimal128`, and the build plan's money helpers use integer centavos.

## Decision

Store and compute every amount as an integer number of centavos, in PHP. Round only at the line level, half-up to the centavo. Where amounts must add up to a total, as with billing milestones, the last line takes the remainder.

## Consequences

- Arithmetic is exact, and a JavaScript number holds any realistic amount safely.
- Every amount field and helper works in centavos (`amountCentavos`). Conversion to pesos happens only for display.
- Use `Decimal128` only if a field ever needs sub-centavo precision, and record that in a new ADR.

## Where the rules live

[Money](../DATA_MODEL.md#money), [Money and dates](../CODE_STYLE.md#money-and-dates)
