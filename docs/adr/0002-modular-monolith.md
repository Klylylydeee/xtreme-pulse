# ADR 0002: One application, built as a modular monolith

- **Status:** Accepted
- **Date:** 2026-09-24 (original spec)

## Context

Xtreme Pulse has eight modules that share users, access, master data and approvals, and pass work along one business lifecycle, from deal to project to invoice to support. It's built by a very small team with Claude Code.

## Decision

Build one Next.js application with one sign-in. Each module is a section of the app with its own package, and it owns its own collections. Modules call each other's service functions and never write each other's data.

## Consequences

- One deploy, one database and one sign-in, with no network calls between modules.
- Module boundaries hold only by discipline, so reviews must check that no module writes another's collections.
- A module could later be split out along its service functions if ever needed.

## Where the rules live

[One application](../ARCHITECTURE.md#one-application), [Architecture rules](../ARCHITECTURE.md#architecture-rules), [Cross-module integration](../ARCHITECTURE.md#cross-module-integration)
