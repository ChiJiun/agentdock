# Delivery Roadmap & Validation

Status: proposal; not a promise of completion dates.

## Milestones

| Phase | Scope | Exit gate |
| --- | --- | --- |
| M0 — Sources and decisions | Identify sources, licenses, ACP SDK choice, UX reference, threat model | ADR, provenance inventory, clear exclusions |
| M1 — Desktop skeleton | Rust workspace/Tauri 2 + React, Windows dev build, CI | App starts, smoke test, lint/build CI |
| M2 — Usable sessions | Project management, typed ACP host, 2 adapters, streaming, persistence, approvals | Same test task works through 2 agents and safe cancel |
| M3 — Coding workflow | Git diff/worktree and tests; GitHub Issue→PR review→CI | Isolated parallel worktree test + PR demonstration |
| M4 — Reliable remote | SSH worker, durable event log, reconnect, bounded concurrency | Disconnect/reconnect and no duplicate side effects |
| M5 — Cost/Advisor | Role routing, manual advisor, budgets, benchmarks | Cost and quality evaluated against baseline |

## Initial work order

1. License/provenance / precise upstream migration decision.
2. Define UX states + design tokens and screen map.
3. Rust & Tauri scaffold with typed front/back boundary. The separate UI-foundation branch prototypes Session Sentinel and keyboard navigation with in-memory data; real backend monitoring is tracked in [Issue #15](https://github.com/ChiJiun/agentdock/issues/15).
4. ACP mock first and supported real adapter compatibility matrix.
5. Storage and approval gates before unrestricted real-agent tools.
6. Worktree and change review.
7. GitHub integration with human confirmation before pushes/merges.
8. Remote worker after reliable local tasks.
9. Provider routing & advanced token optimizations after metrics.

## MVP Definition of Done

- Clean Git repo, reproducible Windows dev build.
- Repo picker and local project list persist.
- Start and cancel session with two adapters, including a deterministic mock.
- Session event log survives app restart without pretending external agent session can resume.
- Permission denial actually stops host-controlled operation.
- Git status and diff shown for changed files.
- CI runs representative tests and lint; failure artifacts discoverable.

## V1.0 Definition of Done

- Separate worktrees for concurrent task runs.
- Issue→PR→CI demo with independent review and human-approved merge boundary.
- Remote work survives UI disconnect; worker reconnect catches missed events.
- Accurately distinguishes API cost estimate vs unknown subscription remaining quota.
- Documented security threat model and forced failure/restart tests.

## Benchmarks

Run identical representative tasks on: (A) single strong model, (B) role routing, (C) routing+advisor. Record model versions, prompts, repo commits, tests, success rate, API billed costs where available, cache stats, retries, elapsed time, intervention and crash recovery. Do not extrapolate the purported 99% single-update saving to total task costs.

## CI

- Rust fmt, clippy, tests.
- TypeScript typecheck, lint, unit tests.
- Windows desktop build smoke test before announcing Windows support.
- Git fixtures and mock-ACP integration tests.
- Security regression tests for path traversal, approval bypass, symlink escape and replay.
- No secrets in CI or demo fixtures.

## Delivery caution

For one developer working around classes and internship, optimize for vertical slices: a real agent finishes a safe task in a real repo, with visible evidence, before building an Agent OS. Multi-month estimates are dependent on available engineering time, not a fixed release commitment.

## M2.5 · Self-hosting Alpha

[#51](https://github.com/ChiJiun/agentdock/issues/51) requires a reproducible Windows install and smoke test, real Claude Code and Codex tasks, persistent events, two isolated worktrees, host-controlled approvals and authenticated test evidence. Release after ten real tasks meet the gate and publish checksums and known limitations. Measure 20–30 tasks before replacing the existing workflow.

V1 expands Local CI, caching and the integration queue via #47–#49. V2 and Later decisions are in the [capability plan](research/agentdock-capability-map.md). Repository protection is tracked in [#55](https://github.com/ChiJiun/agentdock/issues/55) and the [four weekly-synced forks](sources.md#upstream-source-retention) in [#53](https://github.com/ChiJiun/agentdock/issues/53).
