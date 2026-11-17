# ADR-0001: Independent workbench with ACP adapters

Date: 2026-11-17
Status: Accepted for planning; implementation-dependent details provisional

## Context

The user already maintains an experimental Acpira fork and wants a Claude Code Desktop-like experience tailored to their development workflow. Acpira provides valuable UI/ACP groundwork, but its app-specific architecture may constrain a long-term independent product. Other Rust runtimes specialize in model routing, persistent tasks or multi-agent architecture.

## Decision

Create **AgentDock** as a new private repository, with a distinct product identity and reusable orchestration layer.

- Adopt a Rust + Tauri + React architecture.
- Reference or selectively import documented MIT/Apache modules only after provenance and compatibility checks.
- Prefer ACP integration with Claude Code/Codex/Octomind over source copying.
- Start by reusing *requirements* and *test scenarios* from existing fork PRs, not assuming those plugins are production ready.
- Keep internal source-code migration as a separate tracked decision.
- Reconsider repository visibility and top-level license before public code distribution.
- Do not implement a native agent loop until existing ACP runtimes have been evaluated.

## Alternatives considered

1. Continue Acpira fork only: quicker UI start, harder to establish independent product/lifecycle.
2. Fork Octomind only: runtime aligned, but must build most desktop/session UX.
3. Copy Acpira + Octomind + Forge into a monorepo: high coupling, license risk and dual maintenance.
4. New repo using protocols and minimal selected modules: chosen for control and lower long-term coupling.

## Consequences

- Slower initial delivery than a cosmetic fork.
- Clearer domain model, UX and attribution.
- Need to implement/choose a tested ACP host.
- Risk of overengineering: limit MVP to a vertical developer workflow.
