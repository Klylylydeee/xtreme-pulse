# ADR 0013: Master data schemas and services in Pulse Core

- **Status:** Accepted (build step 1.8 plan, 2026-10-08). Supersedes the step 1.1 note that `packages/db` holds the shared master data schemas ([CHANGELOG](../../CHANGELOG.md), 2026-09-27).
- **Date:** 2026-10-08

## Context

The build plan put the shared master data schemas (clients with sites and contacts, products, catalog items and suppliers) in `packages/db` and their services in `packages/core`. Since then every Core schema has gone into `packages/core` (step 1.1 onwards), [DATA_MODEL.md](../DATA_MODEL.md#collection-ownership) lists these records under Core, and Core already hides models it owns behind services (the audit log exports no model). A schema in `packages/db` would be a model any package could import, so the "only through Core's services" rule ([Architecture rules](../ARCHITECTURE.md#architecture-rules)) would rest on review alone.

## Decision

The master data schemas and their services live in `packages/core`, like every other Core schema. Core exports the services, never the models. Other modules (Engage from Phase 3, Ops, Supply and Desk from Phase 4) create, change and read these records only through Core's service functions. `packages/db` holds the connection, transactions and model helpers, and no module's schemas.

## Consequences

- One rule for every schema: it lives in its owning module's package. `packages/db` stays free of business data.
- Other modules can't reach the collections by import, only through services, which check module access and write the audit entry in the same transaction ([Managing master data](../modules/core.md#managing-master-data)).
- Core grows: it now holds the services Engage and Supply build their screens on. Those services check Engage and Supply access levels, so Core depends on the module access rules, which it already owns.
- Engage and Supply can't add fields to these records on their own. A new field is a spec change in the module spec that defines it, then a change in Core.

## Where the rules live

[Modules and packages](../ARCHITECTURE.md#modules-and-packages), [Repository layout](../ARCHITECTURE.md#repository-layout), [Collection ownership](../DATA_MODEL.md#collection-ownership), [Shared master data](../modules/core.md#shared-master-data), [build step 1.8](../BUILD_PLAN.md#phase-1-pulse-core)
