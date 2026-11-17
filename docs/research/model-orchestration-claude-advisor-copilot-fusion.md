# Research: Claude Code Advisor vs GitHub Copilot Fusion for AgentDock

Date: 2026-11-17
Status: Research and proposed design (not implemented)
Related: #6 ACP adapter · #7 event store · #8 policy · #13 cost/Advisor · #14 benchmarks · #15 Session Sentinel

## Executive decision

**Build a configurable, evidence-driven orchestration layer over an existing agent runtime, not a copy of Copilot Fusion.** AgentDock should eventually support:

1. `Single` — one model/agent handles the request.
2. `Cascade` — a cheaper executor proposes work; a quality gate either accepts it or escalates/repairs.
3. `Critique` — a drafting executor produces a candidate, independent read-only reviewers inspect it, and the executor revises if necessary.
4. `Advisor` — a consultative escalation mode for major decisions, repeated failures, or completion review; **not equivalent to a cascade or a replacement executor**.

These are strategies that AgentDock can configure and benchmark **when it owns the relevant model calls and execution loop**. For Claude Code, Codex, Octomind, GitHub Copilot, and other external ACP-backed harnesses, keep their own model routing and private context untouched. Use only capabilities their adapters actually expose.

## Official references and what they establish

| Reference | Verified finding | AgentDock consequence |
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

**Single** is the baseline, not a failure of orchestration. More reviewers on every prompt can cost more and add latency. Copilot Fusion's Standard/High/Max correspond to a *quality/cost effort intent*, not user-selectable raw model mappings. AgentDock can expose comparable **Efficiency / Balanced / Thorough** policies without using GitHub's trademarked labels in the product.

## Proposed architecture

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

### Suggested typed interfaces (illustrative, not committed code)

```ts
type Strategy = "single" | "cascade" | "critique" | "advisor" | "external-managed";
type Effort = "efficiency" | "balanced" | "thorough";

type RoutingInput = {
  taskId: string;
  effort: Effort;
  capabilities: string[];
  risk: "low" | "medium" | "high";
  sessionCacheAffinity?: string;
  apiBudgetUsd?: number;
  allowedProviders: string[];
};

type PlannedLeg = {
  kind: "executor" | "judge" | "critic" | "repair" | "advisor";
  providerId: string;
  modelId: string;
  readOnly: boolean;
  maxTokens: number;
  timeoutMs: number;
};
```

These are intent contracts, **not** a claim that external ACP agents can be forced to use a specific model in their private harness.

## Default policy proposal (test before enabling)

- **Efficiency**: Single unless a deterministic gate fails or the user requests review. Prefer local/deterministic tools for search/status.
- **Balanced**: Single first; Cascade if a cheap executor has a reproducible uncertain result; a one-pass independent Critique for substantial changes when evidence warrants it.
- **Thorough**: Evaluate critique or advisory escalation for high-risk code; bounded independent review plus required tests, never unlimited parallel judges.
- **Human-in-the-loop**: changes to default/protected branches, deletion, force push, release, external publication, irreversible actions require explicit approval regardless of strategy.
- **Stop**: budget exceeded, reviewer disagreements unresolved, context is insufficient, policy denies a tool, or model/provider unavailable without approved fallback.

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

Official GitHub results (Fusion Max score 60 vs Claude Code Opus 5.5 Max 62, around half average API cost in their evaluated index; earlier HydraFusion reports 36–67% lower estimated costs on specified test sets) are **external benchmark observations**, not promises of AgentDock performance. Copilot Fusion's temporary billing discount through 2026-11-30 is a GitHub product promotion, not a reusable routing algorithm.

## Implementation mapping / dependencies

1. **#3 / #6 / #7 / #8**: typed task events, real adapter capability negotiation, event journal and backend permissions.
2. **#13**: add observational routing; implement `single` before `cascade`, manual advisor next, critique and automatic decision policies only after measured benefits. Do not require a new native Harness for the first desktop MVP.
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
