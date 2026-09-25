# ADR 0003: MongoDB replica set with Mongoose

- **Status:** Accepted
- **Date:** 2026-09-24 (original spec)

## Context

The stack is full-stack Next.js with MongoDB. Many operations touch more than one collection and must succeed or fail together. For example, posting an invoice updates the ledger, AR and the milestone's status.

## Decision

Use MongoDB through Mongoose, always as a replica set (a single-node one locally), so multi-document transactions are available. Every operation touching more than one collection runs in `session.withTransaction`.

## Consequences

- Local development and production both need a replica set, not a standalone server.
- MongoDB doesn't enforce a schema, so schemas and the data rules must be written down and followed (see [DATA_MODEL.md](../DATA_MODEL.md)).
- The MongoDB edition decides how field encryption works (see [ADR 0005](0005-field-level-encryption.md)).

## Where the rules live

[Money](../DATA_MODEL.md#money), [Tech stack](../ARCHITECTURE.md#tech-stack)
