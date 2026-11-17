# Language Profile resolver proof of concept

This prototype resolves a user's preferred **whole-workflow language** across `Global → Project → Session → Task`, applies `outputs.<stage>` → `artifactLocale` (prose artifacts only) → `workflowLocale` within each scope, offers an independent language overlay, preserves the raw bytes of an English Skill, rejects unsupported locale tags instead of substituting them, and reports adapter language capability as `owned` / `confirmed` / `best-effort` / `unsupported`. It is **not integrated with a real Harness**.

Run using Node 22+ without installing additional dependencies:

```bash
node --test prototypes/language-policy/resolve.test.mjs
```

Example: `examples/language-profiles/zh-TW.json` sets UI, plans, reviews, Issue/PR, session summaries and notifications to Traditional Chinese, but leaves code comments untouched and commit messages in English. Change these individually as needed.

See `docs/architecture/language-policy.md` for actual runtime integration requirements, source safety, UI, per-Adapter capability handling, tests and limitations.
