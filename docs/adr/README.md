# Architecture decision records

Each file records one significant decision: the context, what was decided, and what follows from it. Rules live in the docs they link to. An ADR explains *why*.

To add one, copy [0000-template.md](0000-template.md), take the next number, and link it here. Don't rewrite an accepted ADR. To change a decision, write a new ADR that supersedes it and mark the old one **Superseded by NNNN**.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-modular-monolith.md) | One application, built as a modular monolith | Accepted |
| [0003](0003-mongodb-replica-set.md) | MongoDB replica set with Mongoose | Accepted |
| [0004](0004-password-only-auth-on-internal-network.md) | Password-only sign-in on an internal network | Accepted |
| [0005](0005-field-level-encryption.md) | Field-level encryption for sensitive data | Proposed (settled in step 0.8) |
| [0006](0006-money-as-integer-centavos.md) | Money as integer centavos | Accepted |
| [0007](0007-append-only-records-and-derived-balances.md) | Append-only records and derived balances | Accepted |
| [0008](0008-versioned-configuration.md) | Versioned, effective-dated configuration | Accepted |
| [0009](0009-background-jobs-bullmq.md) | Background jobs on BullMQ and Redis | Accepted |
| [0010](0010-manual-verification-before-automated-tests.md) | Manual verification before automated tests | Accepted |
| [0011](0011-file-storage-in-project-folder.md) | Files stored in a folder with the app, not S3 | Accepted |
