# AgentDock

**A Rust-powered, agent-agnostic coding workbench inspired by the usability patterns of Claude Code Desktop.**

> Status: product specification and architecture planning. **No application implementation or migrated third-party source code is present yet.**

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

## Project documents

- [Product requirements](docs/PRD.md)
- [Traditional Chinese / English end-to-end Harness language policy](docs/architecture/end-to-end-language-policy.md)
- [Architecture and data contracts](docs/architecture.md)
- [Upstream source inventory, migration matrix and licenses](docs/sources.md)
- [Roadmap and release gates](docs/roadmap.md)
- [Architecture decision 0001](docs/decisions/0001-independent-workbench.md)
- [Agent contributor rules](AGENTS.md)

## Related work

- Acpira upstream: https://github.com/hotic/acpira
- Acpira experimental fork: https://github.com/ChiJiun/acpira
- Prior feature design: https://github.com/ChiJiun/acpira/issues/10
- ACP: https://agentclientprotocol.com/
- Official Claude Code Desktop UX reference: https://claude.com/resources/articles/claude-code-desktop-redesign

## Working policy

This repository initially contains **original project documentation only**. External runtimes should be integrated over public protocols first. A migration PR must document source location + commit, exact files, license, necessary attribution/NOTICE, adaptations, tests and a plan for keeping security fixes up to date.

## Licensing

**To be decided before publishing copied third-party implementation.** Third-party repositories have different obligations, especially AGPL-3.0. The initial repository is private while architecture and provenance are being evaluated. See [sources.md](docs/sources.md).
