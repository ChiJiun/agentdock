# AgentDock 全流程語言政策（Traditional Chinese–first Harness）

狀態：**已有獨立 JavaScript Locale Resolver 原型及測試；尚未接入 Rust ACP Host、React UI、實際 Agent**
日期：2026-11-17
追蹤：Issue #18（預定）；依賴 #3 Task/Session Contract、#6 ACP、#7 Event Store、#15 Session Sentinel

## 1. 目標

使用者可以在 Settings 的 **Language / 語言** 中切換 `繁體中文（臺灣）`、`English`、`依專案設定`，且設定的影響範圍**不只 UI 字串**，還包含可控制的整體開發工作流程：

- **使用者面向**：導覽列、權限對話框、錯誤說明、Session Timeline、摘要、提醒。
- **Agent 內容**：一般問答、計畫、任務分析、Advisor 諮詢、Subagent handoff、Review、測試結論、Done report。
- **開發產物**：Issue/PR 標題與內容、Review 意見、Commit Message、README/說明文件、變更紀錄、必要時程式碼註解。
- **指示來源**：Default/Project/Session/Task Prompt、AGENTS.md / CLAUDE.md / Copilot Instructions、Skills、工具輸出的後續摘要。

**語言的可控性必須如實揭露。** 不同外部 ACP Runtime 可能無法接受持久化的系統指令，也不一定提供可觀察的內部 Skill / Subagent 內容。AgentDock 不可宣稱已修改 Claude Code、Codex 或 Octomind 的私有上下文。

## 2. 四種層級與優先序

`Global → Project → Session → Task`，越靠近目前任務的**語言偏好**越優先。**但任何語言偏好都不得覆寫更高優先權的安全／工具權限／官方 API 契約或已存在的不可違反之專案限制**。

建議設定鍵：

| 鍵 | 作用 | 範例 |
| --- | --- | --- |
| `uiLocale` | Desktop 介面字串 | `zh-TW` |
| `workflowLocale` | 全流程人類可讀輸出 | `zh-TW` |
| `outputs.plan` | Plan/設計方案 | `inherit` |
| `outputs.review` | Review 與 CI 解讀 | `inherit` |
| `outputs.issue`、`pullRequest` | GitHub 產物 | `inherit` |
| `outputs.commitMessage` | Commit 命名 | `en-US`（團隊可另訂） |
| `outputs.documentation` | README、報告、ChangeLog | `inherit` |
| `outputs.codeComments` | 程式碼註解 | `preserve-original` 或 `zh-TW` |
| `outputs.sessionSummary`、`notification` | Session Sentinel 摘要與通知 | `inherit` |
| `outputs.skillExplanation` | Skills 執行結果說明與摘要 | `inherit` |

Locale 遵守 BCP 47 表示方式；MVP 支援 `zh-TW`、`en-US`。專案語言設定可覆寫全域、Task 明確語言要求又可覆寫專案偏好，但不更改安全限制。

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

- 對「可控 Native Agent」：使用明確的 Agent 語言指示層；Subagent、Advisor、Reviewer 各自繼承 Effective Profile；每個 Prompt 有來源和版本。
- 對「外部 ACP Agent」：先檢查 Provider/Adapter 是否有可用的語言設定／初始指示／Prompt 通道；有才施加支援的 Overlay，沒有則以**best effort** 透過一般 Prompt 傳遞，並在 UI 標示 `部分支援`。不得將傳一般 Prompt 包裝成「已修改 System Prompt」。
- **Prompt／Skills 原文是資料與原有操作需求**：只新增獨立 Locale Overlay，不直接覆寫或偷偷翻譯 `SKILL.md`、frontmatter、Shell Scripts、Python Scripts、MCP schema、Tool 命令。
- 先使用可維護的術語表：`worktree`、`rebase`、`token`、`cache`、`branch`、`GitHub Actions` 等技術詞可依選擇保留英文。命令、路徑、JSON key、變數、識別字、API、測試快照、機器可讀輸出**一律保留精確字節**。
- 英文 Skill 或 Repo 規則可能明確要求英文產物；先尊重適用的硬性規範，標示衝突，不得暗中忽略。原文仍保留，面向使用者的說明可以繁體中文。
- 一份 Skill 如果提供了不同語言的**受信任且經版本控管的 Overlay**，可依 locale 載入；否則直接沿用原文並加語言提示。翻譯結果不是新的可執行 Skill。

## 4. 切換語言的生命週期

- **Global 變更**：UI 字串立即切換；新建立的 Task/Session 使用新的語言快照。
- **Project 變更**：新 Task/Session 繼承，既有 Session 使用原快照直到使用者選「從下一回合生效」。
- **Session 中途變更**：下一個 User Prompt 開始套用（若 Adapter 支援）；進行中的工具操作/模型呼叫不中斷、不重送。若不支援，提供**新 Session 套用**選項。
- **Task 單次指定語言**：例如「這份 README 請用英文」只覆蓋該產物；其餘仍以繁體中文回報。
- **Remote Worker**：派送任務時帶入 Policy Snapshot 與 Profile Version；離線重連後不可因本機改語言就默默改動仍在進行的遠端工作。
- **歷史紀錄**：原始文字與事件資料不因切換語言而遭重寫。可額外產生具來源標記的「繁體中文顯示摘要／翻譯」，並留存原文供比對。
- **安全審批與決策通知**：所見選項、操作目標與實際命令必須一致；翻譯不能改變批准的操作範圍、數量或風險等級。

