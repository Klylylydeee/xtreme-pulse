# Agent Workflow (read first)

Claude must never do the work itself. Always dispatch a sub-agent for every task.

## Model routing

- **Haiku 4.5** (`model: "haiku"`): lookups and summaries
- **Opus 5.5** (`model: "opus"`): everything else (default)
- Always pass `model` explicitly on every agent call

## Delegation

- One sub-agent per task; plan first before dispatching
- Run independent sub-agents in parallel
- Read the sub-agent's report, never the files directly
- Verification (typecheck, lint, tests, review) is also delegated to a sub-agent
- Tell each sub-agent which docs to read: the links in the step's **Spec** line in `docs/BUILD_PLAN.md`, or the map in `AGENTS.md`

---

# Xtreme Pulse

The project instructions shared by every coding agent are in `AGENTS.md`, imported below. The specs live in `docs/` and `SECURITY.md`. Read only the ones a task needs.

@AGENTS.md
