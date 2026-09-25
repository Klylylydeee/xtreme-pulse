# ADR 0007: Append-only records and derived balances

- **Status:** Accepted
- **Date:** 2026-09-24 (original spec)

## Context

The ledger, stock, leave, offset and attendance figures must be auditable and must never drift from the events behind them. Editing a balance in place loses the reason it changed.

## Decision

Record events and derive balances from them. Journal entries are append-only and corrected by reversal. Stock is a series of movements, and on-hand is derived. Leave and offset balances come from opening, credit, carry-over and usage entries. The DTR is computed. Finalized periods are corrected by adjustments in the next period.

## Consequences

- Every figure can be traced to the entries that produced it.
- Corrections are new records, so screens need "reverse" or "adjust" actions instead of "edit".
- Balances are computed or cached from entries, never typed in, apart from dated opening entries at go-live.

## Where the rules live

[Derived values](../DATA_MODEL.md#derived-values), [Locked and append-only records](../DATA_MODEL.md#locked-and-append-only-records), [Ledger](../DATA_MODEL.md#ledger-pulse-fiscal), [Inventory](../DATA_MODEL.md#inventory-pulse-supply)
