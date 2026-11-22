# AgentDock 通用開發能力地圖與分期決策

> 2026-11-22 · **規劃文件，非已實作功能**。完整工作項目與驗收：[Issue #52](https://github.com/ChiJiun/agentdock/issues/52)；[M2.5 Self-hosting #51](https://github.com/ChiJiun/agentdock/issues/51)；[上游 Fork 週同步 #53](https://github.com/ChiJiun/agentdock/issues/53)；[main Protection #55](https://github.com/ChiJiun/agentdock/issues/55)。

## 產品目標
以 AgentDock 作為跨專案、多 Agent 的 Windows-first、Local-first 開發工作台；重用現有 Claude Code/Codex/ACP、Git、CI、建置快取與開源模組，降低多 Agent 重複建置、測試、審查與上下文交接成本。每項能力應能單獨測試、漸進推出，不依賴一個巨大的新框架。

## 全部候選能力及初步分期

| 功能領域 | 必須設計的能力 | 初步階段 | 關聯 |
|---|---|---|---|
| Windows 桌面與 Agent Sessions | Rust/Tauri、ACP Adapter、Claude Code/Codex、Session/Task 持久化、核准、真實失敗恢復 | Alpha | #51 |
| Git/Worktree | 多 Agent 隔離、diff、branch/merge、保護分支、衝突偵測 | Alpha 基礎；V1 擴充 | #9、#49 |
| GitHub/GitLab Workflow | Issue→PR→CI、Review、Required Checks、受控合併、Provider adapters | Alpha GitHub 基礎；V1 擴充 | #10、#41、#55 |
| 通用 Project Adapter/Local CI | Python、TS、Rust、Go、未知專案 fallback、affected graph、驗證證據 | V1 | #47 |
| 跨 Worktree Cache | 共享編譯輸出、task input hash、快取失效、證據信任層級 | V1 | #48 |
| Integration Queue | dependency-aware integration、synthetic merge 後驗證、分支政策 | V1 | #49 |
| Codebase Intelligence & Reuse | Symbol/reference 搜尋、API 索引、來源/授權/provenance、避免重寫 | V1 研究；依決策實作 | #52 |
| Project Memory/Handoff | 版本化 ADR、Task 交接、context、失敗證據、過期與衝突 | V1 研究；依決策實作 | #52 |
| Cross-repo Orchestration | 多 Repo DAG、相容版本、部分失敗與回復 | V2 | #52 |
| OS-level Sandbox | Windows/WSL/remote worker 隔離、檔案／網路／憑證權限 | 安全基線從 Alpha 開始，完整隔離分期 | #52 |
| Remote Worker | SSH、reconnect、durable event log、冪等副作用、資源配額 | V2 / M4 | roadmap M4 |
| Cost/Scheduling/Benchmark | 模型成本來源、任務調度、品質／成本／人工介入測量 | Alpha 開始量測；V1/V2 擴充 | #14、#52 |
| Release & Supply Chain | 安裝包、checksum、release gate、來源 pin、SBOM、備份 | Alpha 最低 Gate；V1 擴充 | #51、#53、#55 |
| Plugin/Adapter/Data Ownership | 擴充介面、資料匯出/備份、schema migration、版本相容 | V1 介面；V2 擴充 | #52 |

**這是初步分期，非所有功能已獲核准。** #52 需為每一類補齊：需求、替代方案、build/buy/integrate/defer、上游程式碼與授權、介面／資料模型、安全邊界、相依、預估工時、測試與驗收，然後才拆 Feature Issues。不能把整張表當作 Alpha 的 release blocker。

## Alpha Release Gate

[#51](https://github.com/ChiJiun/agentdock/issues/51) 是唯一完整 Alpha Gate：Windows 可安裝、真實 Claude Code/Codex、兩個 Worktree、Session 事件保存、可驗證測試、Git Diff/PR、權限核准、10 個真實任務無資料遺失。允許逐步以 AgentDock 開發 AgentDock；20–30 個任務的基準比較後才考慮取代既有工具。**不以 Local CI Cache、完整 Integration Queue、Remote Worker 阻擋 v0.1.0-alpha。**

## 上游保留：GitHub Fork 與每週同步

- **Fork**：GitHub 上的獨立開發副本，可保留自己的 feature branches、送 upstream PR；同步 upstream 時不得 force push 或覆寫自己的修改。
- **每週同步**：只對 Worktrunk、Orca、AgentBridge、Orkestra 建立公開 GitHub Fork；預設每週日 03:00 Asia/Taipei，使用 fast-forward-only，保留自有開發分支，失敗時通知；不得 force push。
- **不建立 Mirror**：使用者明確排除 Git Mirror、git bundle、NAS、外部平台與異地快照。Fork 不是跨平台備份，也不保存上游 Issue/PR/Release Assets。
- **版本與授權**：保留 pinned SHA、LICENSE/NOTICE 來源；上游變更不會自動更新 AgentDock 的正式依賴。
- **執行界線**：Fork 與排程需要具備對應 GitHub 權限；完整 Gate 見 #53。

## GitHub 保護與權威

AgentDock Local Branch Policy、Agent Review、Git Hooks 不可替代 GitHub server-side Ruleset / Branch Protection。#55 要求管理權限盤點、穩定 Required Checks、PR/Conversation Resolution、禁止 force push/deletion、保護規則驗證。單人維護者不得設定會永久阻擋自己的不可達成人類審核數。詳細方案見 #55。

## 開源來源與代碼路徑

參考 [PR #50 的研究文件](https://github.com/ChiJiun/agentdock/pull/50)：Worktrunk、Orca、AgentBridge、Orkestra、Nx、Jujutsu、Scion 架構與實際來源 SHA/檔案。研究不代表程式碼已移植；優先 CLI/SDK/套件重用，copy/paste 需要授權、NOTICE、依賴與安全審核。
