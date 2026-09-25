# Changelog

Notable changes to Xtreme Pulse, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Record each build phase as it ships, and any spec change that alters behavior.

## [Unreleased]

### Spec changes

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
