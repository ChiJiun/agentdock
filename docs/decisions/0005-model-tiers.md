# ADR-0005: 模型等級（Model tiers）

Date: 2026-11-27
Status: Proposed。擁有者核准 PR 後才轉為 Accepted；等級對應表與事件型別在 [open question 1](#open-questions-owner-decision-needed) 查證完成前都只是暫定。

> 本 ADR 只定義詞彙與規則，**不改任何程式碼、契約 schema 或任務包檔案**。研究依據見 [coding-harness-comparison.md](../research/coding-harness-comparison.md)（讀取日 2026-11-27）。文中「推論」代表本 ADR 的判斷，不是任何廠商或來源的原文。

## Context

- AgentDock 透過 ACP 驅動 Claude Code、Codex 等外部 agent。外部 agent 擁有自己的 prompt loop、模型使用與內部工具；ACP 能力依 adapter 協商，AgentDock 不承諾覆寫不透明的模型路由（[architecture.md](../architecture.md) 的 External ACP agents 段）。
- [PRD](../PRD.md) 要求「角色式（executor／explorer／advisor／reviewer／progress）模型設定」與「先手動 advisor、再有政策約束的自動升級，不得無界遞迴或重試」。[Issue #13](https://github.com/ChiJiun/agentdock/issues/13) 負責實作；本 ADR 提供它缺少的詞彙。
- 「等級」在各家產品裡至少有三種不同意思，混在一起會誤導：**推理強度（effort）**（Claude Code `low`～`max`；Codex Light～Ultra；Grok Build `reasoning_effort`）、**編排強度**（Codex Ultra 會用 subagents 平行拆工作；Claude Code 的 `ultracode` 觸發 dynamic workflow；Copilot Fusion 的 Cascade／Critique）、**權限等級**（決定 agent 能做什麼，與模型強弱無關）。逐項來源見研究文件「模型選擇的等級區分」一節。
- 證據指向「便宜模型做探索、強模型做判斷」，也指向「在邊界換模型、不要在 session 中途換」，因為兩家官方都把換模型列為會破壞 prompt cache 的操作；Anthropic 的 postmortem 則說明把實作預設降到較低 effort 是錯誤的取捨。
- 目前有兩個地方各自講模型建議：產品導航（尚未實作）與 `docs/tasks/` 任務包（[PR #68](https://github.com/ChiJiun/agentdock/pull/68)，尚未合併）以 `S`／`S/R`／`St` 標記。兩者需要共用同一套詞彙，人類、AgentDock 與實作 agent 才不會各說各話。

## Decision

### 1. 三個互相獨立的軸

| 軸 | 值 | 決定什麼 | 不決定什麼 |
| --- | --- | --- | --- |
| **能力等級（tier）** | `T-default`、`T1`～`T4`（下節） | 模型能力與成本檔位 | 是否開多個 agent、agent 能做哪些操作 |
| **編排（orchestration）** | `single`、`parallel` | 是否為同一任務開多個 agent（best-of-N、critique、agent 自己的 subagent／workflow） | 單一 agent 的推理強度 |
| **權限（permission）** | 沿用 [Issue #8](https://github.com/ChiJiun/agentdock/issues/8)／[#40](https://github.com/ChiJiun/agentdock/issues/40) 的核准詞彙；預設 Ask | agent 能做什麼、何時問人 | 模型強弱 |

規則：

- `parallel` 必須是獨立的開關，UI 要明示「會開多個 agent、成本倍增」，**不得藏在 T4 裡**。Codex 的 Ultra、Claude Code 的 `ultracode` 屬於編排軸，不是 T4 的同義詞。
- 提高 tier 不會提高 permission。外部來源（任務包、issue 內容、agent 輸出）只能要求降級，不能要求升級；引擎不支援某權限模式時不得靜默放寬（沿用 #8／#40 與研究文件的權限等級借鏡項目）。
- 權限軸的細節（各 agent 原生模式映射）不在本 ADR 範圍，由研究文件中的建議新 issue「統一權限等級與各 agent 原生模式映射」處理。

### 2. 等級 ID

等級 ID 是穩定的抽象名稱；具體模型與 effort 在執行期決定（第 4 節）。

| 等級 | 名稱 | 意圖 | 典型角色與任務（推論） | 相對成本提示 |
| --- | --- | --- | --- | --- |
| `T-default` | 跟隨 agent 預設 | 不干預外部 runtime 的調校 | 沒有特別理由時的所有 session | 依 agent |
| `T1` | 輕量 | 快、便宜、可大量平行 | scout、檔案搜尋、摘要、分類、commit 訊息草稿、進度回報 | 低 |
| `T2` | 標準 | 日常實作的甜蜜點 | 規格明確的小改動、測試修補、文件 | 中 |
| `T3` | 深入 | 需要推理與跨檔理解 | 跨檔重構、除錯、規劃、獨立 review | 高 |
| `T4` | 極限 | 少量、關鍵、可接受慢與貴 | 架構決策、難解 bug、合併前最終把關 | 很高 |

- **預設是 `T-default`**，不是某個具體等級。理由：各家 effort 預設值會隨模型世代改變（研究筆記記錄 Opus 4.7 的預設為 `xhigh`、5.5 世代為 `medium`），AgentDock 替使用者覆寫會變成「暗中改 agent 的 effort」，而 Anthropic 的 postmortem 顯示 harness 層的小改動就會造成可感知的品質變化。**使用者明確選擇某一等級是例外**，且選擇要寫進事件。
- 成本提示只用「低、中、高、很高」四個相對檔位。不換算金額，不顯示剩餘額度（見第 9 節）。
- 下列對應只是 **2026-11-27 的現況範例，不是規格**；任何具體模型名稱都不得寫死在 UI 或任務包。

| 等級 | Claude Code 範例（推論） | Codex 範例（推論） |
| --- | --- | --- |
| `T1` | 最小可用模型（如 Haiku 5.5）或 Sonnet 5.5 搭 `low` | 預設模型搭 Light |
| `T2` | Sonnet 5.5 搭 `medium` | 預設模型搭 Medium |
| `T3` | Opus 5.5 搭 `high` 或 `xhigh` | 預設模型搭 High 或 Extra High |
| `T4` | agent 回報的最強模型搭 `max` | agent 回報的最強模型搭 Max（**不是** Ultra） |

Fable 系列、Codex 的 Sol／Astra／Luna／Terra 在研究中沒有可靠的相對能力與價格證據，因此**不固定在任何一級**，由使用者或對應表決定。

### 3. 導航與任務包共用同一套等級

**產品導航（模型選擇器、角色預設）與 `docs/tasks/` 任務包給實作者的模型建議，共用本 ADR 的等級 ID，不得各自發明另一套。** 任務包（與日後的 task／session 設定）使用下列欄位：

| 欄位 | 值 | 說明 |
| --- | --- | --- |
| `tier` | `T-default`、`T1`～`T4` | 能力等級 |
| `role` | `scout`、`implementer`、`reviewer`、`lead` | `scout` 約等於 PRD 的 explorer、`implementer` 約等於 executor；`lead` 是規劃角色；PRD 的 advisor、progress 在 #13 定案時再對應 |
| `orchestration` | `single`、`parallel` | 預設 `single` |
| `permission` | 建議的權限上限 | 預設 Ask |
| `reason` | 一句話 | 為什麼選這一級（例如「規則表要逐條對照 schema」） |

推論：同一個任務包通常有兩列——implementer 一列、reviewer 一列。這比單一記號更能表達「實作者與 reviewer 不同級」。

### 4. 執行期解析

1. AgentDock 從 agent 回報的資料取得它**實際提供**的模型清單與可調整的設定（若 adapter 有暴露；見 open question 1），記錄在 `CapabilitySnapshot` 的**加法式**欄位。本 ADR 不修改現有 schema；[acp-capabilities.md](../contracts/acp-capabilities.md) 目前把 `config_option_update` 列為 v1 契約之外、之後可作為新事件型別加入。
2. 每個 agent 有一份「等級→{模型, effort}」對應表。建議放在使用者層級的 app data，**不從 repo 讀取**，理由與 adapter 設定相同：agent 能改 repo，對應表不能讓 agent 影響。預設值只當範例出貨，使用者可改。
3. 解析結果必須是 agent 回報的清單中**確實存在**的組合；不存在的組合視為「此等級不可用」。
4. 若 agent 完全不暴露模型或 effort 的設定方式，UI 顯示「此 agent 無法由 AgentDock 設定，請在 agent 端調整」，session 以 `T-default` 執行並記錄 `requested_tier` 與原因；**不假裝生效**。

### 5. 降級，不升級

- 所要求的等級不可用時，只能往較低且可用的等級找（`T4→T3→T2→T1`）。找到時以該等級啟動，並寫一筆事件，內容至少含 `requested_tier`、`effective_tier`、具體 model／effort（已遮蔽）、原因。
- 找不到任何不高於要求的可用等級時，**停下來問使用者**，不靜默改用 `T-default`（agent 預設可能比要求的更貴）。
- 任何情況都不自動升級到較高等級、較高成本或較高權限。

### 6. 自動升級留到 V2

V1 只有手動選擇。V2 才允許「政策約束的自動升級」（例如 `T2` 連續兩次測試失敗才升到 `T3`），且必須：有次數上限、每次升級寫事件並在 timeline 可見、可由使用者關閉、不提高權限軸、不遞迴。這與 PRD 的 V1.x 描述一致，並由 #13 實作。

### 7. 中途換等級是成本事件

- 等級在 session 建立時選定。
- session 中途改等級或改 effort 時，UI 必須先提示「這可能會重建 prompt cache（成本與延遲上升）」，並建議改開子 session 或 reviewer session 承接。依據：Claude Code 官方文件把切換模型、在多數模型上切換 effort 列為會讓快取失效的操作；OpenAI 的 Codex agent loop 文章說明中途改模型、sandbox 或 approval mode 會破壞快取。各 agent 的實際行為以該 agent 為準，AgentDock 只負責提示，不攔截。
- 每次改動寫成事件。

### 8. 不做隱藏路由

AgentDock 不得在使用者不知情下替 session 選模型。若日後做任何自動路由（含第 6 節的自動升級），選中的等級與具體模型必須寫入 timeline。Grok Bot 那種使用者無法選擇、團隊 allowlist 也不適用的路由方式，與 AgentDock「no hidden model interception」的原則衝突。

### 9. 用量與成本顯示

- 只在能量測時顯示 token 與（API key 情境下的）金額。
- 訂閱登入時顯示「額度未知」，不換算成假的金額或剩餘額度；與 [ADR-0003 §7](0003-task-session-event-contracts.md) 與 PRD 一致。#43 的上限與「unavailable 而非 0」規則直接適用。

### 10. 角色預設（建議，使用者可改）

| 角色 | 建議預設 | 理由（推論） |
| --- | --- | --- |
| scout、摘要、進度回報 | `T1` | 探索量大、判斷少；Copilot 的遷移數據顯示 tool call 以探索為主 |
| implementer | `T-default` 或 `T2` | postmortem 提醒實作不能為了省錢預設壓到 `T1` |
| 規劃（lead）、reviewer | `T3` | LangChain 的「規劃與驗證用高 reasoning、執行用中等」 |
| 合併前最終把關、難解 bug | `T4`，需使用者明確選擇 | 成本很高 |

另一條建議：**reviewer 的等級不低於 implementer，或改用不同廠商的 agent**，避免同一模型自己檢查自己。這是預設而非硬性規則（open question 5）。

## 與 PR #68 任務包記號的對應

[PR #68](https://github.com/ChiJiun/agentdock/pull/68)（尚未合併，**本 PR 不修改它的任何檔案**）在 `docs/tasks/README.md` 以三個記號標示每個任務包的模型：

- `S`：standard model is enough
- `S/R`：standard model implements, strong model reviews
- `St`：strong model implements and reviews

這三個記號是「實作者＋reviewer」的複合記號，沒有指定具體模型，也沒有編排與權限欄位。對應如下（**推論**，需 PR #68 作者確認；#68 的 `standard`／`strong` 沒有給量化定義）：

| #68 記號 | implementer | reviewer | orchestration／permission | 備註 |
| --- | --- | --- | --- | --- |
| `S` | `T2` | 無額外要求；沿用任務包 §12 的 reviewer checklist | `single`／Ask | `standard` 視為**下限** `T2`。若實際用較弱模型（例如經 MCP 操作 Linux VM 的小模型），應在 `reason` 寫明 |
| `S` 並註明「某一節由 strong model 審查一次」（例如 P1-2 的 CSP 與 capability、P2-2 的規則表） | `T2` | 該節 `T3`，只審查指定段落 | `single`／Ask | `reason` 寫明審查範圍 |
| `S/R` | `T2` | `T3` | `single`／Ask | reviewer 高於 implementer，符合第 10 節 |
| `St` | `T3` | `T3`（fresh session，或不同 agent） | `single`／Ask | `strong` 預設對應 `T3`；只有任務包明寫理由才用 `T4` |
| `P3-5` 這類「a 用 `S`、b 用 `St`」的拆分 | 分別依上列各自對應 | | | 每個子 PR 各一列 |

後續（**不在本 PR**）：#68 合併後，另開 PR 把各任務包的「§10 Model tier」與 README 的 Tier 欄改寫為上節的欄位，過渡期兩種寫法並存。除 #68 本身外，需要同步改動的檔案與文件列在研究文件的「後續待更新」。

## Alternatives considered

1. **在 UI 與任務包直接寫模型名稱（Opus、Sonnet 等）**：模型名稱變動快、跨 agent 不通用，且文件會很快過期。否決。
2. **只用 effort 一個軸**：各家 effort 的意義不同，Codex 的 Ultra 甚至已經包含編排，會把模型選擇、推理強度與平行度混成一個數字。否決。
3. **沿用 PR #68 的 `S`／`St` 當產品詞彙**：沒有 reviewer 與 implementer 的區分、沒有最低與最高檔、無法由 UI 解析。否決，改以第 3 節欄位取代，並提供對應表。
4. **自動路由（Grok Bot、Copilot Fusion 式）**：與「不得隱藏模型攔截」衝突。V2 的有界自動升級是其中受限的子集。
5. **只提供 `T-default`（完全不提供等級）**：無法表達「scout 用便宜模型、reviewer 用強模型」，也就無法回應 #13 的角色路由需求。否決。

## Consequences

- 人類、UI 與任務包使用同一套詞彙；`tier` 欄位可被機器解析，之後可以寫檢查。
- 需要維護各 agent 的對應表；對應表過期時，退化路徑是「此等級不可用」而不是選錯模型。
- 若 `claude-agent-acp` 或 `codex-acp` 不暴露模型／effort 設定，等級在這兩個 agent 上只能是顯示用途（UI 顯示無法設定）。這是**誠實的降級**，不是 bug。
- 四個等級是折衷：各家有 3～6 個 effort 值，部分值（例如 `minimal`、Codex 的 Light 與 Medium 之間）無法一對一表達。
- 事件型別（第 5、7 節）需要在 #13 或契約增補時定義；本 ADR 不修改 `docs/contracts/`。

## Open questions (owner decision needed)

1. **`claude-agent-acp` 與 `codex-acp` 是否暴露 model／effort 的 config options？尚未查證。**
   研究筆記只證實 Grok Build 以 ACP `configOptions` 暴露 `model` 與 `reasoning_effort`、以 `session/set_config_option` 調整並以 `config_option_update` 廣播；這兩個 adapter 沒有查證。**查證方法**：
   1. 讀 adapter 的原始碼與 README（鎖定要支援的版本與 commit），搜尋 `configOptions`、`set_config_option`、`session/set_model`、`session/set_mode`，以及 `session/new` 回應中的 `models`／`modes` 欄位。
   2. 在擁有者已登入的機器上，用相容性測試（[PR #68](https://github.com/ChiJiun/agentdock/pull/68) 的 P3-6 規劃的 opt-in E2E 可重用，合併前先用一次性的小腳本）對兩個 adapter 各送 `initialize` 與 `session/new`（工作目錄用空的暫存資料夾），逐字記錄回應中與模型、effort、mode 相關的欄位（先遮蔽 token 與路徑）。
   3. 對一個一次性 session 以列出的值呼叫 `session/set_config_option`，確認有沒有 `config_option_update`、之後的 `session/prompt` 是否生效；不要用真實訂閱額度跑長任務。
   4. 結果寫入 [acp-capabilities.md](../contracts/acp-capabilities.md) 的相容性紀錄（或 #6／#42 的矩陣）；未查證前，UI 一律顯示「無法由 AgentDock 設定」。
   此項建議以新 issue 追蹤（見研究文件的「建議新 issue」），在查證前本 ADR 不應轉為 Accepted。
2. 四個等級與命名是否足夠？`T4` 是否需要每次使用者確認（因為成本很高）？
3. 對應表放在使用者層級設定檔，還是整合進能力快照？是否隨附預設值？
4. 事件型別與契約增補（`requested_tier`／`effective_tier`、降級、中途改動）由誰在何時加入 ADR-0003 的 schema？
5. 「reviewer 不低於 implementer」是預設還是硬性規則？同廠商、不同 session 算不算獨立，是否讓使用者自行設定？
6. 任務包欄位的語法（表格或 YAML front matter）與「#68 合併後改寫任務包」由誰負責。
7. 若某 agent 的 effort 值本身包含編排（例如 Codex Ultra），UI 如何防止使用者在等級選擇器裡誤選？（草案：只在 `orchestration=parallel` 開關下才可選，並顯示成本倍增警告。）

## Acceptance (before Accepted)

- Open question 1 查證完成並記錄。
- 擁有者核准本 PR。
- [Issue #13](https://github.com/ChiJiun/agentdock/issues/13) 的規格段落引用本 ADR，並以它為模型等級的單一來源。
- #68 合併後的任務包改寫另案處理，不阻擋 Accepted。

## References

- 研究文件：[coding-harness-comparison.md](../research/coding-harness-comparison.md)（等級證據、切換時機、反例與全部來源 URL）。
- 相關 issue：[#13](https://github.com/ChiJiun/agentdock/issues/13)（角色路由與升級）、[#43](https://github.com/ChiJiun/agentdock/issues/43)（用量上限）、[#6](https://github.com/ChiJiun/agentdock/issues/6)、[#42](https://github.com/ChiJiun/agentdock/issues/42)（ACP 相容性）、[#8](https://github.com/ChiJiun/agentdock/issues/8)、[#40](https://github.com/ChiJiun/agentdock/issues/40)（權限與核准詞彙）。
- 契約：[ADR-0003](0003-task-session-event-contracts.md)（§5 能力偵測、§7 用量與額度）。
- 讀取日 2026-11-27 的主要外部來源：[Claude Code Model configuration](https://code.claude.com/docs/en/model-config)、[Claude Code Prompt caching](https://code.claude.com/docs/en/prompt-caching)、[Codex Models](https://learn.chatgpt.com/docs/models)、[Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)、[Copilot Fusion](https://docs.github.com/en/copilot/concepts/models/copilot-fusion)、[Anthropic April 23 postmortem](https://www.anthropic.com/engineering/april-23-postmortem)。
