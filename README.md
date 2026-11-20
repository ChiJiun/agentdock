# AgentDock

**A Rust-powered, agent-agnostic coding workbench inspired by the usability patterns of Claude Code Desktop.**

> Status: early implementation. The React/Vite app now contains **both a simulated UI preview and a real local ACP development runtime** using the official SDK. **The production Rust/Tauri desktop binary, full SDLC automation and remote worker are not implemented yet**.

AgentDock aims to give a developer one desktop environment for multiple coding agents, isolated Git worktrees, controlled tool approvals, verifiable review/CI workflows, and eventually resilient remote execution. It is an independent product—not an official Anthropic or Claude application.

## Why “AgentDock”?

- **Agent**: Claude Code, Codex, Octomind and other coding agents.
- **Dock**: a central place to launch, observe, steer, review, and reconnect their work.
- The name is a *working title*, not a reference to Docker. Trademark and name availability have not been cleared.

## Product principles

1. **UX-first:** Claude Code Desktop-inspired project/session sidebar, streaming chat, visible tool events, diffs, approvals, and integrated task status; build an original visual identity.
2. **Agent-agnostic:** preserve each external agent’s own runtime and authentication through ACP where supported.
3. **Workflow-first:** Issue → Plan → Worktree → Implement → Test → Independent Review → PR → CI → Human-approved merge.
4. **Safety as code:** tool permissions, budget caps, and approval rules enforced by the host, not by prompts alone.
5. **Measurable:** record supported usage/cost/latency metrics and benchmark correctness, not just token savings.
6. **Local-first:** Windows desktop first; remote Linux worker and headless execution follow after a stable MVP.
7. **Source provenance:** evaluate modules and licenses before copying anything.

## Planned stack

- Tauri 2 + React / TypeScript + Vite for desktop UI
- Rust + Tokio orchestration and ACP client
- SQLite for projects, tasks, sessions, events and approvals
- Git CLI / worktrees and GitHub CLI or GitHub API for SDLC integration
- SSH + optional persistent Rust worker for remote execution

## Run the workbench (development branch)

```sh
npm ci
npm run dev:full
```

Open **http://127.0.0.1:5173/**. The original preview demonstrates the UI using sample data. Click **Live ACP / 即時 ACP** to run a genuine ACP v1 session through the official TypeScript SDK. The built-in mock runs as a real child process and returns deterministic test replies **without using a model or editing files**. With an explicitly configured, locally authenticated third-party ACP agent, the same transport can run real coding tasks. **Do not use untrusted repositories or adapters before OS sandboxing is implemented.**

For standalone UI work: `npm run dev`. For tests: `npm run typecheck && npm run test:all && npm run build`.

Full setup, adapter allowlist, storage, restart behavior and security limitations: **[Live ACP runtime implementation](docs/implementation/live-acp-runtime.md)**. The production Rust/Tauri desktop shell is tracked in Issue #4, ACP host in Issue #6, SQLite session history in Issue #7, and event-driven Session Sentinel in Issue #15.

## Project documents

- [Product requirements](docs/PRD.md)
- [Architecture and data contracts](docs/architecture.md)
- [Upstream source inventory, migration matrix and licenses](docs/sources.md)
- [Roadmap and release gates](docs/roadmap.md)
- [Live ACP development runtime and verification](docs/implementation/live-acp-runtime.md)
- [Language UI and safe Skill output policy](docs/implementation/language-ui.md)
- [Architecture decision 0001](docs/decisions/0001-independent-workbench.md)
- [Agent contributor rules](AGENTS.md)

## Related work

- Acpira upstream: https://github.com/hotic/acpira
- Acpira experimental fork: https://github.com/ChiJiun/acpira
- Prior feature design: https://github.com/ChiJiun/acpira/issues/10
- ACP: https://agentclientprotocol.com/
- Official Claude Code Desktop UX reference: https://claude.com/resources/articles/claude-code-desktop-redesign

## Working policy

The UI preview uses original AgentDock components and helpers, following the **reimplement** decision in [ADR-0002](docs/decisions/0002-source-reuse.md). No Acpira source files are vendored. External runtimes should be integrated over public protocols first. A future migration PR must document source location + commit, exact files, license, necessary attribution/NOTICE, adaptations, tests and a plan for keeping security fixes up to date.

## Licensing

AgentDock's distribution license remains to be decided. The UI preview depends on published npm packages, whose notices must be included in release artifacts. Third-party repositories have different obligations, especially AGPL-3.0. See [sources.md](docs/sources.md).
