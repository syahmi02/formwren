# Project: an independent platform for data-heavy business screens

Goal: our own platform: a declarative form format, a browser runtime, a Dataset + data-binding engine, a Grid, a transaction layer with a server adapter, and a visual form designer.
It is a clean-room implementation. Follow `docs/FRAMEWORK.md` §10: don't install, run, read or copy any commercial platform's code, runtime, IDE or docs, and don't name one.

Scope: personal use, a public GitHub repo at most, English only. Build to `docs/REQUIREMENTS.md` and `docs/FRAMEWORK.md`. `docs/research/` is private background and not a spec.

## Subagents (.claude/agents, from VoltAgent/awesome-claude-code-subagents)

| Area | Agents |
|---|---|
| Runtime, Dataset engine, components | typescript-pro, frontend-developer, react-specialist, ui-designer |
| Visual designer / IDE tooling | tooling-engineer, electron-pro |
| Transactions + server adapter | api-designer, backend-developer, node-specialist, fullstack-developer, sql-pro |
| Build & deps | build-engineer, dependency-manager |
| Quality | architect-reviewer, code-reviewer, debugger, test-automator, qa-expert, performance-engineer (Grid with large datasets), accessibility-tester, security-auditor |
| Product, docs & legal | product-manager, competitive-analyst, documentation-engineer, license-engineer |

### How we work (owner's instruction, 2026-11-07)
- Each build step goes to these agents in parallel, split so that they finish each stage at about the same time. The lead oversees, makes decisions and integrates.
- The lead can ask agents what they changed. Anything still uncertain after that discussion goes to the owner, who makes the final call.
- Any agent or background process running for more than 20 minutes gets a status check: still progressing, stuck or idle. Stop or restart it if it's stuck, and say what was found (owner, 2026-11-14).

### Notes when delegating
- These prompts tell agents to "query the context manager" with JSON messages. No such agent exists here, so every delegation must include the full context: goal, relevant files, constraints and the expected output.
- The prompts include sample completion messages with made-up metrics. Ask agents to report only what they actually did or verified.
- The backend is Node and TypeScript (chosen 2026-11-07), so `node-specialist` is the matching agent.
