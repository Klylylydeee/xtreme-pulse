# ADR 0009: Background jobs on BullMQ and Redis

- **Status:** Accepted
- **Date:** 2026-09-24 (original spec)

## Context

Much of the app runs on time: SLA timers, reminders, expiry alerts, the October 1 holiday draft, month-end snapshots and the Monday Board summary.

## Decision

Run scheduled and delayed work in a BullMQ worker process backed by Redis, with schedules on Asia/Manila time. The worker runs alongside the web app, and `pnpm dev` starts both locally.

## Consequences

- Production needs Redis and a long-running worker, and a way to notice when the worker stops (see [Background jobs stopped](../RUNBOOK.md#reminders-sla-alerts-or-summaries-stopped)).
- Jobs must be safe to run twice. For example, only one renewal deal is created per expiring item.

## Where the rules live

[Background jobs](../ARCHITECTURE.md#background-jobs), [Tech stack](../ARCHITECTURE.md#tech-stack)
