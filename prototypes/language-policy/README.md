# Language Profile resolver: specification reference prototype

> **Specification reference prototype, not product code.** It turns the precedence rules of `docs/architecture/language-policy.md` into runnable examples. It does not ship with AgentDock. The product implementation is Rust ([ADR-0004](../../docs/decisions/0004-rust-primary-backend.md)) and needs its own task packet, which has not been written yet; the frontend preview in `src/i18n/` (PR #24) is a separate TypeScript draft.

This prototype resolves a user's preferred **whole-workflow language** across `Global → Project → Session → Task`. It first looks for an explicit `outputs.<stage>` or (for prose artifacts) `artifactLocale` in every scope, nearest first, and only then falls back to the nearest `workflowLocale`, so a nearer `workflowLocale` never overrides a farther explicit setting. With nothing configured the result is `zh-TW`. It also offers an independent language overlay, preserves the raw bytes of an English Skill, rejects unsupported locale tags that resolution reaches instead of substituting them, and reports adapter language capability as `owned` / `confirmed` / `best-effort` / `unsupported`. It is **not integrated with a real Harness**.

Run using Node 22+ without installing additional dependencies:

```bash
node --test prototypes/language-policy/resolve.test.mjs
```

Example: `examples/language-profiles/zh-TW.json` sets UI, plans, reviews, Issue/PR, session summaries and notifications to Traditional Chinese, but leaves code comments untouched and commit messages in English. Change these individually as needed.

See `docs/architecture/language-policy.md` for actual runtime integration requirements, source safety, UI, per-Adapter capability handling, tests and limitations.
