# AgentDock 全流程語言政策（Traditional Chinese–first Harness）

狀態：**規格。前端的 UI 語言切換與語言範圍設定已由 PR #24 合併（`src/i18n/`，瀏覽器內預覽）；Rust 後端（Tauri Host、ACP、事件儲存）的語言政策尚未實作，也還沒有對應的任務包。`prototypes/language-policy/` 是規格參考原型，不是產品實作。**
日期：2026-11-17（2026-11-27 依 ADR-0004、ADR-0005 與 PR #24 合併後的現況更新）
追蹤：[Issue #18](https://github.com/ChiJiun/agentdock/issues/18)；依賴 #3 Task/Session Contract、#6 ACP、#7 Event Store、#15 Session Sentinel；相關決策 [ADR-0003](../decisions/0003-task-session-event-contracts.md)、[ADR-0004](../decisions/0004-rust-primary-backend.md)、[ADR-0005](../decisions/0005-model-tiers.md)

> 本文件整併了先前平行撰寫的 `end-to-end-language-policy.md` 草稿（分支 `docs/zh-tw-harness-policy`，commit `2737128`）。語言政策以本檔為單一來源。

## 1. 目標，以及不能承諾的部分

使用者可以在 Settings 的 **Language / 語言** 中切換 `繁體中文（臺灣）`、`English`、`依專案設定`，且設定的影響範圍**不只 UI 字串**，還包含可控制的整體開發工作流程：

- **使用者面向**：導覽列、權限對話框、錯誤說明、Session Timeline、摘要、提醒。
- **Agent 內容**：一般問答、計畫、任務分析、Advisor 諮詢、Subagent handoff、Review、測試結論、Done report。
- **開發產物**：Issue/PR 標題與內容、Review 意見、Commit Message、README/說明文件、變更紀錄、必要時程式碼註解。
- **指示來源**：Default/Project/Session/Task Prompt、AGENTS.md / CLAUDE.md / Copilot Instructions、Skills、工具輸出的後續摘要。

**這不等於翻譯所有 Context 內容。** 不修改原始 `SKILL.md`、`AGENTS.md`、`CLAUDE.md`、命令、程式碼、API Schema、原始日誌與外部文件；只把使用者可讀的解釋切換語言，並保留精確的原始證據。

**語言的可控性必須如實揭露。** 不同外部 ACP Runtime 可能無法接受持久化的系統指令，也不一定提供可觀察的內部 Skill / Subagent 內容。AgentDock 不可宣稱已修改 Claude Code、Codex、Copilot 或 Octomind 的私有上下文；對不支援自訂指示的外部 Harness 只能 best-effort。

### 實作位置（依 ADR-0004）

後端以 Rust 為主（[ADR-0004](../decisions/0004-rust-primary-backend.md)），所以本政策中會影響 agent 行為或需要可稽核的部分都屬於 Rust 後端（Tauri 2 Host 與 `crates/*`）：

- 有效語言的解析（第 2 節）、政策版本與快照（第 5 節）、語言 Overlay 的組裝（第 3 節）、ACP 能力協商與能力狀態（第 4 節）、Session Sentinel 的摘要範本（第 7 節）。
- 快照與語言相關事件要寫進事件儲存；Task／Session／Event 契約以 [ADR-0003](../decisions/0003-task-session-event-contracts.md)（`docs/contracts/`）為準。契約目前**沒有**語言政策的欄位或事件型別，新增需要獨立的契約 PR，本文件不修改契約。
- React／TypeScript 前端只負責顯示字串與設定畫面，透過型別化的 Tauri command 讀寫設定。目前 main 上的 `src/i18n/language.ts`（PR #24）是在瀏覽器內解析並存到 `localStorage` 的預覽實作；後端完成後，以後端的解析結果為準。
- `prototypes/language-policy/*.mjs` 是**規格參考原型**：用來把優先序與邊界情況寫成可執行的例子，不是產品實作，也不會隨產品出貨。Rust 實作要另立任務包（`docs/tasks/` 目前沒有語言政策的任務包），並把原型與 `src/i18n/language.test.ts` 的情境移植成 Rust 測試。

語言偏好與 [ADR-0005](../decisions/0005-model-tiers.md) 的三個軸（能力等級、編排、權限）互相獨立：切換語言不改變任何一軸，語言 Overlay 也不得用來要求較高的等級、平行編排或較寬的權限。

## 2. 語言維度、設定鍵與優先序

Issue #18 要求把四種語言維度分開：

| 維度 | 設定鍵 | 生效範圍 |
| --- | --- | --- |
| UI 語言 | `uiLocale` | 導覽列、按鈕、設定、通知、錯誤與狀態標籤（決定性字串，不呼叫模型） |
| 工作流程語言 | `workflowLocale` | Agent 說明、Plan、Review、Advisor、Subagent 摘要、決策請求、Skill 執行說明 |
| 產物語言 | `artifactLocale` | 生成的敘述性產物：文件、Issue/PR、變更紀錄、Commit Message；可再按類型覆寫 |
| 來源語言 | （不是設定值） | 程式碼識別字、精確 CLI 命令、測試斷言、外部文件與原始 Log **一律不自動翻譯** |

細項覆寫鍵（`outputs.*`）：

| 鍵 | 作用 | 範例 |
| --- | --- | --- |
| `outputs.plan` | Plan/設計方案 | `inherit` |
| `outputs.review` | Review 與 CI 解讀 | `inherit` |
| `outputs.issue`、`outputs.pullRequest` | GitHub 產物 | `inherit` |
| `outputs.commitMessage` | Commit 命名 | `en-US`（團隊可另訂） |
| `outputs.documentation` | README、報告、ChangeLog | `inherit` |
| `outputs.codeComments` | 程式碼註解 | `preserve-original`（規格只定義在此鍵；原型目前對其他階段也接受這個值，是待收斂的差異）或 `zh-TW` |
| `outputs.sessionSummary`、`outputs.notification` | Session Sentinel 摘要與通知 | `inherit` |
| `outputs.skillExplanation` | Skills 執行結果說明與摘要 | `inherit` |

Locale 以 BCP 47 表示；MVP 只支援 `zh-TW`、`en-US`。不得把未支援的標籤（例如 `zh-CN`、`zh`）自動替換成其他語言，也不得從顯示名稱猜測 Locale；未支援的值要明確拒絕或回報。翻譯只影響顯示，不影響資料庫中的 Task State、事件種類與 Policy 識別字。

**優先序：Task（明確要求）> Session > Project > Global**，越靠近目前任務的**語言偏好**越優先。**但任何語言偏好都不得覆寫安全／工具權限／官方 API 契約或既有不可違反的專案限制。**

針對某個輸出階段的解析分兩輪，與 main 上已合併的前端實作（`src/i18n/language.ts`）相同：

1. **第一輪：明確設定。** 由近到遠（Task → Session → Project → Global）逐層看：
   1. 該層的 `outputs.<stage>`（`inherit` 視為未設定）。
   2. 若是產物類階段（`issue`、`pullRequest`、`commitMessage`、`documentation`）：該層的 `artifactLocale`（`inherit` 視為未設定）。
2. **第二輪：工作流程語言。** 第一輪都沒有結果時，由近到遠取第一個有設定的 `workflowLocale`。
3. 都沒有時，最後的預設是 `zh-TW`（Issue #18：中文工作流程預設 `zh-TW`，`en-US` 要明確選取）。

上面第 3 點只是解析規則的最後一步，和「產品出廠時內建的預設設定」是兩件事。main 上的前端另外內建一份 Global 預設（`src/i18n/language.ts` 的 `DEFAULT_SETTINGS`：`uiLocale = zh-TW`、`workflowLocale = zh-TW`、`artifactLocale = inherit`、`outputs.commitMessage = en-US`、`outputs.codeComments = preserve-original`），所以使用者什麼都沒設定時，前端解析出的 Commit Message 是 `en-US`，不是 `zh-TW`。Rust 後端要把「解析規則」與「內建預設設定」分開定義；內建預設要不要沿用前端這一份尚未決定（見第 11 節）。

這個順序的用意：**較近一層的 `workflowLocale` 不會蓋過較遠一層對單一階段或產物語言的明確設定。** 例如 Global 設了 `outputs.commitMessage = en-US`，Project 只設 `workflowLocale = zh-TW`，Commit Message 仍是 `en-US`；要改它，必須在較近一層明確設定 `outputs.commitMessage` 或 `artifactLocale`。

例外：`codeComments` 只接受明確的 `outputs.codeComments`，不繼承 `artifactLocale` 或 `workflowLocale`；沒有設定時是 `preserve-original`（依 Repo 既有慣例）。`uiLocale` 只看 Global，沒有設定時是 `zh-TW`。

UI 要讓使用者按一次「整體使用繁體中文」即可批次套用可繼承項目；也應允許「保留 Commit Message 英文」、「程式碼註解依 Repo 規範」等例外。

## 3. Context Assembly：不是翻譯整份 Prompt

由 `LanguagePolicyResolver` 計算 Effective Profile，再由 `ContextAssembler` 在**具有合法注入點的 Agent／任務**進行組裝：

```text
安全／權限邊界（由 Host 保證，非 Prompt 可繞過）
    ↓
適用的專案與 Agent 原始指示（保持原文和操作語義）
    ↓
使用者及工作流程的 Locale Profile（經能力協商）
    ↓
已載入的 Skill / 工具定義原文（不可靜默改動）
    ↓
Skill locale overlay：只指定可讀輸出的語言和術語偏好
    ↓
目前 Task／使用者需求（含明確的語言要求）
    ↓
Token／Context Budget + 來源與政策快照
```

這是 AgentDock **自有 Context 組裝流程**的邏輯層次，不代表外部 Agent 的 System Prompt 權限；不得把 Repo 文件或未信任的工具輸出偷偷提升成 System 指令。

- 對「可控 Native Agent」：使用明確的 Agent 語言指示層；Executor、Explorer、Advisor、Reviewer、Progress reporter 等角色各自繼承同一份 Effective Profile，而不是各 Skill 自行猜測使用者的語言；每個 Prompt 有來源和版本。Subagent 繼承語言偏好時，不得因此擴大它的工具或權限。
- 對「外部 ACP Agent」：先檢查 Adapter 是否宣告可用的指示通道（見第 4 節）；有才施加 Overlay，沒有則以 **best effort** 透過一般 Prompt 傳遞，並在 UI 標示。不得將傳一般 Prompt 包裝成「已修改 System Prompt」。
- **Prompt／Skills 原文是資料與原有操作需求**：只新增獨立 Locale Overlay，不直接覆寫或偷偷翻譯 `SKILL.md`、frontmatter、Shell Scripts、Python Scripts、MCP schema、Tool 命令。
- 語言指示範本（`zh-TW` 與 `en-US` 各一份）是版本化、短小的 Host-owned Policy，版本識別字為 `agentdock-language-v1`。目前有兩份文字不同的草稿：參考原型 `prototypes/language-policy/resolve.mjs` 與前端 `src/i18n/language.ts`；Rust 後端實作時要定為單一來源（見第 11 節）。
- 先使用可維護的術語表：`worktree`、`rebase`、`token`、`cache`、`branch`、`GitHub Actions` 等技術詞可依選擇保留英文。命令、路徑、JSON key、變數、識別字、API、測試快照、機器可讀輸出**一律保留精確位元組**。
- 英文 Skill 或 Repo 規則可能明確要求英文產物；先尊重適用的硬性規範，標示衝突，不得暗中忽略。原文仍保留，面向使用者的說明可以繁體中文。
- 一份 Skill 如果提供了不同語言的**受信任且經版本控管的 Overlay**，可依 locale 載入；否則直接沿用原文並加語言提示。翻譯結果不是新的可執行 Skill。

### Skill Locale Overlay（輸出層，不改寫 Skill）

可為各 Skill 儲存獨立、可審核的 Metadata（示例，尚非已實作 Schema）：

```json
{
  "skillId": "code-review",
  "language": "zh-TW",
  "sourceHash": "<hash-of-original-SKILL.md>",
  "outputGuidance": "將審查意見與修正理由以臺灣繁體中文呈現；程式碼與引用原文保持不變。",
  "modifiesSource": false
}
```

僅在來源 Hash 相符、Overlay 獲授權且 Adapter 支援時套用；不得「自動翻譯後執行」未經驗證的操作步驟。

## 4. ACP／外部 Harness 相容性與能力狀態

ACP 的 `systemPrompt` 是**選用能力**，欄位位置在兩個版本不同（依 2026-11-17 讀到的公開規格文件；v1 這部分仍在 draft 目錄下）：

- v1 draft：Agent 在 `initialize` 回應的 `agentCapabilities.sessionCapabilities.systemPrompt` 宣告。
- v2：在 `capabilities.session.systemPrompt` 宣告。

AgentDock 的規則：

- **只有 Agent 宣告該能力時才送 `systemPrompt`**；語言 Overlay 一律用 `append`（把內容加到 Agent 自己的指示之後）。
- 不使用 `override`。它會取代 Agent 內建的預設指示，使用它的 Client 要自行承擔原本由預設指示提供的工具說明與安全指示；語言偏好沒有理由這麼做。規格也要求只有 Agent 另外宣告 `systemPrompt.mode.override` 時才可送出。
- Agent 無法套用時依規格必須回錯而不是默默忽略；AgentDock 要把這個結果記成 `unsupported`，不重試成一般 Prompt 後仍宣稱已套用。
- resume 時應送出與建立時相同的 `systemPrompt`；Agent 可以把變更延後到下一次重建 Prompt（例如 compaction 之後）才生效，所以 UI 必須顯示「已送出、尚未確認生效」而不是「已生效」。
- SDK Runtime（例如 Copilot SDK）只使用文件記載的指示 API，並追蹤設定是否真的被接受。
- 保留 Adapter 原生的認證、模型選擇與權限。

能力狀態（四態）：

| 狀態 | 說明 | Issue #18 的 UI 標示 |
| --- | --- | --- |
| `owned` | AgentDock 自行組裝 Prompt，可完整控制自身的輸出語言指示 | Fully applied |
| `confirmed` | 外部 Adapter 已宣告相關能力並確認接受語言指示 | Adapter supported |
| `best-effort` | 只能在一般 User Prompt 請求語言，不代表覆寫內部 System Prompt | Best effort |
| `unsupported` | Adapter 沒有適當能力，或拒絕設定 | Not supported |

這些狀態描述的是「指示有沒有合法送達」，不是語言成功率的承諾。能力必須從 Adapter 得知，不能從 Profile 推論。

## 5. 切換語言的生命週期

- **有效語言的快照**：Task/Session 開始時決定性地算出有效語言，並記錄政策版本（及可重現用的雜湊）；之後的事件與摘要都帶著它。
- **Global 變更**：UI 字串立即切換；新建立的 Task/Session 使用新的語言快照。
- **Project 變更**：新 Task/Session 繼承，既有 Session 使用原快照直到使用者選「從下一回合生效」。
- **Session 中途變更**：下一個 User Prompt 開始套用（若 Adapter 支援）；進行中的工具操作/模型呼叫不中斷、不重送。若不支援中途更新，提供**新 Session 套用**選項。不得回報成已追溯生效。
- **Task 單次指定語言**：例如「這份 README 請用英文」只覆蓋該產物；其餘仍以繁體中文回報。
- **Remote Worker**：派送任務時帶入 Policy Snapshot 與 Profile Version；離線重連後不可因本機改語言就默默改動仍在進行的遠端工作。
- **歷史紀錄**：原始文字與事件資料不因切換語言而遭重寫。可額外產生具來源標記的「繁體中文顯示摘要／翻譯」，並留存原文供比對；生成的摘要要記錄來源語言與政策版本，避免舊證據在切換語言後看起來像被重新撰寫。
- **安全審批與決策通知**：所見選項、操作目標與實際命令必須一致；翻譯不能改變批准的操作範圍、數量或風險等級。
- 切換語言不得為了改語言而修改 Repo 中受版本控管的使用者檔案，除非使用者明確要求。

## 6. UI 規格

- Settings → Language → **全流程語言**（繁體中文〔臺灣〕、English、專案預設）。
- UI 語言與 Agent 輸出可分開設定，並有「同步介面及工作流程語言」開關，以及一鍵「所有生成的敘述性內容都使用工作流程語言」。
- Project Settings → Language Overrides；Session Header 可快速檢查有效語言與能力支援狀態。
- Advanced → Artifact Languages：Issue、PR、Commit、Docs、Code comments、Review、Status、Notifications。
- Skills Explorer：每個 Skill 標記來源語言、是否有 Localization Overlay、指示原文與 Effective Locale、是否可能不符合選用語言。
- Agent Capability Badge：`owned`、`confirmed`、`best-effort`、`unsupported`（見第 4 節）。
- 顯示有效的 Context 分層，以及哪些可在地化、被覆寫、不支援或互相衝突。
- 缺少翻譯鍵時有穩定的 fallback 字串，不外露未在地化的狀態鍵。

## 7. Session Sentinel 與成本

Session Sentinel 使用 **Event-driven** 摘要；切換語言、打開通知或 UI polling 不應產生任何額外 LLM 呼叫。

- 狀態 enum、優先級與 Decision 類型保持語言中立。
- 中文／英文短摘要優先由本地 Template 決定性產生；僅在事件有變化時才重新生成。
- 原始錯誤、Diff、CI Log 以原文顯示並可展開；譯文只作附加解釋。
- 複雜翻譯或摘要需要模型時，須具備明確的權限、成本上限、去識別化的有限上下文、來源標記，以及 Cache Key（`eventId + locale + policyVersion`）。
- 總成本應統計每次額外摘要／翻譯呼叫；不得把「中文化」當成零成本承諾。

## 8. 安全與正確性限制

1. 不因翻譯而修改已簽名第三方 Skills 或其 Shell 命令；不執行翻譯後內容。
2. 任何引用原始 Log、CLI、CI、堆疊、SQL、JSON、YAML、Patch、正則表達式、程式碼與技術常數，都必須保留原樣（可在旁邊另寫繁中解釋）。
3. Project/AGENTS.md/CLAUDE.md 的明確程式碼規範不可被全域 Locale 偷偷改寫。
4. Prompt 裡的語言政策是輸出偏好，不是可繞過安全、Git 或 Provider 的授權。
5. Context 來源與 Overlay 可追蹤，敏感資料不應因翻譯被送往未授權模型。
6. 多語 Prompt 增加 Token、破壞 Cache Prefix 的代價要衡量；Locale Overlay 儘量短小、固定且版本化。
7. Skill／Context 注入只限於已核可、受信任的指示；未信任的檔案與工具輸出一律當作資料。

## 9. 驗收與測試矩陣

以下都是**尚未達成**的驗收項目（原型目前只涵蓋 resolver 的優先序、未支援值、Skill 原文不變與四態能力）：

- [ ] 全域切成 `zh-TW`，UI、Plan、Review、Advisor、Subagent 結論、Issue/PR、通知、Session Sentinel 在受支援的 Adapter 上都使用臺灣慣用繁體中文。
- [ ] 切成 `en-US`，相同 Task 能正常輸出，同時不更動原有 Prompt/Skill 技術步驟。
- [ ] 全域 `zh-TW`、Project `en-US`、Session `zh-TW`、Task `en-US` 依既定範圍優先，無外洩到其他 Task；四層覆寫有單元測試與版本化 Snapshot。
- [ ] 英文 `SKILL.md` 與相關 Script 的雜湊在切換前後完全不變，但可讀說明使用繁體中文。
- [ ] Skills / Reviewer / Advisor / Subagents 在支援時繼承有效語言；不支援時 UI 明示、提供手動處理方式。
- [ ] GitHub Issue/PR 與 Code Review 繁體中文，但 `git`/CLI 命令、參數、JSON keys、file paths、Schema、Git Diff 無變動。
- [ ] Commit Message 和 Code Comments 可獨立維持英文，並符合 Repo Coding Standards。
- [ ] 切換中正在執行的 Session 不重新執行、重啟或重複付費；恢復後保留原快照。
- [ ] 原始英文 Log 可見、中文摘要可見，並有引用來源和錯誤處理，不捏造未測試結果。
- [ ] Mock ACP 涵蓋 v1 draft／v2 的 `systemPrompt` 宣告與未宣告、`append`、未宣告 `override` 時不送出、Agent 回錯、resume/compaction 延後生效，以及四種能力狀態的正確 UI 標示。
- [ ] 簡體與繁體中文的 fixture：未支援或格式錯誤的 Locale 標籤被拒絕，不被自動替換。
- [ ] 未經批准的 Tool/Repository 操作不受語言設定影響；Prompt injection、互相矛盾的專案規則、要求改寫的外部 `SKILL.md` 都不會讓權限或原文改變。
- [ ] Session Sentinel 的單純語言切換不產生模型請求。
- [ ] 端到端：Issue → Plan → Implement → Test → Review → PR → CI → Summary，中文／英文各一次，並有可引用的驗證證據。
- [ ] 語言導致模型成本、Cache 命中或回應品質改變時可由 Benchmark 比對，不能聲稱純靠設定就強制所有模型回覆正確語言。

## 10. 建議開發順序

下列後端項目都以 Rust 實作（ADR-0004），目前**都沒有任務包**；順序只是建議。

1. **UI 翻譯與設定畫面** — 已由 PR #24 合併到 main（React key-based catalog、設定選單、`localStorage` 持久化）；屬於前端預覽，尚未接後端。
2. **語言 Profile 與 resolver（Rust）** — 型別、範圍覆寫、未支援值的拒絕、政策版本；把參考原型與 `src/i18n/language.test.ts` 的情境移植成 Rust 測試，並透過 Tauri command 提供給前端。
3. **快照與事件** — Task/Session 開始時的語言快照與政策版本；需要先有契約增補（ADR-0003，獨立 PR）。
4. **Agent output control** — 在 `crates/acp` facade 上協商 `systemPrompt` 能力（#6），只在 Agent 宣告時以 `append` 送出 Overlay，並記錄四態能力狀態。
5. **Skills Localization Overlay** — Overlay Registry、來源雜湊比對、衝突檢測與術語表，兼顧來源不變性。
6. **Artifacts** — Issue/PR/Review/Commit/Docs 的獨立語言選項與輸出驗證。
7. **Session Sentinel** — 事件式繁體摘要、通知與決策操作（#15）。
8. **Fallback、Accessibility 與 E2E** — Adapter 不支援時的狀態、遠端重連、語言切換安全測試。

## 11. 尚未決定、需要與其他工作調和的地方

1. **預設語言：解析規則已對齊，內建預設設定尚未決定。** Issue #18 要求中文工作流程預設 `zh-TW`。解析規則的最後一步在 main 的前端（`resolveLocale`）與參考原型（`effectiveLanguage`）都是 `zh-TW`。但兩者在「使用者沒有任何設定」時的結果並不完全相同：前端會先套用內建的 `DEFAULT_SETTINGS`（Global 的 `outputs.commitMessage = en-US`、`outputs.codeComments = preserve-original`），所以 Commit Message 解析為 `en-US`；參考原型沒有內建預設，`effectiveLanguage({}, 'commitMessage')` 回 `zh-TW`。`examples/language-profiles/zh-TW.json` 的 `outputs.commitMessage = en-US` 對應的是前端那份內建預設。Rust 後端的內建預設要不要沿用前端這一份（Commit Message 預設英文），需要擁有者決定；在決定之前，不能把參考原型對空設定的輸出當成產品預設。
2. **UX 規格尚未跟上。** [UX 規格](../ux/README.md) 決策 10 仍寫「UI 文案先用英文、zh-TW 在地化作為後續」，並把時程列為待決；但 PR #24 已經把 zh-TW／en-US 切換合併進前端。UX 規格需要更新或由擁有者確認以哪一邊為準（UX 規格另有負責人，本文件不修改它）。
3. **單一實作來源。** 目前有兩份實作草稿，Rust 後端會是第三份，最後應以 Rust 後端為準。參考原型與前端的解析順序（兩輪）、解析規則最後一步的預設（`zh-TW`）、`artifactLocale`、四態能力名稱與能力欄位名（`ownedPromptComposer`、`acceptsLocaleInstructions`、`supportsUserPrompt`）一致，差異如下：
   - 內建預設設定：前端有 `DEFAULT_SETTINGS`（見上面第 1 點），讀取儲存資料時也會把它併入 Global；參考原型沒有內建預設，只處理呼叫端傳入的各層設定。
   - 未支援的值：參考原型在解析時丟出錯誤；前端在讀取儲存資料時靜默捨棄。`workflowLocale = inherit` 屬於這一類（參考原型拒絕，前端捨棄）。
   - 未知的輸出階段：參考原型丟出錯誤；前端的 `resolveLocale` 不檢查（型別上只接受已知階段），執行時傳入未知階段會落到 `workflowLocale`。
   - `languageCapability` 沒有傳入 adapter 時：參考原型回 `unsupported`；前端會丟出 `TypeError`。
   - `skillContext` 的參數順序與回傳欄位名不同（參考原型 `source`／`mutatesSource`，前端 `original`／`sourceUnchanged`）。
   - UI 語言：參考原型用 `effectiveLanguage(scopes, 'ui')`，前端用獨立的 `resolveUiLocale`。
   - 語言指示範本文字不同。
   - `preserve-original`：本規格只定義在 `outputs.codeComments`；兩份草稿對其他階段與 `artifactLocale` 也接受這個值。
4. **契約。** 語言快照、政策版本與能力狀態要不要、以及如何進入 ADR-0003 的契約，尚未決定。

## 12. 官方參考

- [Claude Code settings and instruction scopes](https://code.claude.com/docs/en/settings)
- [Claude Code skills and SKILL.md lifecycle](https://code.claude.com/docs/en/skills)
- [GitHub Copilot custom instructions](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions)
- [GitHub Copilot agent skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills)
- [ACP v1 session setup/capability negotiation](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP v1 draft session setup（`systemPrompt`）](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/draft/session-setup.mdx)
- [ACP v2 session setup（`systemPrompt`）](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/session-setup.mdx)
- [ACP client-system-prompt RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/client-system-prompt.mdx)
