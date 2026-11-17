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
2. Define UX states + design tokens and screen map, including zh-TW/en-US labels and the [Language Policy](architecture/language-policy.md) for task/skill/prompt outputs.
3. Rust & Tauri scaffold with typed front/back boundary.
4. ACP mock first and supported real adapter compatibility matrix.
5. Storage and approval gates before unrestricted real-agent tools.
6. Worktree and change review.
7. GitHub integration with human confirmation before pushes/merges.
8. Remote worker after reliable local tasks.
9. Provider routing & advanced token optimizations after metrics, informed by [Copilot Fusion research](research/copilot-fusion.md) (Single/Cascade/Critique, cache-aware context, independent review). Prototype the optional Rust Copilot SDK adapter separately before considering deeper runtime reuse.

## Language release gate

- UI can switch between `zh-TW` and `en-US` without reloading agent state or triggering LLM calls.
- Owned role templates and simulated Session Sentinel summaries use the selected workflow locale.
- External ACP/SDK language policy is only reported as applied if the adapter confirms compatible support; prompt/Skill overrides are never assumed.
- Source code, raw CI logs, commands and original Skill files remain unchanged by language switching.
- A language preference change never changes authorization/approval rules.

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
