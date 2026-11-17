# Upstream reference and source migration inventory

Snapshot: 2026-11-17. Repository HEADs and licenses were checked from GitHub API; paths exist at the indicated repository revisions. **A directory existing does not prove independent embeddability or security.** Perform a code-level review before migration.

## Source strategy

1. **Use through ACP before copying code.** Claude Code, Codex and Octomind remain independent runtimes; no vendor-source bundling by default.
2. **Adapt only modules with proven boundaries.** For candidate Acpira modules, verify exact dependencies, platform support, tests, license and security obligations.
3. **Clean-room design for protected UI.** Claude Code Desktop is the UX inspiration for layout/interaction *only*; do not copy Anthropic assets, copywriting, or proprietary implementation.
4. **Track provenance.** Every transplanted file requires source repository, immutable commit, path, license, derivative changes, upstream update policy and test coverage.
5. **Prefer one owner for each concern.** Do not combine different agent loops into a massive core.

## Exact repository inventory (GitHub snapshot)

| Repository | Snapshot HEAD | License | Intended role |
| --- | --- | --- | --- |
| [Acpira upstream](https://github.com/hotic/acpira) | `0481995e3a55` | MIT | Main structural reference, potential isolated modules |
| [ChiJiun/acpira fork](https://github.com/ChiJiun/acpira) | `c03be9e725dc` | MIT | Existing experimental PRs and workflows |
| [Octomind](https://github.com/Muvon/octomind) | `7d729126ade5` | Apache-2.0 | ACP external runtime, supervisor/context reference |
| [Goose](https://github.com/aaif-goose/goose) | `58fa06b18356` | Apache-2.0 | Provider, SDK, MCP, testing and extension architecture |
| [Forge](https://github.com/Adulari/forge) | `45e984c927d0` | AGPL-3.0 | Research cost routing, queue and fallback; **do not copy without legal review** |
| [Octos](https://github.com/octos-org/octos) | `d1863004f8c0` | Apache-2.0 | Remote/daemon scheduling and durable workflow reference |
| [Aether](https://github.com/contextbridge/aether) | `b847dc863bed` | MIT | Embeddable Rust agent/context modules reference |
| [ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk) | `6a4a95cabed1` | Apache-2.0 | Preferred protocol implementation candidate |
| [Copilot SDK (transitioning to Microsoft)](https://github.com/github/copilot-sdk) | `bc4f9a19d190` (Microsoft org API, 2026-11-17) | MIT SDK code | **Alternate, SDK-managed Copilot Runtime**; vendor runtime artifact licensing/redistribution must be reviewed separately |

These are short commit prefixes for orientation; pin and record **full SHA** when actually vendoring.

## Migration candidate matrix

| Rank | Source exact path | Investigate / possible migration | Decision before implementation |
| --- | --- | --- | --- |
| 1 | [Acpira `packages/ui/`](https://github.com/hotic/acpira/tree/main/packages/ui) | Sidebar/session timeline, UI component patterns | Borrow patterns or extract isolated MIT modules? Avoid wholesale front-end copy |
| 1 | [Acpira `apps/desktop/`](https://github.com/hotic/acpira/tree/main/apps/desktop) | Tauri window lifecycle, installer/configuration | Reference first; verify platform build and plugin dependencies |
| 1 | [Acpira `rust/crates/acpira-host/`](https://github.com/hotic/acpira/tree/main/rust/crates/acpira-host) | ACP host and agent process lifecycle | Compare to official ACP Rust SDK; migrate only if simpler and safer |
| 1 | [Acpira `rust/crates/acpira-agent/`](https://github.com/hotic/acpira/tree/main/rust/crates/acpira-agent) | Built-in agent loop as optional later implementation | **Do not bring into MVP core** |
| 2 | [Acpira `rust/crates/acpira-shared/`](https://github.com/hotic/acpira/tree/main/rust/crates/acpira-shared) | Domain types / API ideas | Avoid importing unrelated or unstable internal types |
| 2 | [Acpira `rust/crates/acpira-rpc/`](https://github.com/hotic/acpira/tree/main/rust/crates/acpira-rpc) | Typed IPC / transport architecture | Inspect dependencies and compatibility with local command API |
| 2 | [Acpira `rust/crates/acpira-gateway/`](https://github.com/hotic/acpira/tree/main/rust/crates/acpira-gateway) | Gateway and remote connectivity patterns | Research later; independent remote worker preferable first |
| 1 | [Fork PR #6](https://github.com/ChiJiun/acpira/pull/6) | `approval-rules` policy behavior | Port *requirements and tests* first; enforcement belongs in Rust backend |
| 1 | [Fork PR #5](https://github.com/ChiJiun/acpira/pull/5) | `worktree-sessions` workflows | Port use cases; retest Windows/WSL path isolation before copying |
| 2 | [Fork PR #4](https://github.com/ChiJiun/acpira/pull/4) | `pr-loop` state machine | Use as requirements; don't import an unverified automation loop |
| 2 | [Fork PR #2](https://github.com/ChiJiun/acpira/pull/2) | `turn-report` end-of-turn evidence | Integrate events and task summary rather than prompt-only completion |
| 1 | [ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk) | Official ACP client implementation | Evaluate as dependency before copying host code |
| 2 | [Octomind `src/acp/`](https://github.com/Muvon/octomind/tree/master/src/acp) | External ACP interface behavior | Integration test, **not** source migration |
| 2 | [Octomind `src/supervisor/`](https://github.com/Muvon/octomind/tree/master/src/supervisor) | Advisor/supervisor research | Independent runtime first |
| 2 | [Octomind `src/session/`](https://github.com/Muvon/octomind/tree/master/src/session) | Session/context persistence ideas | Research separate ownership of state |
| 2 | [Goose `crates/goose-context-management/`](https://github.com/aaif-goose/goose/tree/main/crates/goose-context-management) | Context compaction design | Research; avoid duplicating internal model stack |
| 2 | [Goose `crates/goose-providers/`](https://github.com/aaif-goose/goose/tree/main/crates/goose-providers) | Provider capability design | Research future native agent only |
| 2 | [Octos `crates/octos-workflows/`](https://github.com/octos-org/octos/tree/main/crates/octos-workflows) | Workflow and scheduling patterns | Remote/post-MVP research |
| 2 | [Octos `crates/octos-store/`](https://github.com/octos-org/octos/tree/main/crates/octos-store) | Durable store design | Compare retention/consistency models |
| 2 | [Aether `crates/aether-core/`](https://github.com/contextbridge/aether/tree/main/crates/aether-core) | Modular agent architecture | Consider only if native harness needed |
| 3 | [Forge `crates/forge-core/`](https://github.com/Adulari/forge/tree/main/crates/forge-core) | Read for routing/queue inspiration | **Research only** due AGPL |
| 3 | [Forge `crates/forge-provider/`](https://github.com/Adulari/forge/tree/main/crates/forge-provider) | Provider fallback ideas | **Research only** due AGPL |

## Additional research: Copilot Fusion and SDK

The [Copilot Fusion research](research/copilot-fusion.md) compares Single, Cascade and Critique routing, vendor-managed Standard/High/Max tiers, cache-aware escalation and the public Rust Copilot SDK. This is a candidate **external/SDK-backed harness**, not an Acpira component and not proof that the proprietary Rust Copilot runtime can be copied or modified. The SDK has a separately managed/bundled runtime binary whose redistribution conditions must be checked before packaging.

## License and compatibility guardrails

- MIT: retain the upstream copyright and license notices for copied material.
- Apache-2.0: retain applicable license, attribution/NOTICE and document modifications.
- AGPL-3.0: may carry reciprocal source-disclosure obligations, including some network-use cases; **do not copy** into an independently licensed codebase without deliberate licensing review.
- Mixing permissible licenses still requires file-level tracking, copyright attribution and possible patent/NOTICE compliance.
- Screenshots, icons, proprietary brand names and marketing artwork are not automatically open licensed because code is visible.
- A source module's internal imports may make migration substantially more expensive than protocol integration.
- The license for the new repository is a separate owner decision. Avoid assuming every module can be relicensed MIT.

## Required source migration PR template

- Purpose and alternatives (ACP dependency, reimplementation, direct reuse)
- Origin URL + **full immutable commit SHA** + exact source paths
- License and NOTICE impact; copyright lines retained
- Dependency graph and estimated vendored footprint
- Modifications and rationale
- OS support and security review
- Tests (unit/integration/e2e) and CI result
- Upstream tracking and update owner

## Model orchestration research references

- [GitHub Copilot Fusion (GA, 2026-10-28)](https://github.blog/changelog/2026-10-28-route-and-orchestrate-models-with-github-copilot-fusion/) — three dynamic execution patterns; this is not a standalone open-source coding harness.
- [Official Copilot Fusion runtime and cost documentation](https://docs.github.com/en/copilot/concepts/models/copilot-fusion) — per-prompt workflow routing, cache-aware switching, scoped reviewer context, provider health and per-leg costs.
- [GitHub Project HydraFusion technical article](https://github.blog/ai-and-ml/project-hydrafusion-frontier-quality-via-multi-model-orchestration/) — bounded legs, independent read-only critique, no patch on failed validation, and complete cost attribution.
- [Claude Code Advisor](https://code.claude.com/docs/en/advisor) — experimental server-side consultation with full transcript; separate from multi-model orchestration.
- [Claude Code custom subagents](https://code.claude.com/docs/en/sub-agents) — scoped context, independent model/tool restrictions and usage accounting.
- [AgentDock research synthesis and proposed design](research/model-orchestration-claude-advisor-copilot-fusion.md).

These are design references, **not source-code migration candidates**. Do not copy GitHub/Anthropic proprietary internals; use public APIs and ACP, preserving each external runtime's authority.

## UX and protocol references

- [Anthropic: Redesigning Claude Code on desktop](https://claude.com/resources/articles/claude-code-desktop-redesign) (interaction reference; not an implementation source)
- [ACP Overview](https://agentclientprotocol.com/)
- [ACP stable v1 docs](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP v2 draft announcement](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/announcements/acp-v2-draft.mdx)
- [Tauri 2 Capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri 2 Permissions](https://v2.tauri.app/security/permissions/)
- [Acpira Harness research issue](https://github.com/ChiJiun/acpira/issues/10)
