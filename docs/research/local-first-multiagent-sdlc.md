# Local-first Multi-Agent SDLC：通用多 Agent 開發、驗證與整合

> 研究與設計提案 · 2026-11-22 · 不代表功能已實作或上游程式碼已移植
>
> 關聯 Issues：[#47 通用 Local CI](https://github.com/ChiJiun/agentdock/issues/47)、[#48 Cache/Evidence](https://github.com/ChiJiun/agentdock/issues/48)、[#49 Integration/Policy](https://github.com/ChiJiun/agentdock/issues/49)；既有 [#9 Worktree](https://github.com/ChiJiun/agentdock/issues/9)、[#10 Task/PR/CI](https://github.com/ChiJiun/agentdock/issues/10)、[#14 E2E](https://github.com/ChiJiun/agentdock/issues/14)、[#30 Orca 研究](https://github.com/ChiJiun/agentdock/issues/30)、[#37 Worktree 安全](https://github.com/ChiJiun/agentdock/issues/37)、[#41 遠端 CI](https://github.com/ChiJiun/agentdock/issues/41)。

## 1. 決策與限制

- **選擇：整合 AgentDock 的可獨立使用 Core Engine**。先以現有 repo 的 Rust orchestration / Tauri 分層實作，對外預留 CLI 與獨立 library API；不用現在另開一個 Agent 平台 repo，也不把邏輯埋在 React UI。
- 保留 **Git 為預設 Source Control**，可選 Jujutsu backend；**GitHub/GitLab 受保護分支、CI、審核仍為遠端正式合併權威**。本地 Git Hooks 可以繞過，不能宣稱提供等價的不可繞過 Branch Protection。
- 目標是**適用於各種 Repo/多 Repo**，不是針對單一錢包、Buildroot 或 Node 專案寫特例。先實作最少的 Project Adapter 契約，再逐步支援各語言。
- **重用成熟工具優先**：Worktrunk CLI、各語言既有 build cache、Nx 的任務圖模型（不可假設 Nx TS 檔可獨立移植）、正式 Git 操作。只在缺乏可靠外部 API 時實作薄 Rust facade。
- **不要複製 Scion**：Anthropic 的 Scion 是自研集中式 Source Control + server APIs + cache，目標規模與 AgentDock 不同；其公開文章是架構設計參考，沒有可直接採用的 Scion 開源程式碼。
- **目前狀態**：主分支仍以 React/Vite UI 原型為主；PR #28 的 Worktree、PR #29 的 Node 開發版任務狀態機尚在審查/整合中。不得把它們算成已發行的 Rust/Tauri 功能，也不要在新切片重寫現有 state machine。

## 2. 建議分層

```text
AgentDock UI / CLI / ACP adapters / Remote worker
                 |
        Task + Approval + Event API
                 |
      Local SDLC Core (可重用模組)
        | Worktree provider (Git; optional jj)
        | Project discovery + task graph
        | Affected analysis + local verification runner
        | Build cache / result cache / provenance
        | deterministic integration queue
        | local policy / remote protection adapter
                 |
  Git / Worktrunk / language-native caches / CI providers
```

- `ProjectAdapter`：偵測專案、提供待確認的任務命令、inputs/outputs、工具鏈與可能的依賴。發現腳本不等於授權執行。
- `VerificationRunner`：透過不經 shell 的參數化執行、限定 cwd/path、Timeout、資源配額、輸出上限、狀態與證據紀錄；執行者結果不得由 Agent 自行填寫。
- `CacheProvider`：預設僅復用可安全聲明輸入的 build 產物；test-result cache 需要更嚴格的 eligibility。
- `IntegrationCoordinator`：依任務相依、來源 commit、衝突、有效 evidence 排程；合併後取得新的 tree/commit 並進行必要驗證。
- `RemoteGate`：查最新遠端 HEAD、審查與 required checks，對照 exact commit；推送、建立 PR、正式合併保持人工核准政策。
- `EvidenceStore`：持久化本地 runner 與遠端 provider 的來源、SHA、test definition、artifact digest、結果與失效原因。不可把 operator-attested 或 LLM claim 升級為 provider-verified。

## 3. 研究來源與功能 → 具體程式碼

所有路徑已於 2026-11-22 透過 GitHub 目錄與部分檔案內容確認存在；以下均屬**候選研究入口**，沒有證明整個 dependency closure、跨平台測試、安全性或可直接複製。URL 使用此次查證時的 immutable commit SHA。

| 功能 | 上游來源／固定 SHA／授權 | 可讀原始碼位置 | AgentDock 對應 |
| --- | --- | --- | --- |
| Worktree lifecycle／Git 操作 | [Worktrunk](https://github.com/max-sixty/worktrunk/tree/abe78b3be719b9caff4efc155ad83e697c2202f7) · MIT OR Apache-2.0 | [`src/commands/worktree/`](https://github.com/max-sixty/worktrunk/tree/abe78b3be719b9caff4efc155ad83e697c2202f7/src/commands/worktree)、[`src/git/repository/worktrees.rs`](https://github.com/max-sixty/worktrunk/blob/abe78b3be719b9caff4efc155ad83e697c2202f7/src/git/repository/worktrees.rs) | #9、#37、PR #28 |
| Worktree 審批／Hooks／Merge | Worktrunk · 同上 | [`src/config/hooks.rs`](https://github.com/max-sixty/worktrunk/blob/abe78b3be719b9caff4efc155ad83e697c2202f7/src/config/hooks.rs)、[`src/commands/merge.rs`](https://github.com/max-sixty/worktrunk/blob/abe78b3be719b9caff4efc155ad83e697c2202f7/src/commands/merge.rs)、[`src/git/repository/integration.rs`](https://github.com/max-sixty/worktrunk/blob/abe78b3be719b9caff4efc155ad83e697c2202f7/src/git/repository/integration.rs) | #49、#8 |
| 建置產物跨 worktree 複製 | Worktrunk · 同上 | [`src/copy.rs`](https://github.com/max-sixty/worktrunk/blob/abe78b3be719b9caff4efc155ad83e697c2202f7/src/copy.rs)、[hook reference](https://github.com/max-sixty/worktrunk/blob/abe78b3be719b9caff4efc155ad83e697c2202f7/skills/worktrunk/reference/hook.md) | #48 |
| 工作台／Worktree 安全與 Windows | [Orca](https://github.com/stablyai/orca/tree/35eed0a05314feae84a855c8a5a8b7773b719a66) · MIT | [`src/main/git/worktrees/creation/worktree-add.ts`](https://github.com/stablyai/orca/blob/35eed0a05314feae84a855c8a5a8b7773b719a66/src/main/git/worktrees/creation/worktree-add.ts)、[`removal/worktree-removal-preflight.ts`](https://github.com/stablyai/orca/blob/35eed0a05314feae84a855c8a5a8b7773b719a66/src/main/git/worktrees/removal/worktree-removal-preflight.ts)、[`removal/windows-worktree-removal.ts`](https://github.com/stablyai/orca/blob/35eed0a05314feae84a855c8a5a8b7773b719a66/src/main/git/worktrees/removal/windows-worktree-removal.ts) | #30、#37、PR #45；不搬 Electron IPC |
| 本地驗證／檢查彙整 | [AgentBridge](https://github.com/yoonjae26/AgentBridge/tree/c37a3c904785d7f84090fd98cf364577e4caf90f) · MIT | [`src/agentbridge/validation/engine.py`](https://github.com/yoonjae26/AgentBridge/blob/c37a3c904785d7f84090fd98cf364577e4caf90f/src/agentbridge/validation/engine.py)、[`validation/runners.py`](https://github.com/yoonjae26/AgentBridge/blob/c37a3c904785d7f84090fd98cf364577e4caf90f/src/agentbridge/validation/runners.py) | #47 |
| Git 衝突／人工核准整合 | AgentBridge · 同上 | [`src/agentbridge/workspace/conflicts.py`](https://github.com/yoonjae26/AgentBridge/blob/c37a3c904785d7f84090fd98cf364577e4caf90f/src/agentbridge/workspace/conflicts.py)、[`workspace/integration.py`](https://github.com/yoonjae26/AgentBridge/blob/c37a3c904785d7f84090fd98cf364577e4caf90f/src/agentbridge/workspace/integration.py) | #49 |
| 確定性驗證命令 | [Orkestra](https://github.com/andyyaro/orkestra/tree/68ef18b939d62b703334746ea94e5ecb7bc3cae0) · Apache-2.0 | [`src/orkestra/verify/runner.py`](https://github.com/andyyaro/orkestra/blob/68ef18b939d62b703334746ea94e5ecb7bc3cae0/src/orkestra/verify/runner.py)、[`verify/record.py`](https://github.com/andyyaro/orkestra/blob/68ef18b939d62b703334746ea94e5ecb7bc3cae0/src/orkestra/verify/record.py)、[`verify/binding.py`](https://github.com/andyyaro/orkestra/blob/68ef18b939d62b703334746ea94e5ecb7bc3cae0/src/orkestra/verify/binding.py) | #47、#48 |
| DAG 排程與非 LLM 政策 | Orkestra · 同上 | [`src/orkestra/kernel/dag.py`](https://github.com/andyyaro/orkestra/blob/68ef18b939d62b703334746ea94e5ecb7bc3cae0/src/orkestra/kernel/dag.py)、[`kernel/scheduler.py`](https://github.com/andyyaro/orkestra/blob/68ef18b939d62b703334746ea94e5ecb7bc3cae0/src/orkestra/kernel/scheduler.py)、[`policy/engine.py`](https://github.com/andyyaro/orkestra/blob/68ef18b939d62b703334746ea94e5ecb7bc3cae0/src/orkestra/policy/engine.py) | #49、#8 |
| Affected task graph | [Nx](https://github.com/nrwl/nx/tree/341530f8a798dcfa071bb975100f41c214543427) · MIT | [`packages/nx/src/project-graph/affected/affected-tasks.ts`](https://github.com/nrwl/nx/blob/341530f8a798dcfa071bb975100f41c214543427/packages/nx/src/project-graph/affected/affected-tasks.ts)、[`tasks-runner/create-task-graph.ts`](https://github.com/nrwl/nx/blob/341530f8a798dcfa071bb975100f41c214543427/packages/nx/src/tasks-runner/create-task-graph.ts) | #47 |
| Input hash／Task cache | Nx · 同上 | [`packages/nx/src/hasher/hash-task.ts`](https://github.com/nrwl/nx/blob/341530f8a798dcfa071bb975100f41c214543427/packages/nx/src/hasher/hash-task.ts)、[`tasks-runner/cache.ts`](https://github.com/nrwl/nx/blob/341530f8a798dcfa071bb975100f41c214543427/packages/nx/src/tasks-runner/cache.ts) | #48 |
| 可選 Git 相容 VCS | [Jujutsu](https://github.com/jj-vcs/jj/tree/0f7f4ced8c1a24bef5a7fd8b9be64fbc63ddb3e0) · Apache-2.0 | [`cli/src/commands/`](https://github.com/jj-vcs/jj/tree/0f7f4ced8c1a24bef5a7fd8b9be64fbc63ddb3e0/cli/src/commands)、[`lib/src/workspace.rs`](https://github.com/jj-vcs/jj/blob/0f7f4ced8c1a24bef5a7fd8b9be64fbc63ddb3e0/lib/src/workspace.rs)、[official Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/) | 將來 `VcsProvider`，非 MVP 必要 |
| 大型 Source Control 架構 | [Anthropic Scion 官方文章](https://www.anthropic.com/research/redesigning-source-control) · 非公開可搬運原始碼 | 伺服器端操作、稀疏 checkout、內容定址、多層快取之設計 | 長期方向，**不 fork、不拷貝** |

### 授權／移植的先決條件

對每個候選模組，正式實作前須在 PR 補充：確切 SHA 與檔案、LICENSE/NOTICE、dependency closure、公開 API、Windows/WSL 相容性、security assumptions、上游更新策略、最小 fixture 測試。優先以 CLI、協定或套件依賴方式重用。Orca Electron 相關 IPC 與 UI 不可當成 Rust Host 的安全邊界。沒有證據時只標「研究」，不可寫成「已驗證重用」。

GitButler 的 Fair Source/競品限制不適合直接移植；Vibe Kanban 的產品維護狀態不適合當長期核心依賴。兩者可作為行為與 UI 研究參考，不列入程式碼移植清單。

## 4. Local CI 策略與信任模型

1. **每次小改**：格式、lint、靜態檢查、已知受影響 unit tests。
2. **任務完成**：完整受影響模組測試、必要 integration、負向案例與獨立 Review。
3. **本地整合**：建立可重現的 synthetic merge tree，在整合後 Commit 上重算 affected，並依變更範圍重測；之前 feature head 的 PASS 不等於整合結果 PASS。
4. **遠端 Push/PR**：由 GitHub Rulesets、required checks、Review 與使用者核准決定是否能正式合併；Release 所需 clean/reproducibility 證據不可用增量快取冒充。

**快取正確性**：Cache Key 最少包括 repo/tree 或完整 dirty snapshot、命令與旗標、dependency lockfiles、task graph、工具鏈與版本、OS/CPU 架構、相關環境摘要、外部輸入及輸出宣告。命令使用 time/network/random state、外部 DB、實體硬體、未知輸入或動態 side effects 時不可重用 Test Result。快取的 build outputs 仍須檢查來源、完整性與可重用範圍。

**Evidence contract（提案）**：

```text
taskId, repositoryId, worktreeId, headSha, baseSha, integrationTreeSha?,
dirtySnapshotDigest?, commandArgvDigest, configDigest, dependencyDigest,
toolchainDigest, platform, runnerType, verificationSource,
start/end, result(PASS|FAIL|BLOCKED|SKIPPED|NOT_TESTED),
artifactDigests, logRef, cacheMode, invalidationReason?
```

`operator_attested`、`local_runner_observed`、`remote_provider_verified` 信任層級不同。若執行 Agent 能自行修改本地 evidence DB 或 hook，證據不能宣稱獨立安全審計；必須有行程權限／沙盒隔離與可信執行者後才能提高保證等級。對敏感發布，使用真正獨立遠端 Runner。

**本地分支政策限制**：本地 Branch Policy 是 AgentDock 管理的受控整合流程；Git CLI/直接磁碟操作可以繞過 hooks。不能把本地通過等同於 GitHub Protected Branch。

## 5. 工作流程與並行衝突

- Task A/B/C 各有獨立 Worktree 與 Session，不能任意編輯別人的 Worktree；路徑 canonicalization 與 symlink/junction race 需做負向測試。
- 每個 Agent 只回報任務與 evidence，Integration Coordinator 決定何時可以進佇列；有依賴的任務必須按 DAG 推進。
- 經審核的本地 Commit 先在暫存整合 Worktree 計算合併、偵測衝突、重做受影響驗證；禁止 `reset --hard`、強迫清理或 force push。
- 多 Repo 只保證個別 Repo 的原子 Git 操作，不宣稱跨 Repo 分散式交易；需要鎖版與批次提交策略。
- 同時多個 Agent 推進 Integration，透過 queue lock/CAS 避免同一個 base 被重複整合。崩潰重啟不得重放非冪等 Git Push/Merge。
- Windows / WSL 分別測試路徑大小寫、工作樹權限、原生 Git vs Linux Git、跨檔案系統 cache 行為。

## 6. Fork 策略

**初期不 fork 上述專案。** 先使用 pinned release／commit 的外部執行檔、Published package、文件及 Read-only source research。一次 fork 七個大型 repo 會產生同步與安全維護成本。

僅在以下條件成立時 fork 單一 upstream：
1. 已證明現有 CLI/SDK 無法支援必要能力，而且 PR 需維護上游核心的改動；
2. 需要提交 upstream PR 或長期維護已核對 license 的 patch；
3. 已有固定版本、最小移植範圍、測試、修補同步策略與安全責任人。

專案之間不同語言/Runtime，不能因為 license 開放就直接全部 copy/paste 到 AgentDock。若只是借鑑算法與契約，寫成原創、可測試的薄介面，保留來源 attribution。

## 7. 分期驗收與工程時數估計

以目前 `main` 偏 UI 原型、PR #28/#29 等仍在整合的狀態估計；以下**累計工程時數**包含 Agent 產出審查、跨模組整合、測試與安全修正，並非日曆時間或效能實測。

| 階段 | 累計工程時數（估計） | Gate |
| --- | ---: | --- |
| 首個可用 vertical slice | 100–200 h | 兩個真實 Agent、隔離 Worktree、local verifier、獨立 review、一個真實 PR，不破壞 main |
| 通用開發 V1 | 300–550 h | 3 種語言與 unknown fallback、#47–49、整合後驗證、cache key/失效、Windows/WSL、受控 GitHub 閘門、持久化 |
| 完整產品願景 | 600–1,000+ h | 穩定 Rust/Tauri、遠端 Worker/重連、健壯 sandbox、成本路由、多 Provider、跨平台與性能基準 |

任何「縮短 X%」的說法須先量測：在相同任務、repo SHA、Agent 和測試集合下比較 wall time、CI minutes、cache hit rate、錯誤逃逸率、merge conflict/rework、人工介入及資源消耗。優先優化 **正確完成時間**，不能以跳過必要測試換取表面速度。

## 8. 開發順序與既有 PR 邊界

1. **先處理現有 Rust/Tauri 與 ACP 結構，以及既有 #9/#10 PR**：確認正式 Host 的單一 Task/Evidence contract；不得在新 Issues 建第二套。
2. **#47**：先完成可測試的 Project Adapter + Affected Tasks + 安全驗證命令，不建立通用可編程 CI 平台。
3. **#48**：先包裝既有語言原生快取與保存可查 evidence，再擴充跨 worktree、結果快取。
4. **#49**：在不破壞既有 Task State Machine 的情況下增加整合佇列、合併後重驗證及 policy。
5. **#14/#41**：固定 fixture 做多 Agent baseline 對照，確認 GitHub remote required checks 與本地證據邊界。
6. Jujutsu、遠端共享快取、Scion 式專屬 Source Control Server 屬後續探索，沒有前述量測需要就不做。

本文件僅完成來源和設計盤點：**沒有 fork、沒有移植或執行任何上游程式碼、沒有驗證本地整合或多 Agent 端到端功能**。
