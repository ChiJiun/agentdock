# Research: Claude Code Advisor vs GitHub Copilot Fusion for AgentDock

Date: 2026-11-17
Status: Research input (not implemented, not a decision). Model tiers and routing rules are decided in [ADR-0005](../decisions/0005-model-tiers.md); where this document and ADR-0005 differ, ADR-0005 wins.
Related: #6 ACP adapter · #7 event store · #8 policy · #13 cost/Advisor · #14 benchmarks · #15 Session Sentinel · [ADR-0004](../decisions/0004-rust-primary-backend.md) (Rust backend) · [ADR-0005](../decisions/0005-model-tiers.md) (model tiers) · [coding-harness-comparison.md](coding-harness-comparison.md)

## Summary and status relative to ADR-0005

**This document is research input for [Issue #13](https://github.com/ChiJiun/agentdock/issues/13). It does not define tiers or routing rules.** Those are in [ADR-0005](../decisions/0005-model-tiers.md) (Status: Proposed), with the evidence in [coding-harness-comparison.md](coding-harness-comparison.md). In short, ADR-0005 keeps three independent axes (capability tier `T-default` and `T1`–`T4`; orchestration `single`/`parallel`; permission), defaults to `T-default`, allows only manual selection in V1, downgrades but never upgrades automatically, defers bounded automatic escalation to V2, forbids hidden routing, and lists Fusion-style automatic routing under "Alternatives considered" as conflicting with the no-hidden-interception rule.

What this document adds is a description of four execution patterns seen in Copilot Fusion and Claude Code Advisor:

1. `Single` — one model/agent handles the request.
2. `Cascade` — a cheaper executor proposes work; a quality gate either accepts it or escalates/repairs.
3. `Critique` — a drafting executor produces a candidate, independent read-only reviewers inspect it, and the executor revises if necessary.
4. `Advisor` — a consultative escalation for major decisions, repeated failures, or completion review; **not equivalent to a cascade or a replacement executor**.

How they relate to ADR-0005 (the first two rows restate ADR-0005; the Advisor row is this document's inference):

| Pattern | ADR-0005 axis | Note |
| --- | --- | --- |
| Single | orchestration `single` | The baseline. Which tier it runs at is a separate choice |
| Cascade, Critique | orchestration (ADR-0005 names Copilot Fusion's Cascade/Critique as orchestration strength, and lists critique under `parallel`) | More model calls or agents for one task: an explicit switch with a visible cost warning, never hidden inside `T4` |
| Advisor | not assigned by ADR-0005 (it leaves the PRD's advisor role to #13) | Inference: a manual advisor consultation is a separate, bounded session with its own tier |

These patterns can only be configured and benchmarked **when AgentDock owns the relevant model calls and execution loop**. For Claude Code, Codex, Octomind, GitHub Copilot, and other external ACP-backed harnesses, keep their own model routing and private context untouched. Use only capabilities their adapters actually expose.

## Official references and what they establish

| Reference | Reported finding (2026-11-17 reading of the vendor page; vendor statements, not AgentDock measurements) | AgentDock consequence |
| --- | --- | --- |
| [GitHub Copilot Fusion announcement (2026-10-28)](https://github.blog/changelog/2026-10-28-route-and-orchestrate-models-with-github-copilot-fusion/) | Fusion combines model routing with Single, Cascade, Critique and selectable effort levels | Surface strategy/effort as a policy choice, not a fixed model |
| [GitHub Copilot Fusion docs](https://docs.github.com/en/copilot/concepts/models/copilot-fusion) | Chooses workflow per prompt; considers model capability, health, availability, and cache boundaries. Auxiliary reviewers get bounded context | Avoid switching main models mid-session purely for small savings; use side consultations and context-minimized critics |
| [HydraFusion engineering writeup (2026-09-04)](https://github.blog/ai-and-ml/project-hydrafusion-frontier-quality-via-multi-model-orchestration/) | Complete leg-by-leg accounting, bounded execution, read-only critique, validated routing, fail-safe application | These are requirements, not optional optimizations |
| [Claude Code Advisor documentation](https://code.claude.com/docs/en/advisor) | Experimental Anthropic server-side tool; a second model can consult the **full conversation** at selected points; every call consumes extra tokens | Do not promise cheaper full-history consultations. A separate AgentDock advisor must be explicit and auditable |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) | Subagents have isolated context, model/permissions and usage limits; dedicated tasks reduce parent-context pollution | Use scoped research/reviewer agents; cost may still increase from extra calls |
| [GitHub usage guidance](https://docs.github.com/en/copilot/tutorials/optimize-ai-usage) | Prefer low-cost subagents and preserve prompt caches | Optimize context boundaries and per-role cost, not just cheapest-model selection |

### What the original '5 settings to save Claude Code quota' post contributes

1. **A strong main model is not always needed.** Default to an efficient executor, allow a more capable advisor for difficult steps.
2. **Escalation must be selective.** Candidate triggers: before irreversible architecture choice; repeated verified failure; substantial completion review. User can manually request an advisor.
3. **Research should be isolated.** Repo search, docs ingestion and log summarization are good candidates for cheap subagents or deterministic tools.
4. **Progress summaries should not replay an entire transcript.** This is separate from agent execution; use structured events and short evidence.
5. **Prompt guidance is not enforcement.** Config files can state preferred use; the Rust policy must enforce call limits, budget, permissions and maximum retries.

The post's approximate **99% reduction** refers to a particular reported *background status update* cost, not end-to-end coding task savings. Treat it as a claim requiring a reproducible benchmark before citing it as a product performance result. Also: the current Claude Advisor official documentation has environment/version restrictions; do not assume `/advisor` is exposed in every account or ACP adapter.

## Important differences: Advisor vs Fusion

| Question | Claude-style Advisor | Fusion-style orchestration |
| --- | --- | --- |
| Primary purpose | Consult stronger model at important decision points | Select the overall inference workflow per prompt/task |
| Main model continuity | Main executor normally continues after advice | May select Single, Cascade or Critique dynamically |
| Second-model role | Advice/guidance, not automatically another executor | Judge, fresh-start repair model, critic, or reviewer |
| Extra context | Claude's built-in Advisor receives full transcript each invocation | Auxiliary legs should receive only justified evidence, not full transcript by default |
| Quality check | Advisor returns guidance, executor incorporates | Gate/critic decides acceptance or revision within bounded policy |
| Cost | Additional advisor token usage | Sum of every stage (including rejected/failed legs) |
| Visibility | Consulted/declined/unavailable | Show stage/model/status and final validated output, avoid presenting drafts as final |

**Single** is the baseline, not a failure of orchestration. More reviewers on every prompt can cost more and add latency. Copilot Fusion's Standard/High/Max correspond to a *quality/cost effort intent*, not user-selectable raw model mappings. AgentDock does not copy those names and does not map them onto `T1`–`T4`: they are provider-managed settings of the Copilot runtime that combine effort with orchestration, the kind of value ADR-0005 open question 8 says must not be mistaken for a tier (inference).

## Proposed architecture

The sketch below is a research sketch for a future AgentDock-owned loop, not a V1 design. Anything in it that selects a strategy or model automatically is outside V1 (ADR-0005 sections 6 and 8). Limits and permissions are enforced in the Rust backend ([ADR-0004](../decisions/0004-rust-primary-backend.md)), not by prompts.

```text
Task / Session / User-approved budget
              |
       OrchestrationPlanner
       (capability + risk +
        cache + health + cost)
              |
        ExecutionStrategy
        /      |         \
    Single   Cascade    Critique
        \      |         /
        Validate Result & Evidence
              |
       Permission/Commit Gate
              |
    Task Journal & Session Sentinel
```

Component responsibility:

- **AgentAdapter**: external ACP and provider capability detection. If the adapter owns private model requests, label `strategy=external-managed`, never claim AgentDock controlled the internal routing.
- **RoutingPolicy**: choose strategy based on task type, risk, historical correctness, cache boundaries, price, current provider health, available models, privacy constraints, user effort, timeout and budgets. Hard caps are enforced outside the model.
- **ExecutionPlanner**: produce a finite, validated set of legs and allowed tool scopes; include fallback and cancellation semantics before running.
- **Executor**: one owner of write privileges; modifications happen only through permission-controlled tool execution and isolated branches/worktrees.
- **QualityGate**: deterministic build/tests/lint/diff safety checks before optionally spending on a judge or read-only critic. Avoid accepting text-only "tests passed" claims.
- **Critic**: only inspect the proposed patch/evidence; cannot mutate repo or bypass host policy.
- **Advisor**: advisory reasoning in a separate, bounded request; a consultation does not itself authorize file changes.
- **StateStore**: append each leg's started/completed/failed/cancelled state and cost; track model/provider/caches/latency/retries and evidence references.
- **Session Sentinel**: event-driven digest of what changed / why it matters / action requested. Never query an LLM merely because a user opens the bell or refreshes a panel.

### Vocabulary: use ADR-0005, do not add a second set

An earlier draft of this document proposed its own effort names (Economy/Balanced/Quality/Manual) and a `Strategy`/`Effort` type sketch. They are **withdrawn** in favour of the ADR-0005 section 3 fields: `tier`, `model_role`, `orchestration`, `permission`, `min_tier`, `reason`.

If #13 later needs to record which pattern a `parallel` task used, a per-leg record could carry: leg kind (executor, judge, critic, repair, advisor), requested and effective tier, a read-only flag, and token/time bounds. This is a suggestion for #13 and for a future contract change under ADR-0003, **not** a schema, and not a claim that external ACP agents can be forced to use a specific model in their private harness.

## Policy: what ADR-0005 decides and what stays open

Decided by ADR-0005 (pointers only, not restated): default `T-default` (section 2); downgrade only, never automatic upgrade (section 5); V1 is manual selection, and bounded automatic escalation is V2 with a count limit, an event per escalation, a user off-switch, no permission increase and no recursion (section 6); a mid-session change is a cost event (section 7); no hidden routing (section 8); usage and cost display (section 9).

Open research input for #13 (not decided; anything automatic is V2 at the earliest):

- Which deterministic gate (build, tests, lint, diff safety checks) is reliable enough to justify a Cascade-style second attempt.
- Whether a one-pass independent Critique for substantial changes is worth its cost, measured against a single-agent baseline.
- Candidate triggers for an advisor consultation: before an irreversible architecture choice, after repeated verified failure, at completion review.
- **Human-in-the-loop** (unchanged repo rule): changes to default/protected branches, deletion, force push, release, external publication and irreversible actions require explicit approval regardless of strategy.
- **Stop conditions**: budget exceeded, reviewer disagreements unresolved, context insufficient, policy denies a tool, or model/provider unavailable without approved fallback.

### Cache-aware routing

1. Preserve the main model/session for consecutive small turns when cache affinity matters.
2. Delegate isolated read-only evidence gathering to lower-cost agents instead of destroying the main cached prefix with frequent model swaps.
3. Only route a different model on a natural context/complexity boundary or if quality requirements justify the cache penalty.
4. Count cache reads/writes separately **only when reported by the provider**; mark unknown otherwise.

### Workspace changes and fail-safe behavior

The GitHub Fusion docs explicitly warn that discarding a draft **does not necessarily undo its earlier file edits**. AgentDock must not assume multi-model arbitration implies automatic rollback.

For a fully owned orchestration loop: stage candidate changes in a dedicated worktree, keep a diff snapshot, run validation, then require explicit application/approval. Do not auto-reset a user's files. If a candidate fails, leave its isolated worktree intact for human review or safely discard it only with explicit authorization.

For external ACP harnesses: document the limits of isolation and cancellation; do not pretend their internal tool calls can be rolled back.

## Session Sentinel integration

Classify events into **decision required**, **review required**, **in progress**, **completed**, or **informational**; derive priority deterministically. Only significant transitions may request an optional inexpensive two-sentence summary built from redacted/short evidence:

- What has changed since the last note?
- What evidence supports it (check/CI/diff/error)?
- What one decision, if any, must a human make now?

The monitor can show `Execution: Cascade · Efficient draft → Gate → Escalation` as stage **metadata** when AgentDock truly controls those stages, without revealing unstable intermediate drafts or fabricated model routing. Dismiss/snooze affects notification visibility, **not** approval state or task cancellation. No idle polling should invoke the model.

## Evaluation and release gates

Run the same fixed tasks and repository commits using controlled budgets with:

- Baseline: one capable model, no auxiliary model calls.
- Single: an economical model.
- Cascade: economical model + thresholded judge + stronger repair if needed.
- Critique: candidate + independent read-only review + one bounded revision.
- Advisor: economical main model + bounded consultation at predeclared triggers.

Report **verified task resolution**, tests passed, files changed, code quality/risk findings, task-level cost (all legs), wall time, latency, retries, cache hit/write usage, tool approval events, interventions, and model/version/pricing assumptions. Account for rejected drafts and failed attempts. Use paired task sets, a development/holdout split to avoid tuning thresholds to the final benchmark, and enough repetitions for variance.

GitHub's own reported results (in the Artificial Analysis Coding Agent Index, Copilot Fusion Max scored 60, which GitHub describes as within two points of Claude Code with Opus 5.5 Max, at about half the average API cost per task; earlier HydraFusion reports 36–67% lower estimated costs on specified test sets) are **external benchmark observations**, not promises of AgentDock performance. GitHub's [Copilot Fusion documentation](https://docs.github.com/en/copilot/concepts/models/copilot-fusion) also advertises a time-limited 30% discount on model costs for paid Copilot plans (as read on 2026-11-27: "Through December 31, 2026"; promotional terms and end dates can change). That is a GitHub product promotion, not a reusable routing algorithm, and not an input to AgentDock cost estimates.

## Implementation mapping / dependencies

1. **#3 / #6 / #7 / #8**: typed task events, real adapter capability negotiation, event journal and backend permissions, implemented in Rust (ADR-0004) against the ADR-0003 contracts.
2. **#13**: use ADR-0005 as the single source for tiers; start with `single` and manual selection, add a manual advisor next, and consider critique or automatic policies only after measured benefits (V2 for anything automatic). Do not require a new native Harness for the first desktop MVP.
3. **#14**: mock-provider deterministic tests and fixed-repo cost/quality benchmarks for strategy selection.
4. **#15**: monitor displays **verified** orchestration leg status/evidence and only prompts for actionable decisions.
5. A separate ADR should document whether routing belongs in a future owned native Agent loop, or in an external orchestrator supervising ACP agents with limited control.

## Open questions

- Is the first real execution target a new, fully owned model API agent, or externally managed ACP runtimes with explicit capability limits?
- Which provider exposes reliable token/cache usage and price details for cost accounting?
- How to measure cache savings versus switching models mid-conversation?
- Which checks form a reliable cheap gate for each task class?
- What is the smallest permission-safe workflow that supports candidate worktrees and read-only critics?

Nothing in this document asserts that Copilot Fusion/HydraFusion's internal implementation is open-source or that its proprietary model router can be embedded directly.
