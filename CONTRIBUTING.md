# Contributing

How work gets done on Xtreme Pulse, whether you're typing the code or directing Claude Code. Items marked _(proposed)_ are defaults to confirm or change.

## The build loop

Work through [BUILD_PLAN.md](docs/BUILD_PLAN.md) one step per session, in order. The plan's [How to use this plan](docs/BUILD_PLAN.md#how-to-use-this-plan) section has the prompt to start each step. The loop is:

1. **Plan.** The agent reads the step and the docs in its **Spec** line, then shows a plan. Nothing is built until you approve it.
2. **Build.** Only this step. Push back on anything from a later step or a [future release](docs/ROADMAP.md#future-releases-not-in-current-scope).
3. **Check.** Work through [Before finishing a change](AGENTS.md#before-finishing-a-change) and the step's "Done when" line.
4. **Commit.** Once you've checked it yourself.

At the end of each phase, run the phase review and the phase check (see [TESTING.md](docs/TESTING.md)).

## Change the spec first

When a rule must change, or the agent reports something unclear, update the doc that owns the rule **before** changing code. Each rule lives in exactly one place. Other docs link to it instead of repeating it.

| To change… | Edit |
|---|---|
| What a module does, its fields, statuses, approvals or notifications | Its spec in [docs/modules/](docs/modules/README.md) |
| Sign-in, roles, module access, sensitive data, secrets | [SECURITY.md](SECURITY.md) |
| Money, ledger, stock, naming, document numbers, versioned configuration | [DATA_MODEL.md](docs/DATA_MODEL.md) |
| Module boundaries, stack, repository layout, jobs | [ARCHITECTURE.md](docs/ARCHITECTURE.md), plus an ADR |
| Colors, type, components, layout, motion, wording | [DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) |
| How code is written | [CODE_STYLE.md](docs/CODE_STYLE.md) |
| How changes are checked | [TESTING.md](docs/TESTING.md) |
| A legal or regulatory obligation | The implementing section, plus its row in [COMPLIANCE.md](docs/COMPLIANCE.md) |
| Hosting, environment, go-live | [DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Build order or future releases | [ROADMAP.md](docs/ROADMAP.md) |
| Agent workflow or commands | [AGENTS.md](AGENTS.md), or [CLAUDE.md](CLAUDE.md) for Claude-only rules |

Then:

- **Architectural decisions** get an ADR in [docs/adr/](docs/adr/README.md). Don't edit an accepted ADR. Supersede it with a new one.
- **Behavior changes** get a line in [CHANGELOG.md](CHANGELOG.md).
- **New terms** go in the [Glossary](docs/GLOSSARY.md).

## Keeping the docs healthy

- **One home per rule.** If you're about to copy a rule into a second file, link to it instead.
- **Headings are link targets.** The build plan, the other docs and code comments link to headings. If you rename one, search the repo for its old anchor and update every link.
- **Move text, don't rewrite it,** when reorganizing. Wording changes should be deliberate spec changes.
- **Keep AGENTS.md short.** It loads in every Claude Code session, so it holds pointers, not rules.

## Commits and branches _(proposed)_

- One commit per checked build step, so any step can be rolled back.
- Message format: `<module>: <step> <what changed>`, for example `core: 1.3 audit log and notifications` or `docs: clarify HR role rules`.
- Work on short-lived branches named after the step (`step/1.3-audit-log`) and merge to `main` once checked. Working directly on `main` is fine while there's a single developer, as long as every commit is checked.
- Never commit `.env.local`, the `storage/` folder, real employee data, or anything under [Secrets](SECURITY.md#secrets).

## Reviews

- **Phase review:** at the end of each phase, a review sub-agent checks the phase against the docs, using the [security review checklist](SECURITY.md#review-checklist).
- **Your review:** you check the plan before any code is written, and the result in the browser before it's committed.
