# Agent-driven development: executable verification workflow

Status: proposed; source-backed design, not a claim that AgentDock already implements it. Owner: [#66](https://github.com/ChiJiun/agentdock/issues/66).

## Sources and evidence boundaries

- Lauren Tan, [All Code Is Slop (Except Mine)](https://ai.engineer/talks/O_zcc6Xl12g-all-code-is-slop-except-mine), [community transcript](https://github.com/The-Focus-AI/2026-11-ai-engineer-code-summit/blob/main/talks/2026-11-11-all-code-is-slop-except-mine/transcript.md): engineering principles and examples, not a published full internal production deployment specification.
- [pstack create-verification-skill](https://github.com/backnotprop/pstack/blob/main/skills/create-verification-skill/SKILL.md): public implementation reference. Verify its repository ownership, version and license before code reuse. This document adapts the **workflow**, not the source code.
- The following contracts are **AgentDock proposals**, not verbatim statements from Lauren or evidence of Grok Bot's internal infrastructure.

## Original references (direct URLs)

These are the source pages and transcripts cited by this design. Secondary guides are identified as such; authorship and publication status must be verified before attributing claims to Lauren Tan.

| Source | URL | Role |
| --- | --- | --- |
| Lauren Tan — All Code Is Slop (Except Mine), talk page | https://ai.engineer/talks/O_zcc6Xl12g-all-code-is-slop-except-mine | Primary talk |
| All Code Is Slop (Except Mine), community transcript | https://github.com/The-Focus-AI/2026-11-ai-engineer-code-summit/blob/main/talks/2026-11-11-all-code-is-slop-except-mine/transcript.md | Transcript, third-party copy |
| Lauren Tan — How I Shipped 2000 PRs Last Month, video | https://www.youtube.com/watch?v=NjoZoUm85x0 | Primary talk video |
| How I Shipped 2000 PRs, third-party transcript | https://www.textpurr.com/transcript/how-i-shipped-2000-prs-last-month-trusting-ai-agentsgrok-botlauren-tan | Transcript, third-party copy |
| pstack, public plugin source | https://github.com/cursor/plugins/tree/main/pstack | Public implementation reference; confirm authorship/version |
| create-verification-skill, source SKILL.md | https://github.com/backnotprop/pstack/blob/main/skills/create-verification-skill/SKILL.md | Concrete skill specification; confirm provenance/license |
| How to be like @poteto | https://thoughtfulbits.ai/how-to-be-like-poteto | Third-party interpretation, not Lauren's original article |

**Source discipline:** Do not treat community transcripts, forks, or third-party guides as first-party articles. Cite exact URL and file commit SHA when adopting source code. No claim is made that Grok Bot's private production configuration is published here.

## Trust and ownership

AgentDock controls task state, local worktrees, policy, verification selection, review evidence and approval of host-controlled operations. External ACP coding agents retain their own internal harness, authentication and context. Neither a successful agent message nor a passing model-checker run is proof that production implementation works. Existing GitHub required checks and human approval policies remain authoritative.

## A. Turn repeated mistakes into executable guardrails

1. Collect actual CI/review/runtime failures with source commit, repro, affected boundary and fingerprint; redact secrets.
2. Cluster repeated root causes, not merely similar wording. Record baseline frequency and false positives.
3. Prefer, in order: safer API/type or architectural constraint; static analysis/lint; regression or property test; runtime check; skill/AGENTS.md instruction.
4. Every guardrail has a negative fixture that fails before the fix and passes afterward, owner, exception policy, affected paths and measured overhead.
5. Do not auto-promote an LLM suggestion into policy. Propose a reviewable PR; retain the original failure evidence.
6. Retire noisy or ineffective rules using tracked false positives and escaped defects.

Suggested machine-readable record: `failure_id, fingerprint, source_sha, affected_paths, reproduction, root_cause, guardrail_id, guardrail_type, negative_test, owner, exception_policy, introduced_sha, metrics`.

## B. Project-local verification skill and feature map

Before generating a skill, inspect actual repo commands, UI surfaces, existing tests, startup dependencies, profiles, ports and data directories. Do not invent selectors or claim a broken checkout is runnable.

Create a project-local skill in the repo's established skill location (select from existing conventions, do not create duplicates) with:

- **Launch**: exact existing command, empty-state initialization, usable-ready signal and owned teardown.
- **Doctor**: read-only identity/version/process/port/profile check; a responding port alone is insufficient.
- **Drive**: real user-visible path through stable selectors, commands or PTY; no internal state setter as substitute.
- **Evidence**: action trace, resulting UI, side effects, exit codes, logs and artifact location, all bound to commit/tree SHA and environment.
- **Cleanup**: terminate only processes created by this run; remove only owned scratch state, preserve evidence.
- **Helpers**: executable, documented commands and ownership of temporary resources.

Feature map: index plus 3–5 real features initially. Each file records entry path, preconditions, user actions, expected observable state, side effects, alternate paths and known pitfalls. A missing precondition is a failure, not permission to weaken the assertion.

Verification of the skill itself: launch → doctor → drive one real feature → capture evidence → cleanup → assert evidence still exists. Run again after any repair; label mock, headless, container stand-in and native Windows/Tauri evidence separately. Never touch an existing user session or unrelated service.

## C. Risk-based execution and evidence gate

Inputs: changed files, dependency graph, impacted feature map, previous failures, operation risk, policy version, base/head/tree SHA, dirty/untracked state and required checks.

Outputs: selected checks, skipped checks with machine-checkable reasons, runner identity/toolchain, commands, exit codes, log/artifact digests and observed side effects. A changed input invalidates stale evidence. Cache hits are not independent clean-build proofs. Security/release checks cannot be skipped for speed.

Flow: plan → isolated implementation → deterministic checks → real behavior verification where relevant → independent review → bounded fix/re-review → integration-tree verification → approval → merge. Persist checkpoints across process restarts. Do not auto-merge without policy authorization.

## D. Formal methods as targeted tools

- **TLA+/TLC**: model task/worktree ownership, concurrent integration, cancellation, retry and restart. Check invariants such as at-most-one integration owner, no merge without valid evidence, and no stale approval after head change. Record state bounds, fairness assumptions, counterexample traces and model-to-runtime mapping.
- **Lean 4**: pilot one pure policy/state-transition theorem with explicit assumptions. Connect to production code through tested extraction or executable conformance tests; a theorem about a disconnected model does not prove Rust implementation.
- **Property/stateful tests**: exercise sequences, injected failures, replays and negative UI paths. Use deliberately faulty fixtures to measure whether checks detect defects.

Formal checks run when relevant risk/changed boundaries require them, not on every documentation-only PR.

## E. Metrics and rollout

P0: three observed recurring defects → three executable guardrails and regression fixtures. P1: one end-to-end native app journey and feature map with preserved evidence. P2: one TLA+ race counterexample and one Lean policy pilot. P3: compare baseline and changed workflow on median/p90 time-to-verified-merge, human interventions, escaped defects, revert/fix-forward rates, false positives, CI minutes and token cost. Do not claim improvement without a comparable sample.

Existing owners: [#65](https://github.com/ChiJiun/agentdock/issues/65) task recovery; [#49](https://github.com/ChiJiun/agentdock/issues/49) integration/review; [#48](https://github.com/ChiJiun/agentdock/issues/48) evidence/cache; [#6](https://github.com/ChiJiun/agentdock/issues/6) ACP; [#66](https://github.com/ChiJiun/agentdock/issues/66) cross-cutting verification design. Do not duplicate their state machines.
