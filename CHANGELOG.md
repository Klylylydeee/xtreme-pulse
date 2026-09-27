# Changelog

Notable changes to Xtreme Pulse, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Record each build phase as it ships, and any spec change that alters behavior.

## [Unreleased]

### Spec changes

- 2026-09-27: Sensitive fields fail closed ([ADR 0012](docs/adr/0012-fail-closed-sensitive-fields.md)). `sensitiveField()` is limited to single-value fields and fields in arrays of subdocuments; other shapes throw when the schema is defined, and `strict: false` writes, `$rename` of sensitive paths and upserts filtering on them are refused. Every collection with sensitive paths gets a `$jsonSchema` validator, installed with its indexes, that rejects plain values. The guard gets the first automated tests, run by `pnpm test` ([Sensitive data](SECURITY.md#sensitive-data), [Sensitive-data guard tests](docs/TESTING.md#sensitive-data-guard-tests)).
- 2026-09-27: Allowed email domains are stored records (`allowedEmailDomains`) that the System Administrator manages; `ALLOWED_EMAIL_DOMAINS` is only the default list `pnpm seed:admin` loads ([Sign-in and passwords](SECURITY.md#sign-in-and-passwords)).
- 2026-09-27: Local development no longer uses Docker. MongoDB 8 Community Server (as the single-node replica set `rs0`) and Redis (on Windows, Memurai or a Windows port) are installed locally; setup is in [README.md › Getting started](README.md#getting-started). `docker-compose.yml` is removed.

- 2026-09-25: Files are stored in a `storage/` folder with the app instead of S3-compatible storage (MinIO), and open only through an access-checked route ([ADR 0011](docs/adr/0011-file-storage-in-project-folder.md)).
- 2026-09-25: Answered the four security questions. HR, Accounting and Board roles come from the department. Only a System Administrator resets a System Administrator's password. HR staff's pay and bank details are changed only by the System Administrator or a Board member. Sessions last 24 hours.

### Documentation

- 2026-09-25: Split the single `CLAUDE.md` spec into a documentation set: `README.md`, `AGENTS.md`, a slim `CLAUDE.md`, `SECURITY.md`, `CONTRIBUTING.md`, the module specs in `docs/modules/`, and architecture, data model, design system, code style, testing, compliance, glossary, deployment, runbook and roadmap docs, plus ADRs 0001–0010. Spec wording moved unchanged. [SPEC_INDEX.md](docs/SPEC_INDEX.md) maps each old section to its new place.
- 2026-09-24: Build plan written. Thirteen open questions answered in the spec (see [Decisions added to the spec](docs/BUILD_PLAN.md#decisions-added-to-the-spec)).

<!--
Template for a release:

## [0.1.0] - YYYY-MM-DD  (Phase 0: Foundation)
### Added
### Changed
### Fixed
### Security
-->
