# AgentDock：繁體中文 Harness 與全流程語言切換規格

**狀態：Specification — 尚未接入實際 Agent Runtime**
**日期：2026-11-17**
**追蹤：[Issue #18](https://github.com/ChiJiun/agentdock/issues/18)**

## 產品承諾與不能承諾的部分

AgentDock 應讓使用者切換整個工作流程的預設輸出語言：`zh-TW`（臺灣繁體中文）或 `en-US`（美式英文）。範圍包含 Desktop UI、Task/Session、預設 Prompt、Advisor、Subagent、Review、Skills 執行說明、GitHub Issues/PRs、CI 分析、Session Sentinel 摘要及通知。

**不等於翻譯所有 Context 內容。** 不應修改原始 `SKILL.md`、`AGENTS.md`、`CLAUDE.md`、命令、程式碼、API Schema、原始日誌與外部文件。必要時將使用者可讀的解釋切換語言，保留精確的原始證據。對不支援自訂指示的外部 Harness，只能 best-effort，不能假裝能覆寫其隱藏 System Prompt。

## 1. 選擇器與作用範圍

| 設定 | zh-TW | en-US | 生效範圍 |
| --- | --- | --- | --- |
| `uiLocale` | 繁體中文 UI | English UI | 導覽列、按鈕、通知、錯誤與狀態 |
| `workflowLocale` | 以臺灣繁體中文解釋與報告 | Use English for user-facing prose | Agent、Plan、Review、Advisor、Subagents、Skills 執行摘要 |
| `artifactLocale` | 預設繁體中文文件、Issue、PR | English prose in generated artifacts | 設計文件、Commit Message、PR/Issue、報告；可按類型覆寫 |
| `sourceLocale` | 不因 UI 語言切換而改寫 | 不因 UI 語言切換而改寫 | 程式碼、原始證據、既有專案資料 |

**優先順序：明確 Task 要求 > Session > Project > Global**，只影響「語言偏好」，不凌駕安全、Tool、權限、Repo 既有硬性規則。使用者應可一鍵設定「整個工作流程使用繁體中文」，但允許例外，例如 Commit Message 英文、程式碼註解跟隨 Repo 規範。

## 2. 建議配置模型（示例，尚非已實作 Schema）

```json
{
  "version": 1,
  "uiLocale": "zh-TW",
  "workflowLocale": "zh-TW",
  "artifactLocale": "inherit",
  "outputs": {
    "plans": "inherit",
    "review": "inherit",
    "skills": "inherit",
    "issue": "inherit",
    "pullRequest": "inherit",
    "commitMessage": "en-US",
    "documentation": "inherit",
    "codeComments": "preserve-original",
    "sessionSummary": "inherit",
    "notifications": "inherit"
  }
}
```

Locale 以 BCP 47 表示法儲存，第一版只需 `zh-TW`／`en-US`。使用 enum 與型別化狀態，讓翻譯只影響顯示，不影響資料庫中的 Task State、事件種類及 Policy 識別字。

## 3. Trusted Context Composer

```text
Task objective & approved constraints
     ├─ Host-owned safety / approval / sandbox policy
     ├─ Executor / Explorer / Advisor / Reviewer role instructions
     ├─ Effective Language Policy (zh-TW / en-US)
     ├─ Original Skills + separately approved Locale Overlays
     ├─ Project instructions (AGENTS.md / CLAUDE.md), original bytes preserved
     ├─ Allowed tool schemas / MCP context
     └─ Snapshot: locale + policy version + source + applied state
                       ↓
            Supported Agent Adapter / owned model loop
```

這是 AgentDock **自有 Context 組裝流程**的邏輯層次，不代表外部 Agent 的 System Prompt 權限；不得將 Repo 文件或未信任工具輸出偷偷提升成 System 指令。

### 語言規則範本

`zh-TW` 提示內容（示例）：

> 面向使用者的說明、規劃、問題分析、審查、完成報告、決策摘要及預設敘述性產物，請使用臺灣慣用繁體中文。保留程式碼、識別字、CLI 指令、路徑、API 欄位、原始日誌與引文原文。尊重明確的任務語言要求與專案的必要規範；不得以語言偏好覆蓋安全政策或省略驗證。

`en-US` 等值範本：

> Use US English for user-facing plans, explanations, reviews, completion reports, decision summaries and prose artifacts. Preserve code, commands, identifiers, paths, API keys, quoted evidence and raw logs exactly. Honor explicit task requirements and project constraints; changing language never changes permissions or verification requirements.

兩份範本需為版本化且短小的 Host-owned Policy；所有角色使用同一個 Resolved Policy，而不是各 Skill 自行猜測使用者的語言。

### Skill Locale Overlay（輸出層，不改寫 Skill）

原始 `SKILL.md` 及其 Script／Schema 一律保持不變。可為各 Skill 儲存獨立、可審核的 Metadata，例如：

```json
{
  "skillId": "code-review",
  "language": "zh-TW",
  "sourceHash": "<hash-of-original-SKILL.md>",
  "outputGuidance": "將審查意見與修正理由以臺灣繁體中文呈現；程式碼與引用原文保持不變。",
  "modifiesSource": false
}
```

僅在來源 Hash 相符、Overlay 獲授權且 Adapter 支援時套用；不得「自動翻譯後執行」未經驗證的操作步驟。英文 Skill 可以保留執行程序英文，但使用者看到的 Summary 以繁體中文呈現。

## 4. ACP／外部 Harness 相容性

ACP v1 draft / v2 描述可選的 `systemPrompt` 功能。**只有在 Adapter 宣告支援時才能傳送**；`append` 與 `override` 必須依能力限制使用。不同 Adapter 對 resume/compaction 後 Prompt 更新的生效時間可能不同，必須顯示真實狀態。<https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/session-setup.mdx>

| 狀態 | 說明 |
| --- | --- |
| `owned` | AgentDock 自行組裝 Prompt，可完整控制自身的輸出語言指示 |
| `confirmed` | 外部 Adapter 已廣告相關能力並確認接受 Locale 指示 |
| `best-effort` | 只能在一般 User Prompt 請求語言，不代表覆寫內部 System Prompt |
| `unsupported` | Adapter 沒有適當能力，或拒絕設定 |

切換時：UI 立即變更；進行中的工具不重送；新 Prompt 在下一安全邊界套用；若外部 Session 不支援中途更新，提示建立新的 Session。不要追溯改寫歷史結果。遠端 VM Worker 必須使用派送時的 Locale Snapshot，不能受本機 UI 後續改語言的副作用影響。

## 5. Session Sentinel 與成本

Session Sentinel 使用 **Event-driven** 摘要；切換語言、打開通知或 UI polling 不應產生任何額外 LLM 呼叫。

- 狀態 enum、優先級與 Decision 類型保持語言中立。
- 中文／英文短摘要優先由本地 Template 產生。
- 原始錯誤、Diff、CI Log 可展開查看，譯文只作附加解釋。
- 複雜翻譯或摘要需要模型時，須具備明確的權限、成本限制、去識別化與 Cache Key（`eventId + locale + policyVersion`）。
- 總成本應統計每次額外摘要／翻譯呼叫；不得把「中文化」當成零成本承諾。

## 6. 驗收標準

- [ ] 全域繁體中文：UI、Plan、Review、Advisor、Subagent 結論、Issue/PR、通知、Skills 執行說明在受支援的 Adapter 上均為臺灣繁體中文。
- [ ] 英文切換：相同 Task 能在 `en-US` 正常輸出，同時不更動原有 Prompt/Skill 技術步驟。
- [ ] Task/Session/Project/Global 四層覆寫有單元測試與版本化 Snapshot。
- [ ] 原始 Skill 與相關 Script Hash 在切換前後一致。
- [ ] Raw CLI、程式碼、Schema、Log、Git Diff 的原始內容一律不更動。
- [ ] Mock ACP 能覆蓋 systemPrompt supported/unsupported、append/override、compaction 延遲，以及最佳努力模式的正確 UI 標示。
- [ ] 未經批准的 Tool/Repository 操作不受語言設定影響。
- [ ] Session Sentinel 的單純翻譯切換不產生模型請求。
- [ ] 端到端工作流程：Issue → Plan → Implement → Test → Review → PR → CI → Summary，中文／英文各一次，並有可引用驗證證據。

## 7. 建議實作順序

1. i18n dictionaries + LanguageProfile Resolver + UI 設定/持久化（無模型 API）。
2. Host-owned Prompt Templates（各角色）+ 語言政策快照。
3. ACP Capability negotiation + user-turn best-effort / confirmed 支援狀態。
4. Skill Locale Overlay Registry + 衝突檢測。
5. GitHub SDLC 和 Session Sentinel 的雙語生成與 E2E 測試。

**已完成狀態：** 本文件和 GitHub Issue #18 是實作規格。前端設定、Rust/ACP 的實際語言注入及 Skills 完整雙語流程仍需後續 PR 實作。
