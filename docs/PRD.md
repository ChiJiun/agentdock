# AgentDock Product Requirements (PRD)

Status: Proposed · 2026-11-17 · Owner: ChiJiun

## 1. Problem

Coding agents can already implement code. The friction is managing many projects and sessions, reviewing changes, comparing models, controlling permissions, dealing with quota failures, and keeping long-running work reliable. Switching among Claude Code, Codex, GitHub, terminals and a remote Linux machine fragments the workflow.

## 2. Product vision

An original desktop workbench with **Claude Code Desktop-inspired interaction patterns**: choose a repository, spawn or resume an isolated session, steer an agent through a clear streaming timeline, inspect diffs and test evidence, and safely promote changes through a PR.

This product is not a Claude/Anthropic clone and should not copy protected assets or branding.

## 3. Primary persona & environments

- Developer with concurrent research, backend and open-source projects.
- Windows 10/11 desktop and WSL; occasional Linux VM. Linux Desktop and macOS can come later.
- Existing agent subscriptions may be used through their native CLIs. An API-key-driven native agent is optional.
- Remote VM is resource-constrained and also hosts other services: conservative concurrency and isolation are required.

## 4. Jobs to be done

1. Start a coding task from a local Git repository or GitHub Issue in <=3 deliberate actions after initial setup.
2. See all running, blocked, completed and interrupted sessions in a unified sidebar.
3. Prevent parallel sessions from accidentally editing the same workspace: prefer worktree-per-task.
4. See tool calls, diffs, tests, approvals and PR/CI states without losing chat context.
5. Assign separate agents for implementation and independent review.
6. Continue remote work after the desktop UI disconnects, without replaying non-idempotent operations.
7. Track per-task API cost where measurable; indicate subscription quota as unknown when the provider does not expose it.

## 5. UX information architecture

- **Home**: recent repositories, active/awaiting-approval tasks, recent failures and resumable work.
- **Project**: repository metadata, branches, worktrees, tasks and sessions.
- **Session**: model/agent label, conversation stream, tool events, plan, approval prompts, task status, steer/cancel.
- **Review drawer**: changed file list, diff, tests, reviewer findings, comment-to-agent.
- **GitHub**: Issue/PR links, checks, remote status; do not auto-merge.
- **Settings**: agent adapters, accounts, providers, workspace scopes, budget, optional SSH targets.

Design pattern: left sidebar / primary session / collapsible right evidence panel. Terminal and editor are embedded or delegated to the developer's IDE; do not build a full IDE in MVP.

## 6. Full-workflow language control (zh-TW / en-US)

AgentDock must support **switching the language of the entire developer-facing workflow**: UI, agent explanations, task plans, advisor/subagent/reviewer prompts, skill output styles, GitHub PR/Issue narratives, CI explanations and Session Sentinel updates. This is separate from source code language, which should not change because a UI locale changed. Initial locales: Traditional Chinese (Taiwan, `zh-TW`) and English (`en-US`), with global/project/session overrides and an optional explicit per-task locale. Apply only through supported, trusted context APIs; do not silently rewrite external `SKILL.md`, `CLAUDE.md`, `AGENTS.md` or opaque vendor system prompts. Expose a capability-based `owned` / `confirmed` / `best-effort` / `unsupported` status per agent, and never report a language instruction as applied before the adapter confirms it. Requirements and safety tests: [Language Policy](architecture/language-policy.md), [Issue #18](https://github.com/ChiJiun/agentdock/issues/18).

## 7. Functional requirements and versions

### MVP — usable, safe desktop client

- Project picker, persisted recent project list, git branch/status.
- Two working ACP adapter configurations, including support for a mocked adapter in CI.
- Live agent output + typed tool event timeline; start, cancel, recover persisted UI history.
- Capability-based feature display: never claim external agent session resume if unavailable.
- Approval prompt with deny/approve; enforcement on actions the workbench controls.
- Local Git diff and test results; no automatic push.
- SQLite schema with migrations for projects, tasks, sessions, events and approvals.
- Basic Windows installer/dev flow, logging, accessible keyboard navigation, dark/light themes.

### V1.0 — complete SDLC & remote execution

- Worktree-per-task, naming rules, safe cleanup with explicit confirmation.
- Issue → Plan → Branch/Worktree → Implementation → Verify → Independent Review → PR → CI.
- GitHub authenticated operations with least privilege and audit trail.
- Rust remote worker over authenticated SSH with durable task state and reconnect semantics.
- Clear distinction between view restoration, actual agent session reattach, task resume.
- Per-task usage metrics when exposed by adapters/providers.
- Opt-in OS notifications for approvals / completion.

### V1.x — cost-aware autonomous orchestration

- Role-based executor/explorer/advisor/reviewer/progress model configuration.
- Manual advisor, then policy-constrained automatic escalation; no unbounded recursion or retries.
- Event-driven background status reporting; polls should not incur model fees.
- Token/cache statistics and controllable API budgets; subscription quotas marked unknown.
- Scheduler, bounded concurrency, resume on provider throttling, explicit task deadlines.
- A future adaptive execution selector inspired by [Copilot Fusion](research/copilot-fusion.md): Single, bounded Cascade and read-only Critique; allow explicit Manual mode and provider-owned Fusion tiers via a supported SDK adapter. Do not claim vendor internals are configurable.
- Objective benchmarks comparing baseline with orchestrated agent configurations.

## 8. Non-functional requirements

- No hidden tool execution or secret exfiltration. Scope tools to allowed workspaces.
- UI closure must not silently cancel *remote, explicitly persistent* work; local process lifecycle should be explicit.
- After crashes, task timeline remains readable and pending approvals are not silently bypassed.
- State transitions recorded to durable storage, with stable task IDs and structured event types.
- Adapter-specific capabilities and failure states exposed without misleading UX.
- Avoid runtime versions that unnecessarily require heavyweight system-wide modifications.
- Accessibility: keyboard-first navigation and labels, non-color-only status cues.

## 9. Product exclusions for MVP

- Reimplementing Claude Code, Codex, or Octomind internals.
- Full IDE or cross-platform mobile client.
- Autonomous merge to protected/default branches.
- Guaranteed 24/7 cloud infrastructure or exact subscription quota measurement.
- Rebranding or copying proprietary Claude UI artwork/assets.

## 10. Success gates

- Two independently configured agents can complete a scripted task end-to-end.
- Concurrent tasks in distinct worktrees cannot accidentally overwrite each other.
- Denied tool action does not execute, including after UI reload.
- Session timeline survives desktop restart; unavailable agent resumption is shown explicitly.
- One human-approved Issue → PR → CI demonstration with logs.
- No unsupported claims about real remaining subscription quota.

See [roadmap.md](roadmap.md) for sequencing and concrete tests.