## 5. UI 規格

- Settings → Language → **全流程語言**（繁體中文〔臺灣〕、English、專案預設）。
- UI 語言與 Agent 輸出可分開設定，並有「同步介面及工作流程語言」開關。
- Project Settings → Language Overrides；Session Header 可快速檢查有效語言與能力支援狀態。
- Advanced → Artifact Languages：Issue、PR、Commit、Docs、Code comments、Review、Status、Notifications。
- Skills Explorer：每個 Skill 標記來源語言、是否有 Localization Overlay、指示原文與 Effective Locale、是否可能不符合選用語言。
- Agent Capability Badge：`Native support`、`Best effort`、`Unsupported`（不是語言成功率承諾）。
- Session Sentinel：所有摘要以 Profile 語言呈現，保留技術證據原文與連結；僅有事件變化才重新生成摘要。

## 6. 安全與正確性限制

1. 不因翻譯而修改已簽名第三方 Skills 或其 Shell 命令；不執行翻譯後內容。
2. 任何引用原始 Log、CLI、CI、堆疊、SQL、JSON、YAML、Patch、正則表達式、程式碼與技術常數，都必須保留原樣（可在旁邊另寫繁中解釋）。
3. Project/AGENTS.md/CLAUDE.md 的明確程式碼規範不可被全域 Locale 偷偷改寫。
4. Prompt 裡的語言政策是輸出偏好，不是可繞過安全、Git 或 Provider 的授權。
5. Context 來源與 Overlay 可追蹤，敏感資料不應因翻譯被送往未授權模型。
6. 多語 Prompt 增加 Token、破壞 Cache Prefix 的代價要衡量；Locale Overlay 儘量短小、固定且版本化。

## 7. 驗收與測試矩陣

- [ ] 全域切成 `zh-TW`，UI、Plan、Review、Issue/PR、Session Sentinel 都使用臺灣慣用繁體中文。
- [ ] 全域 `zh-TW`、Project `en-US`、Session `zh-TW`、Task `en-US` 依既定範圍優先，無外洩到其他 Task。
- [ ] 英文 `SKILL.md` 的命令、metadata、程式碼與第三方原文雜湊完全不變，但可讀說明使用繁體中文。
- [ ] Skills / Reviewer / Advisor / Subagents 在支援時繼承有效語言；不支援時 UI 明示、提供手動處理方式。
- [ ] GitHub Issue/PR 與 Code Review 繁體中文，但 `git`/CLI 命令、參數、JSON keys、file paths 無變動。
- [ ] Commit Message 和 Code Comments 可獨立維持英文，並符合 Repo Coding Standards。
- [ ] 切換中正在執行的 Session 不重新執行、重啟或重複付費；恢復後保留原快照。
- [ ] 原始英文 Log 可見、中文摘要可見，並有引用來源和錯誤處理，不捏造未測試結果。
- [ ] 在 CI/mock adapter 驗證 locale support 的 `native/best-effort/unsupported` 三種顯示。
- [ ] 語言導致模型成本或回應品質改變時可由 Benchmark 比對，不能聲稱純靠設定就強制所有模型回覆正確語言。

## 8. 建議開發順序

1. **P0：語言 Profile Contract** — 版本化、resolver、scope override 和可測試的 Context Overlay（先不啟動真 Agent）。已提供 `prototypes/language-policy/resolve.mjs` 與 `examples/language-profiles/zh-TW.json`、`en-US.json` 作為 API 契約原型。
2. **P0：UI 翻譯** — React key-based catalog（繁體中文＋英文）、設定選單、選取與持久化。
3. **P0：Agent output control** — #6 ACP Adapter 協商能力、#7 Session Snapshot，支援的 Provider 導入 Locale Overlay。
4. **P1：Skills Localization Overlay** — 對 Skill/Prompt/Reviewer/Advisor 的多語顯示層與術語表，兼顧來源不變性。
5. **P1：Artifacts** — Issue/PR/Review/Commit/Docs 的獨立語言選項與輸出驗證。
6. **P1：Session Sentinel** — 事件式繁體摘要、通知與決策操作。
7. **P1：Fallback、Accessibility 與 E2E** — 適配器不支援的狀態，遠端重連，語言切換安全測試。

## 9. 官方參考

- [Claude Code settings and instruction scopes](https://code.claude.com/docs/en/settings)
- [Claude Code skills and SKILL.md lifecycle](https://code.claude.com/docs/en/skills)
- [GitHub Copilot custom instructions](https://docs.github.com/en/copilot/concepts/prompting-and-context/custom-instructions)
- [GitHub Copilot agent skills](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills)
- [ACP v1 session setup/capability negotiation](https://agentclientprotocol.com/protocol/v1/session-setup)
