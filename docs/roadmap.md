# Delivery Roadmap & Validation

Status: proposal; not a promise of completion dates.

## Milestones

| Phase | Scope | Exit gate |
| --- | --- | --- |
| M0 — Sources and decisions | Identify sources, licenses, ACP SDK choice, UX reference, threat model | ADR, provenance inventory, clear exclusions |
| M1 — Desktop skeleton | Rust workspace/Tauri 2 + React, Windows dev build, CI | App starts, smoke test, lint/build CI |
| M2 — Usable sessions | Project management, typed ACP host, 2 adapters, streaming, persistence, approvals | Same test task works through 2 agents and safe cancel |
| M2.5 — Self-hosting Alpha | Windows 可安裝的真實 Agent 工作台、兩個獨立 Worktree、Diff/測試/PR、受控核准、持久化 | [#51](https://github.com/ChiJiun/agentdock/issues/51) 的 v0.1.0-alpha Gate：10 個真實任務無資料遺失；可用 AgentDock 開發 AgentDock |
| M3 — Coding workflow | Git diff/worktree and tests; GitHub Issue→PR review→CI | Isolated parallel worktree test + PR demonstration |
| M4 — Reliable remote | SSH worker, durable event log, reconnect, bounded concurrency | Disconnect/reconnect and no duplicate side effects |
| M5 — Cost/Advisor | Role routing, manual advisor, budgets, benchmarks | Cost and quality evaluated against baseline |

## Initial work order

1. License/provenance / precise upstream migration decision.
2. Define UX states + design tokens and screen map.
3. Rust & Tauri scaffold with typed front/back boundary. The separate UI-foundation branch prototypes Session Sentinel and keyboard navigation with in-memory data; real backend monitoring is tracked in [Issue #15](https://github.com/ChiJiun/agentdock/issues/15).
4. ACP mock first and supported real adapter compatibility matrix.
5. Storage and approval gates before unrestricted real-agent tools.
6. Worktree and change review.
7. GitHub integration with human confirmation before pushes/merges.
8. Remote worker after reliable local tasks.
9. Provider routing & advanced token optimizations after metrics.

## MVP Definition of Done

- Clean Git repo, reproducible Windows dev build.
- Repo picker and local project list persist.
- Start and cancel session with two adapters, including a deterministic mock.
- Session event log survives app restart without pretending external agent session can resume.
- Permission denial actually stops host-controlled operation.
- Git status and diff shown for changed files.
- CI runs representative tests and lint; failure artifacts discoverable.

## V1.0 Definition of Done

- Separate worktrees for concurrent task runs.
- Issue→PR→CI demo with independent review and human-approved merge boundary.
- Remote work survives UI disconnect; worker reconnect catches missed events.
- Accurately distinguishes API cost estimate vs unknown subscription remaining quota.
- Documented security threat model and forced failure/restart tests.

## Benchmarks

Run identical representative tasks on: (A) single strong model, (B) role routing, (C) routing+advisor. Record model versions, prompts, repo commits, tests, success rate, API billed costs where available, cache stats, retries, elapsed time, intervention and crash recovery. Do not extrapolate the purported 99% single-update saving to total task costs.

## CI

- Rust fmt, clippy, tests.
- TypeScript typecheck, lint, unit tests.
- Windows desktop build smoke test before announcing Windows support.
- Git fixtures and mock-ACP integration tests.
- Security regression tests for path traversal, approval bypass, symlink escape and replay.
- No secrets in CI or demo fixtures.

## Delivery caution

For one developer working around classes and internship, optimize for vertical slices: a real agent finishes a safe task in a real repo, with visible evidence, before building an Agent OS. Multi-month estimates are dependent on available engineering time, not a fixed release commitment.

## Self-hosting Alpha / v0.1.0-alpha

- **目的**：優先讓 AgentDock 成為自身開發的主要工作台，保留既有桌面工具作備援；不必先完成通用 Cache、Integration Queue 或遠端 Worker。
- **Release Gate**：[Issue #51](https://github.com/ChiJiun/agentdock/issues/51) 定義 Windows build、真實 Claude Code/Codex、Worktree、Diff、受控 Git、測試結果、持久化、10 個真實任務及安全負向測試。只在全部通過後標示 Alpha release。
- **逐步切換**：用 AgentDock 完成 10 個自身 repo 任務後開始主要使用；持續觀察 20–30 個任務的完成時間、失敗率、人工介入與恢復成功率。此為可驗證目標，並非已實測的加速承諾。
- **V1 之後**：[#47](https://github.com/ChiJiun/agentdock/issues/47) 通用 Local CI、[#48](https://github.com/ChiJiun/agentdock/issues/48) Cache/Evidence、[#49](https://github.com/ChiJiun/agentdock/issues/49) Integration/Policy；新功能不能重寫已進行中的 #9/#10 Task/Worktree。

## 候選能力與決策邊界

[#52](https://github.com/ChiJiun/agentdock/issues/52) 負責研究以下五項：跨專案程式碼理解與重用、版本化 Project Memory、Cross-repo Orchestration、OS-level Sandbox、持續效率 Benchmark。每項先決定 **V1 / V2 / Defer** 與 **build / buy / integrate**，並列出可衡量的驗收；研究 Issue 不代表已核准全部實作。對早期使用效益優先評估程式碼重用、交接與 Benchmark；Sandbox 的風險邊界不可延後到允許執行不可信命令之後才處理。

## 上游 GitHub Fork（每週同步）

[#53](https://github.com/ChiJiun/agentdock/issues/53) 追蹤重要上游的 四個重要上游 GitHub Fork、每週安全同步與分歧保護。Fork 用於開發與提交上游 PR；只同步追蹤分支，不覆寫自有分支。不建立 Git Mirror、git bundle 或異地備份；Fork 不包含 Issue/PR/Release asset 備份。候選來源與 SHA 參見 [Local-first Multi-Agent SDLC 設計 PR #50](https://github.com/ChiJiun/agentdock/pull/50)。

## Repository Protection

- 在 `main` 使用 GitHub server-side Ruleset / Branch Protection：Require PR、block force push/deletion、review resolution、穩定 Required Checks；Local Hooks/AgentDock Policy 只能保護受控操作，不能取代伺服器保護。
- **先盤點實際 CI Check 名稱與觸發條件**，確認 Required Check 對所有相關 PR 都會產生；Rust/Tauri Windows CI 存在並穩定後才列入 Required。
- 對單人維護者，要求人類 Approving Review 可能造成無法合併；需先確認可用審查者與 Ruleset 可執行性。
- GitHub Ruleset 修改需 Repository Administration 權限；不可因為建立文件 PR 成功就推定擁有該權限。
