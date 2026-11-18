# Implementation slice: Language Settings + localized Session Sentinel

Status: **Implemented and locally verified in React/Vite preview only**
Tracks: [Issue #18](https://github.com/ChiJiun/agentdock/issues/18) · [Issue #15](https://github.com/ChiJiun/agentdock/issues/15)
Based on UI foundation [PR #16](https://github.com/ChiJiun/agentdock/pull/16)
Related research [PR #19](https://github.com/ChiJiun/agentdock/pull/19)

## Working features

- `zh-TW` UI by default; switch to `en-US` through the globe icon in the Desktop preview header.
- Editable global UI / workflow / generated-prose language, plus project and session workflow / generated-prose overrides.
- Precedence: specific task > session > project > global, implemented in `src/i18n/language.ts`.
- Preference persistence in browser `localStorage` with validation and safe fallback; **no secret keys or full prompts stored**.
- Strongly typed translation dictionaries for UI and navigation, Session Sentinel statuses, decision explanations, Quick Switcher, composer and inspector.
- Session Sentinel applies **effective session-summary language** per session, without replaying raw tool output or triggering translation/model calls.
- Separate `compileLanguageOverlay` and `skillContext` for host-owned output language instructions, preserving original Skill bytes. Runtime integration is explicitly **not active** yet.
- Inspector shows the effective workflow language and accurately reports the absence of a real ACP language-control capability.

## Boundaries

This is a browser-only prototype, not a real Rust/Tauri/ACP client:

- No external Agent receives the language overlay.
- No bundled or rewritten `SKILL.md`; no claim to replace Claude Code / Codex / Copilot system prompts.
- No real Session persistence: only language preferences are saved. Demo session activity remains in memory.
- No live code execution, terminal access, Git changes, approvals, CI access or remote VM operations.
- The simulated source diff, code and raw evidence are never translated. User-typed messages are never translated; the built-in demo timeline entries (including the sample user message) are static UI strings and do follow the UI language.
- `en-US` or `zh-TW` settings do not authorize actions or alter tool permissions.

## Reproduction

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

Open the React preview and select the **globe icon**. Change **Interface language**, select an override scope, and change **Workflow language**. Open the bell to verify localized decision notices. Open Inspector → Details to see the effective workflow language and unavailable adapter status.

## Next integration tasks

1. Persist profile/snapshot through the Rust event store (#7), rather than only browser LocalStorage.
2. Add ACP adapter capability negotiation (#6) and send language instructions **only** over supported channels.
3. Connect trusted role prompts and Skill Overlays to an owned host Context Composer (#18); no raw source rewrite.
4. Feed Session Sentinel from trusted Task/CI/Approval events, adding locale-aware templates, dedup and event IDs (#15).
5. Add true bilingual GitHub Issue/PR and CI narrative output via controlled Workflow Engine (#10).

## Validation evidence

Local UI tests verify bilingual switching and settings persistence, monitor navigation, scoped workflow language changes, vendor capability honesty, source/Skill preservation, and dictionary key parity. They **do not** certify a fully localized external Harness. GitHub Actions workflow setup remains blocked by current GH credential scope.
