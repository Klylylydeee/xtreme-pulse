# ADR 0008: Versioned, effective-dated configuration

- **Status:** Accepted
- **Date:** 2026-09-24 (original spec)

## Context

Contribution tables, tax brackets, premium rates, minimum wages, the VAT rate and ATC codes change by law, often mid-year. Past payroll runs and tax reports must keep using the rates that applied at the time.

## Decision

Store every such rate or table as versioned configuration with an effective date, and resolve the version by the date the calculation applies to. Never hardcode a rate.

## Consequences

- A new issuance is a data change, not a code change or a deploy.
- Every calculation must know which date it's for.
- Seeded values must be checked against official issuances before they're relied on.

## Where the rules live

[Versioned configuration](../DATA_MODEL.md#versioned-configuration), [Keeping rates current](../COMPLIANCE.md#keeping-rates-current)
