# Research: GitHub Copilot Fusion, HydraFusion and Rust Copilot SDK

Status: architecture reference, **not implemented**
Researched: 2026-11-17
Related AgentDock issues: [#1](https://github.com/ChiJiun/agentdock/issues/1), [#6](https://github.com/ChiJiun/agentdock/issues/6), [#13](https://github.com/ChiJiun/agentdock/issues/13), [#15](https://github.com/ChiJiun/agentdock/issues/15)

## Executive summary

Copilot Fusion is more than automatic model selection: it chooses an execution workflow per request. It is a useful **design reference** for AgentDock's planned cost-aware orchestration, but it also suggests a **real integration candidate**: the official Copilot SDK provides a Rust client that can select model `fusion` and its `standard/high/max` tiers.

Keep three options distinct:

1. **ACP external agents** — Claude Code, Codex, Octomind and compatible runtimes keep their own execution logic.
2. **Copilot SDK-backed runtime** — a Rust SDK controls the Copilot runtime via documented APIs; *the SDK being MIT-licensed does not imply that the bundled Copilot runtime's implementation/source or redistribution rights are MIT*.
3. **Future owned orchestrator/native agent** — only this option can reliably enforce custom provider-agnostic per-leg model routing, judgments, caching and budgets across external API models.

Do not copy a proprietary model-router or attempt to intercept opaque internal calls in other harnesses.

## What GitHub actually announced

GitHub Copilot Fusion was announced as generally available on **October 28, 2026**, combining Project HydraFusion's multi-model orchestration with auto model selection. GitHub describes three per-prompt execution patterns:

| Pattern | Mechanism | Potential AgentDock use |
| --- | --- | --- |
| **Single** | One selected model performs the request. | Simple edits, document lookup and straightforward coding. |
| **Cascade** | Lower-cost solver first; a quality gate decides whether to accept or escalate to a stronger solver. | Complex bugfixes with an inexpensive initial attempt and evidence-based escalation. |
| **Critique** | Solver drafts, reviewers independently critique, solver revises. | Design reviews, independent PR reviews and safety-sensitive changes. |

Fusion effort tiers are **Standard, High, Max**. They are policy/quality choices, *not promises that exactly one named model is always used*. Standard emphasizes everyday efficiency. High and Max may take more time and use more model calls.

GitHub's product documentation also says:
- Routing accounts for model availability/health and selects changes near natural **cache boundaries**.
- The main conversation stays on the same model when possible; critics receive only necessary evidence/context.
- Fusion orchestration is distinct from launching subagents.
- Intermediate drafts can be discarded **without automatically undoing already-applied repository edits**. This is a central reason AgentDock needs worktrees, read-only reviewers and a safe commit/apply boundary.
- Additional model calls can cost more; Fusion does **not guarantee lower cost** for every task.

GitHub's October 28 release cites a roughly half-cost / half-token and 40%-faster comparison for a particular Coding Agent Index result. Treat it as **vendor-reported, benchmark-specific**, not an expected improvement for AgentDock.

Sources:
- [Official release, 2026-10-28](https://github.blog/changelog/2026-10-28-route-and-orchestrate-models-with-github-copilot-fusion/)
- [Official Copilot Fusion concepts](https://docs.github.com/en/copilot/concepts/models/copilot-fusion)
- [HydraFusion research blog, 2026-09-04](https://github.blog/ai-and-ml/project-hydrafusion-frontier-quality-via-multi-model-orchestration/)

## Fusion compared with Claude Code Advisor

| Axis | Claude Code Advisor (reference) | Copilot Fusion (reference) | AgentDock design |
| --- | --- | --- | --- |
| Primary mechanism | Consult a stronger advisor on important decisions. | Route model **and** workflow per request. | Mode-based execution policies plus explicit advisor escalation. |
| Lightweight tasks | Primary model handles most work. | Single. | Single with deterministic tools where possible. |
| Uncertain quality | Consult advisor selectively. | Cascade quality gate then stronger solver. | Configurable evidence gate, transparent escalation reason. |
| Independent review | Explicit reviewer/subagent usage. | Critique with independent reviewers and solver revision. | Separate read-only context and trusted test evidence. |
| Control | Internal vendor runtime behavior. | Internal Copilot runtime routing. | Workbench can control only **its own** policies and supported adapter capabilities. |
| Cost transparency | Model/provider dependent. | Constituent model billing and possible multi-call overhead. | Track each leg, retries, review, cache and cost provenance. |

Both inspirations point to **escalation when justified**, not "always call the most expensive model before and after everything".

## Rust integration candidate: Microsoft / GitHub Copilot SDK

GitHub's Copilot SDK reached GA in June 2026, including a Rust SDK. In October 2026 GitHub announced its transition to **Microsoft Copilot SDK**. The SDK's Rust client exposes an officially documented way to select Fusion:

- Choose model **`"fusion"`**.
- Set `FusionTier::Standard`, `FusionTier::High` or `FusionTier::Max` using `CapiSessionOptions::with_fusion_tier` during create/resume.
- For a running session use `SetModelOptions::with_fusion_tier` or `session.set_fusion_tier`, subject to the runtime's model-change semantics.
- Legacy HydraFusion/auto-tier identifiers are deprecated; prefer the current Fusion names.

**Integration boundaries:**
- The public SDK code is MIT-licensed, but the Copilot runtime binary is a separately supplied/bundled dependency. Review licensing, redistribution terms, supported OS/architecture, packaged size, and authentication before shipping it in AgentDock.
- The Rust SDK defaults to bundled runtime artifacts; alternate unbundled modes can require explicit runtime provisioning. Do not assume it can be embedded as readable/editable Rust source.
- Confirm account and entitlement constraints in a sandbox, and distinguish CLI subscription credits from separately billed API or managed-Foundry charges.
- When using Copilot Fusion, leave its internal routing to the Copilot runtime. AgentDock may expose tier, runtime health, task logs and externally supported usage metrics, **not fabricated per-step controls**.
- Do not assume external ACP session APIs and Copilot SDK sessions are interchangeable. Create an `AgentAdapter` abstraction that models shared capabilities and preserves different backend ownership.

Sources:
- [GitHub Copilot SDK repository](https://github.com/github/copilot-sdk) (migrating to Microsoft)
- [Rust SDK README / Fusion API](https://github.com/github/copilot-sdk/blob/main/rust/README.md)
- [SDK Fusion session semantics](https://github.com/github/copilot-sdk/blob/main/docs/features/session-persistence.md#copilot-fusion-names)
- [SDK GA announcement](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/)
- [Microsoft Copilot harness announcement](https://blogs.microsoft.com/blog/2026/10/28/introducing-the-microsoft-copilot-harness-unlocking-the-potential-of-truly-multi-model-agentic-work/)

## AgentDock design proposal

### UX: user selects policy, not raw implementation details

Proposed options (these are **AgentDock-owned** design concepts, not GitHub's tier names):

- **Economy** — single inexpensive model or direct tool; fail explicitly if quality gate cannot be met.
- **Balanced** — Single initially; allow bounded Cascade where evidence indicates uncertainty.
- **Quality** — selectively use independent Critique and stronger models, within budget.
- **Manual** — user fixes model/provider, review and escalation decisions.
- **Copilot Fusion** (if SDK-backed adapter is installed) — expose the vendor's actual Standard/High/Max choices, labelled **provider-managed**, with no imitation of custom routing controls.

Expose to Session Sentinel: `execution_pattern`, `phase`, `needs_review`, `approval_request`, `evidence_links`, `estimated_cost` (if available), `source_of_estimate`, `last_update_at`. All status polling should use stored events, not issue additional model requests.

### Execution policies

- Read-only critique contexts; reviewers should not mutate the same worktree.
- Validate available models, provider permissions, concurrency, per-leg timeouts and costs **before** executing.
- Use bounded evidence packages for critics; keep cache-friendly stable prompt prefixes.
- Separate stage/apply: prefer isolated worktree and controlled apply/commit points, with explicit human approval for push/PR/merge.
- Do not auto-replay side effects after a failed or discarded draft. Existing file edits may survive a model retry.
- Record full costs across draft, critique, revision, escalation, retry and fallback, plus task success quality.
- Trigger expensive review from risk, scope, prior failure and concrete test results rather than reflexive advisor calls.
- Treat providers lacking usage data as `unknown`. Never infer remaining subscription quota from tokens.

### Benchmark plan

Compare (1) single model, (2) bounded Cascade, (3) bounded Critique, (4) Copilot Fusion where authorized. Keep task fixtures, git revisions, tool permissions, provider access and retry limits fixed. Record success, regressions, test failures, latency, token/cache metadata, task-level spend and human intervention. Measure with a local mock first, real models only after explicit opt-in and budget approval.

## Next implementation experiments

1. **SDK feasibility spike (separate Issue):** validate Rust SDK compile, official Fusion configuration, local CLI/runtime lifecycle, auth/permissions, and clearly observable events in a throwaway repository. This is an adapter experiment, not code vendoring.
2. **Routing-policy design:** define typed `Single | Cascade | Critique` and capability negotiation; defer actual multi-model execution until session store/policy are in place.
3. **Session Sentinel:** surface meaningful routing transitions and genuine user decisions without prompting an LLM during UI refresh.
4. **Source/provenance:** log exact SDK versions/runtime artifact terms before making a redistribution decision.

**Status:** research and specifications only; none of the above Copilot SDK functionality has been compiled or integrated into AgentDock.
