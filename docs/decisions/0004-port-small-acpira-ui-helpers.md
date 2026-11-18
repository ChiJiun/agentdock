# ADR-0004: Exception to ADR-0002 — copy three portable MIT UI helpers from Acpira

Date: 2026-11-17 (renumbered and revised 2026-11-18 after the first independent review)
Status: **Proposed — needs the owner's decision.** This ADR is an *exception* to [ADR-0002](0002-source-reuse.md) section 2 (`packages/ui` = Reimplement). If the owner rejects the exception, the three files are replaced by AgentDock-written code and this ADR is withdrawn. ADR number 0003 is reserved for PR #22 (data contracts).
Related: [ADR-0002](0002-source-reuse.md), [sources.md](../sources.md), [Issue #1](https://github.com/ChiJiun/agentdock/issues/1)

## Decision (proposed)

Copy three small utilities from `hotic/acpira` at immutable commit `0481995e3a55abcd707f6808df9d7f396483c3e1`. Each file is identical to upstream except for two added header comment lines (`// Source:` and `// Commit:`).

| Upstream file | Destination | Dependency | Use |
| --- | --- | --- | --- |
| `packages/ui/ui/roving.ts` | `src/vendor/acpira/roving.ts` | React | Keyboard navigation for the inspector tab strip |
| `packages/ui/ui/mergeRefs.ts` | `src/vendor/acpira/mergeRefs.ts` | React | Compose the composer's internal ref and the caller's ref |
| `packages/ui/ui/railStep.ts` | `src/vendor/acpira/railStep.ts` | none | Easing step of the session progress bar |

Author and copyright: `Copyright (c) 2026 hotic` (MIT). The license text is kept byte-for-byte in `third_party/acpira-LICENSE` (verified identical to upstream `LICENSE` at the pinned commit).

## Why ADR-0002 section 2 may not apply to these three files

ADR-0002 decided to *reimplement* `packages/ui` because it is 51k lines bound to `@acpira/shared` (377 imports) and to Acpira's styling. These three files are not part of that coupling: they import only React (or nothing), have no Acpira types, and total about 90 lines. The AGENTS.md question "why is protocol integration insufficient?" does not fit them, since they are UI helpers, not protocol logic; the real question is "copy or write?".

## Why copying may still be the wrong choice (alternative)

Each helper is small and follows a public pattern (the WAI-ARIA authoring practices for roving tabindex, the standard React ref-merging idiom, a one-line exponential easing). Writing them in AgentDock costs little, avoids the third-party notice and the license decision that ADR-0002 says blocks the first migration PR, and removes upstream tracking. **Recommended alternative: replace the three files with AgentDock-written code.** The author of such code would have read the upstream source, which MIT allows; the implementation must still be genuinely different, not renamed.

## Migration template (ADR-0002 acceptance rules, sources.md template)

- Dependency graph: none added. The three files use `react` only, already a direct dependency; no new transitive license.
- Modifications: none to the code; two header lines added to each file. No change notice is needed because the code is unmodified.
- OS support: pure browser code, no OS-specific behavior. Security review: no network, no storage, no `eval`; DOM access is limited to reading `role`, `aria-*` attributes and focusing elements.
- Tests: `railStep.test.ts` is **written by AgentDock** (3 cases), not the upstream test. The upstream tests `packages/ui/test/railStep.test.ts` and `packages/ui/test/mergeRefs.test.ts` were **not** copied or run. `roving.ts` and `mergeRefs.ts` have no direct test in this repository.
- Upstream tracking: owner is the repository owner; before each release compare the three files with `gh api repos/hotic/acpira/compare/0481995e3a55abcd707f6808df9d7f396483c3e1...main`.
- Notices: `THIRD_PARTY_NOTICES.md` lists the three files and the MIT notice.
- AgentDock's own license is **not decided**; the owner must decide before this exception is accepted (ADR-0002 section 5).

## Scope and caveats

- This PR supplies a React/Vite workbench prototype with explicit simulated sessions. There is no ACP adapter, Rust/Tauri binary, persisted backend session or privileged command execution.
- UI components and CSS around the helpers are original AgentDock code.
- No Forge/AGPL source and no Claude Desktop proprietary assets are copied.

## Reproducible checks

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Rust/Cargo is not required for this PR; the Tauri build is tracked in Issue #4.
