# Development harness

## What is active

- `AGENTS.md` is the canonical cross-agent contract.
- `CLAUDE.md` imports that contract for Claude Code.
- `.claude/skills/frontend-design` is the audited Anthropic skill pinned to its reviewed commit.
- `.claude/agents/product-researcher.md` handles bounded, read-only investigation.
- `.claude/agents/change-reviewer.md` performs a focused, read-only diff review.
- `docs/plans/` and `docs/decisions/` retain durable reasoning without bloating standing instructions.

## Normal loop

1. Ask the main agent to inspect the requested area and state a bounded outcome.
2. Delegate uncertain external research to `product-researcher` when it would otherwise flood the main context.
3. Create a plan only for multi-boundary or risky work.
4. Implement one vertical slice.
5. Run the repository's documented checks.
6. Use `change-reviewer` before committing meaningful changes.
7. Record only decisions expected to outlive the current task.

## Claude Code built-ins

After updating Claude Code, prefer its bundled `/run`, `/verify`, `/code-review`, `/debug`, and `/security-review` workflows. Once the project can launch, run `/run-skill-generator` so the actual startup recipe is recorded instead of maintained speculatively here.

## Deliberately absent

- No MCP server: the initial implementation needs ordinary APIs and local tools.
- No hooks: build and test commands do not exist yet, and a hook without a stable command creates noise.
- No blanket tool approvals: each potentially mutating operation should retain normal permission checks.
- No agent team: two focused read-only subagents are enough for the current project size.

## Maintenance

Whenever scaffolding changes how the system installs, runs, tests, or validates, update this file. Remove harness elements that are not earning their context or maintenance cost.
