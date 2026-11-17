# AgentDock project-specific agent instructions

- Read `README.md`, `docs/PRD.md`, `docs/architecture.md`, `docs/sources.md`, and the relevant open Issue before changing code.
- This is a **new independent product**, not an automatic rewrite of the entire Acpira fork.
- Prefer a minimal working vertical slice, with explicit acceptance tests and rollback.
- Prioritize Windows usability, Rust/Tauri process safety, ACP compatibility and event-sourced observability.
- **Do not copy** third-party source files without exact source commit/path, license/NOTICE review, dependency audit, and an Issue/PR explaining why protocol integration is insufficient.
- Never copy Claude/Anthropic proprietary source or brand assets. UX may be inspired by interaction patterns.
- Do not import AGPL-3.0 Forge source or adapt it into project files without explicit licensing decision.
- Respect ACP external agent runtime ownership: no fake subscription quota metrics, no hidden model or tool interception.
- For language-sensitive tasks, follow `docs/architecture/end-to-end-language-policy.md`: support `zh-TW` and `en-US`, including user-facing plans/reviews/Skill explanations when possible, but never rewrite upstream Skill/AGENTS.md/CLAUDE.md source, raw logs, code or protected instructions just to localize.
- Privileged tool operations and scope restrictions belong in Rust/backend policy; do not rely only on Prompt or frontend control.
- No automatic merge, destructive Git operations, deployment or production side effects unless explicitly approved.
- Do not read or print `.env`, credentials, SSH private keys or access tokens.
- Working in an environment with other services: no system package upgrades, systemctl, firewall changes or unrelated container operations.
- After editing, inspect diff and run targeted tests/build/lint. Clearly distinguish implemented vs tested.
- Prefer feature branches + PRs; main should remain a stable documentation baseline.
