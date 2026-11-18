# Third-party notices

AgentDock's own license is not decided yet (see [ADR-0002](docs/decisions/0002-source-reuse.md) section 5). This file lists source files copied from other projects. Provenance rules are in [docs/sources.md](docs/sources.md).

## hotic/acpira (MIT)

- Source: https://github.com/hotic/acpira at commit `0481995e3a55abcd707f6808df9d7f396483c3e1`
- Copyright (c) 2026 hotic
- License text: [third_party/acpira-LICENSE](third_party/acpira-LICENSE)
- Decision record: [ADR-0004](docs/decisions/0004-port-small-acpira-ui-helpers.md) (proposed exception to ADR-0002)

| Upstream path | AgentDock path | Changes |
| --- | --- | --- |
| `packages/ui/ui/roving.ts` | `src/vendor/acpira/roving.ts` | Two header comment lines added; code unmodified |
| `packages/ui/ui/mergeRefs.ts` | `src/vendor/acpira/mergeRefs.ts` | Two header comment lines added; code unmodified |
| `packages/ui/ui/railStep.ts` | `src/vendor/acpira/railStep.ts` | Two header comment lines added; code unmodified |
