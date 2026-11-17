# ADR-0002: Extract only portable MIT UI helpers from Acpira

Date: 2026-11-17
Status: **Implemented (frontend preview), pending Rust/Tauri integration**

## Decision

Import three small utilities from `hotic/acpira` at immutable commit
`0481995e3a55abcd707f6808df9d7f396483c3e1`:

| Imported upstream file | Destination | Dependency | Use |
| --- | --- | --- | --- |
| `packages/ui/ui/roving.ts` | `src/vendor/acpira/roving.ts` | React | Accessible keyboard navigation for inspector tabs |
| `packages/ui/ui/mergeRefs.ts` | `src/vendor/acpira/mergeRefs.ts` | React | Compose input focus + caller ref wiring |
| `packages/ui/ui/railStep.ts` | `src/vendor/acpira/railStep.ts` | none | Animated session progress rail |

The only changes to upstream sources are header comments documenting provenance. Their MIT license is retained verbatim in `third_party/acpira-LICENSE`.

## Why not wholesale import the Acpira host or UI?

The Acpira `rust/crates/acpira-host/Cargo.toml` depends on several internal crates, including `acpira-shared`, `acpira-rpc`, `acpira-agent`, `acpira-desktop` and `acpira-gateway`, plus a large native dependency graph. Its IPC, desktop process and runtime lifecycles need a deeper portability review.

The upstream `packages/ui` package depends on custom CSS tokens, shared transcript schemas, runtime bridge, and multiple UI packages. Transplanting it wholesale would prematurely couple AgentDock to a different product's data model and styling. The three selected helpers have narrow contracts and can be tested independently.

For ACP, evaluate [official ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk) before deciding whether any Acpira host logic is needed.

## Scope and caveats

- This PR supplies a **React/Vite workbench prototype** with explicit simulated sessions.
- There is no real ACP adapter, Rust Tauri binary, persisted backend session, or privileged command execution yet.
- UI components and CSS around the helpers are original AgentDock code.
- This is a **subset** of the source audit in Issue #1, not completion of the full audit.
- No Forge/AGPL source and no Claude Desktop proprietary assets are copied.

## Reproducible checks

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The VM currently lacks Rust/Cargo so Tauri build verification is deferred to the separately tracked Windows scaffold Issue #4.
