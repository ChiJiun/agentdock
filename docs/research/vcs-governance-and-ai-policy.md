# 版本控制、合併流程與 AI 貢獻政策：借鏡大型專案治理，補上 AgentDock 的人類責任缺口

Status: 研究文件（供規劃使用；**尚未**被擁有者採納為決策）· 讀取日 **2026-11-27** · 本文件與所屬 PR **不改任何程式碼、契約、AGENTS.md、PR 範本、ruleset 或其他設定檔**。
Related: [ADR-0003](../decisions/0003-task-session-event-contracts.md)、[ADR-0005](../decisions/0005-model-tiers.md)、[roadmap](../roadmap.md)、[PRD](../PRD.md)；Issue [#8](https://github.com/ChiJiun/agentdock/issues/8)、[#10](https://github.com/ChiJiun/agentdock/issues/10)、[#41](https://github.com/ChiJiun/agentdock/issues/41)、[#47](https://github.com/ChiJiun/agentdock/issues/47)、[#48](https://github.com/ChiJiun/agentdock/issues/48)、[#49](https://github.com/ChiJiun/agentdock/issues/49)、[#51](https://github.com/ChiJiun/agentdock/issues/51)、[#55](https://github.com/ChiJiun/agentdock/issues/55)、[#65](https://github.com/ChiJiun/agentdock/issues/65)、[#66](https://github.com/ChiJiun/agentdock/issues/66)、[#70](https://github.com/ChiJiun/agentdock/issues/70)。
姊妹文件：[coding-harness-comparison.md](coding-harness-comparison.md)。

本文件整理自擁有者委託的研究（報告與研究筆記在 repo 之外）。不複製第三方程式碼或長段原文；來源只以連結與簡短改寫呈現。

**如何閱讀對應欄**：第 6、7 節的表格多了兩欄：「對應 issue／任務包」與「owner 狀態」。`PR #68 P*` 指 [PR #68](https://github.com/ChiJiun/agentdock/pull/68) 的 alpha 任務包（尚未合併，所以只寫編號）。`NI-V*` 指本文件末尾的「建議新 issue」，`NI-H*` 指姊妹文件的建議新 issue；**這些 issue 尚未建立**，要等協調者與擁有者確認。V2 候補暫時由 [#52](https://github.com/ChiJiun/agentdock/issues/52) 收納。契約以 main 上的 ADR-0003 為準；後端以 Rust 為主（ADR-0004 在 PR #68，尚未合併）。

大型提案流程、企業 monorepo 與大型開源專案的共通做法有三點。第一，核准規則寫在 repo 內可 diff 的檔案（OWNERS、MAINTAINERS、kep.yaml、EIP front matter），由 bot 讀取並執行。第二，「產生變更的身分不能為自己背書」：Kubernetes 作者不能 `/lgtm` 自己的 PR，GitHub 不把 Copilot 發起者的 approval 算進 required approvals。第三，main 保持綠燈的方式是在「預測的合併結果」上驗證，再搭配便宜的 revert，沒有任何一家把每個變更都在最新 trunk 上序列跑完全部測試。AI 貢獻政策的光譜很寬，一端是 Gentoo、NetBSD、QEMU 的禁止，另一端是 kernel、LLVM、Fedora、ASF 的「人類全責」。本次查到的政策裡，沒有一家把 AI review 當成足以合併的最終把關：Rust 規定 LLM review 只能 advisory，OpenSSF Scorecard 不計 AI review，SLSA v1.2 Source L4 要求兩位可信人員 review。所以 AgentDock 目前「fresh AI review 通過即合併」的流程，在可稽核性上已經比多數專案嚴謹，在「人類負責」與「兩人 review」這兩個外部標準上則有結構性落差。這個落差有五種處理選項，第 5 節列出，不替擁有者決定。可借鏡的低成本項目集中在這幾類：AI 揭露 trailer、作者與 reviewer 身分分離、revert-first、ADR front matter 機器驗證、證據綁定 merge candidate SHA、只讓受控 test runner 寫入證據。大規模機制（ML 選測、speculation graph、輪值 sheriff、merge window）對單人專案不划算。

> 讀取日期：除另行標示外，所有來源皆於 **2026-11-27** 讀取（WebFetch／WebSearch）。WebFetch 回傳的是摘要工具產生的內容，不是原文全文；標「未驗證」的項目只見於搜尋摘要或二手報導。「推論：」開頭的句子是本報告的判斷，不是來源原文。第 6、7 節表格中的「優點」「成本／適用規模」「建議階段」「風險」四欄全部是推論。
>
> 階段對應（推論）：「立即」指 AgentDock repo 現在就能做的流程調整；「alpha」對應 [docs/roadmap.md](../roadmap.md) 的 MVP（M1–M3）；「V1」對應 V1.0 Definition of Done；「V2」指 V1.0 之後。

## 1. 提案流程把格式交給 bot、內容交給決策者

EIP 流程最值得 AgentDock 參考的地方，在於它把「格式是否正確」和「內容是否被接受」完全拆開。EIP-1 定義的狀態為 Draft → Review → Last Call → Final，另有 Stagnant、Withdrawn、Living 三種。多數狀態由作者自己推進，editor 只負責配號、合併與格式，**明文不判斷提案好壞**（[EIP-1](https://eips.ethereum.org/EIPS/eip-1)）。規則有幾條很容易機器化：Last Call → Final 的 PR 應該只改狀態欄位；Final 之後只收 errata；Draft／Review／Last Call **閒置 6 個月以上會被轉成 Stagnant**（[EIP-1](https://eips.ethereum.org/EIPS/eip-1)）。這個轉換由每週日 00:00 執行的 cron workflow 處理，workflow 以 commit SHA pin 住 `ethereum/EIP-Bot`（[auto-stagnate-bot.yml](https://raw.githubusercontent.com/ethereum/EIPs/master/.github/workflows/auto-stagnate-bot.yml)）。PR 要先通過 eipw、HTMLProofer、CodeSpell、markdownlint，才由 eip-review-bot 判斷能否 automerge（[ethereum/EIPs README](https://github.com/ethereum/EIPs)）。eipw 是 Rust 寫的 linter，有幾十條可調整成 deny／warn／allow 的 lint，涵蓋欄位順序、長度、條件必填（例如 Withdrawn 時必填 `withdrawal-reason`）。其中 `preamble-requires-status` 要求 `requires` 列出的提案狀態必須比自己更前進（[ethereum/eipw](https://github.com/ethereum/eipw)）。ERC 已拆到獨立的 ethereum/ERCs repo（[ethereum/ERCs README](https://github.com/ethereum/ERCs)）。eip-review-bot 的實際 automerge 規則、Stagnant 是直接 commit 還是開 PR，本次都沒有查到（未驗證）。

其他流程把決策權放在不同的位置。PEP 由 Steering Council 或 PEP-Delegate 做最後決定。Standards Track PEP 必須用 Resolution header 連到接受或拒絕的貼文；Provisional PEP 即使相關變更已進 release，仍可能被 Rejected（[PEP 1](https://peps.python.org/pep-0001/)）。Rust RFC 由 sub-team 全員 sign off 後進入 FCP，修改時禁止 squash 或 rebase 已公開的 commit（[rust-lang/rfcs README](https://github.com/rust-lang/rfcs/blob/master/README.md)）。rfcbot 規定 **concern 只有提出者能 resolve**，`fcp cancel` 則會刪除該次 FCP 的所有紀錄（[rfcbot-rs](https://github.com/rust-lang/rfcbot-rs)）。RFC README 寫 FCP 為期十天，rfcbot README 只寫一週後發提醒，兩份文件不一致；舊 rfcbot 帳號也曾失去存取權。這兩點都是「流程文件與 bot 實作漂移」的實例（[rfcbot-rs](https://github.com/rust-lang/rfcbot-rs)）。Kubernetes KEP 用結構化的 kep.yaml 記錄 `status` 與 `stage`（[kep.yaml template](https://raw.githubusercontent.com/kubernetes/enhancements/master/keps/NNNN-kep-template/kep.yaml)），PRR 簽核寫成 repo 內的 `prod-readiness/<sig>/<KEP>.yaml`（[production-readiness.md](https://github.com/kubernetes/community/blob/master/sig-architecture/production-readiness.md)），狀態推進與發版 freeze 綁在一起（[release_phases](https://github.com/kubernetes/sig-release/blob/master/releases/release_phases.md)）。TC39 每次升級都需要 plenary 共識，Stage 4 需要兩個通過 Test262 的相容實作（[TC39 process](https://tc39.es/process-document/)）。

AI 政策方面，EIP-1 與兩個 repo 的 README **都沒有提到 AI 或 LLM 生成內容**（[EIP-1](https://eips.ethereum.org/EIPS/eip-1)）。EIPIP Meeting #126（2026-05-27）的摘要提到 editor 討論過用 AI 做 review，但仍由 editor 為決定負責；該摘要本身是 AI 生成的，未驗證（[EIPIP Meeting #126](https://ethereum-magicians.org/t/eipip-meeting-126-may-27-2026/28553)）。推論：AgentDock 目前的 ADR 把狀態寫成散文（例如 [ADR-0002](../decisions/0002-source-reuse.md) 的 `Status: Proposed. Module decisions are ready...`），沒有可解析的 front matter。要做 eipw 式的驗證，第一步是把狀態改成結構化欄位。

## 2. 企業 monorepo 靠預測合併結果和便宜的 rollback 保持綠燈

Google 的規模決定了它的取捨。Piper 每個工作日有 **60,000–70,000 次 commit**，約 50,000 名工程師中只有不到 10 個團隊維護長期 dev branch。未完成的功能用 runtime flag 關閉，release branch 只做有限的 cherry-pick（[SWE book ch.16](https://abseil.io/resources/swe-book/html/ch16.html)）。TAP 每天處理超過 50,000 個 change、執行超過 40 億個 test case。presubmit 只跑快速子集，通過後**有 95% 以上的機率也會通過其餘測試**，因此採「樂觀合入」，大型測試放到 postsubmit 批次執行，失敗時用 binary search 找出元凶，高信心時自動 rollback（[SWE book ch.23](https://abseil.io/resources/swe-book/html/ch23.html)）。核准拆成三個獨立 bit：peer LGTM、OWNERS approval、readability，由 VCS 在 commit 時強制（[SWE book ch.9](https://abseil.io/resources/swe-book/html/ch09.html)）。機器產生的大型變更（LSC）先經事前授權，再由 Rosie 依 ownership 分片，global approver 用工具批次核准預期中的變更，只把異常交給本地 owner（[SWE book ch.22](https://abseil.io/resources/swe-book/html/ch22.html)）。Google 也把 LLM 產生的遷移放進同一套流程：先自動 build 並跑 unit test，通過的變更才交給 owner，人工 review 和其他程式碼一樣。int32→int64 遷移中 **80% 的修改完全由 AI 撰寫**；JUnit3→4 遷移約 87% 的 AI 產出未經修改就提交。論文沒有描述「AI 產生」的標記方式（[arXiv 2501.06972](https://arxiv.org/html/2501.06972v1)）。後續論文指出人工 review 是主要瓶頸（[arXiv 2504.09691](https://arxiv.org/abs/2504.09691)，未逐字驗證）。

Uber 與 Shopify 代表「在合併前保證綠」的兩種做法。Uber 導入 SubmitQueue 之前，iOS mainline 某一週**只有 52% 時間是綠的**。SubmitQueue 以「是否影響共同 build target」判斷衝突，用準確率 97% 的 logistic regression 建 speculation graph，讓獨立的變更平行合入。「附 revert plan 與 test plan」是正相關特徵，「同一 revision 重送次數」是負相關特徵（[the morning paper](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/)；原論文頁面抓取時 404）。2025 年的後續研究把 CI 資源再降約 53%、P95 等待時間降約 37%（[arXiv 2501.03440](https://arxiv.org/abs/2501.03440)）。Shopify 的 monolith 每天約 400 個 commit。Merge Queue v2 **每批最多 8 個 PR**，在 predictive branch 上跑 CI，PR 失敗超過 3 次才移除（用來吸收 flaky），`/shipit --emergency` 提供可稽核的緊急通道。系統維護一份 in-memory 的期望狀態，持續與 GitHub reconcile（[Shopify Engineering](https://shopify.engineering/successfully-merging-work-1000-developers)；文章年份未確認）。Microsoft 的 Windows Git repo 約 3.5M 檔案、300 GB，但每日 PR 數在兩個來源分別是 2,500 與 8,421，無法對齊（[Brian Harry devblog](https://devblogs.microsoft.com/bharry/the-largest-git-repo-on-the-planet)；[The Register](https://www.theregister.com/2017/05/25/windows_is_now_built_on_git/)，皆未逐字驗證）。Meta 的 land queue 與 trunk 失敗率，本次**沒有找到一手公開來源**。

測試選擇與相依變更是另外兩個可借鏡的面向。Meta 的 Predictive Test Selection 只跑約三分之一的遞移相依測試，仍在進 trunk 前抓到超過 99.9% 的 regression。收集訓練資料時會積極重試，以區分真正的 regression 與 flaky（[Engineering at Meta](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/)）。Bazel 文件提醒：未追蹤的輸入（例如 workspace 外的編譯器）會讓 cache 被錯誤共用，建議**只讓 CI 寫入 cache**，cache 一旦被污染只能整個重建（[Bazel Remote Caching](https://bazel.build/remote/caching)）。GitHub merge queue 在 `gh-readonly-queue/*` 暫存分支上測試，**SHA 與 PR head 不同**。Actions 必須監聽 `merge_group` 事件，否則 required check 永遠不會回報（[GitHub Docs: merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）。Mergify 失敗時自動二分批次，且不會把同一個 stack 拆到不同批次（[Mergify Batches](https://docs.mergify.com/merge-queue/batches/)）。Sapling 以 mutation history 追蹤 commit 的 successor，amend 下層 commit 後會自動 restack 上層（[Engineering at Meta: Sapling](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/)）。ezyang 2026 年描述在同一個 stack 上跑三條平行的 agent 工作流，每條一個 worktree。他刻意讓其他 worktree 的 agent 停在舊 commit，做完再用 `sl follow` 跟上，以免工作樹在 agent 腳下改變（[ezyang's blog](https://blog.ezyang.com/2026/03/parallel-agents-heart-sapling/)）。

## 3. 開源專案把核准權寫進 repo，再交給只看標籤的 merge bot

Kubernetes、Chromium、Rust 都是三層分離：repo 內的 ownership 檔、把人類指令轉成 label 或 vote 的 bot、只看機器狀態的 merge bot。Kubernetes 的 OWNERS 是目錄層級的 YAML，`/approve` 需要每個相關 OWNERS 各有一位 approver。專案**刻意用 OWNERS_ALIASES 而不用 GitHub Teams，理由是 Teams 的變更無法公開稽核**（[kubernetes/community owners.md](https://raw.githubusercontent.com/kubernetes/community/master/contributors/guide/owners.md)）。Tide 的合併條件是：必要 label 齊全、沒有 `do-not-merge/hold` 這類阻擋 label、對最新 base 重測過 presubmit（[Prow Tide](https://docs.prow.k8s.io/docs/components/core/tide/)）。Chromium 要求變更觸及的每個目錄都有 owner 核准。Rubber Stamper bot 會對 clean revert、clean cherry-pick 投 `Bot-Commit +1`，但**依設計永遠不提供 OWNERS 核准**（[Chromium code_reviews.md](https://chromium.googlesource.com/chromium/src/+/main/docs/code_reviews.md)）。Chromium CQ 對失敗的測試會在含 patch 與不含 patch 兩種狀態下重跑，只有含 patch 失敗、不含 patch 通過，才判定為這個 CL 的失敗。文件說約有 **20,000 個 flaky test**，沒有 retry 幾乎沒有 CL 能通過。通過的 build 在 main 前進不超過 1,300 個 commit 前可以重用（[Chromium CQ docs](https://chromium.googlesource.com/chromium/src/+/main/docs/infra/cq.md)）。gardener 可以 revert 疑似造成破壞的變更；tree 關閉時，revert 可以加 `No-Tree-Checks: true` 照樣落地（[gardener.md](https://chromium.googlesource.com/chromium/src/+/main/docs/gardener.md)）。

Rust、LLVM、CPython 的做法比較接近 AgentDock 的規模與工具鏈。Rust 沒有改用 GitHub merge queue，而是**以 Rust 重寫新的 bors，在 2025 Q4 完成脫離 Homu 的遷移**。2026 Q1 的計畫是把所有 repo 從 branch protection 遷到 GitHub Rulesets，以便把設定 IaC 化（[Inside Rust: Infra Q4 2025 recap](https://blog.rust-lang.org/inside-rust/2026/01/13/infrastructure-team-q4-2025-recap-and-q1-2026-plan/)）。Rust 的 rollup 用 `rollup=always/maybe/iffy/never` 標風險：動到 CI 或 bootstrap 的變更通常標 `iffy`，標 `never` 的 PR 由 bors 保證不會進 rollup（[Rust Forge: Rollups](https://forge.rust-lang.org/release/rollups.html)）。LLVM 明文**偏好 revert to green，而不是 fix forward**。有 commit access 的人可以對自己維護的區域先 commit、事後 review（trust but verify）；PR 採 squash workflow（[LLVM DeveloperPolicy](https://llvm.org/docs/DeveloperPolicy.html)）。CPython 的 repo 只接受 squash。backport 堅持 upstream first：加上 `needs backport to X.Y` label，由 miss-islington 自動開 backport PR，有衝突時才人工用 `cherry_picker` 處理（[devguide: committing](https://devguide.python.org/core-team/committing/)）。kernel 則靠 MAINTAINERS 與 trailer 形成信任鏈。patch 大幅修改後要移除舊的 `Reviewed-by`／`Tested-by`（[submitting-patches](https://docs.kernel.org/process/submitting-patches.html)）。stable backport 必須先進 mainline，並經 48 小時的 ACK/NAK 窗口（[stable-kernel-rules](https://docs.kernel.org/process/stable-kernel-rules.html)）。

供應鏈標準是 AgentDock 要正面處理的限制。SLSA v1.2 Source Track 的 L2 要求歷史連續、不可變並保留，L3 要求 SCS 對受保護分支持續執行並記錄技術控制，**L4 要求兩位可信人員 review 所有進入受保護分支的變更**（[SLSA v1.2 source requirements](https://slsa.dev/spec/v1.2/source-requirements)）。Scorecard 的 Branch-Protection 分五個 tier：Tier 1–3 只需禁止 force push、至少一位 reviewer、至少一個 required status check；Tier 4 要兩位 reviewer 加 code owner review（[Scorecard checks.md](https://github.com/ossf/scorecard/blob/main/docs/checks.md)）。Code-Review check 則**明文不計 bot review，包括 AI review**（[Scorecard checks.md](https://github.com/ossf/scorecard/blob/main/docs/checks.md)）。gitsign 可以做 keyless 簽章，但 **GitHub 目前把它顯示為 Unverified**，且預設寫入公開的 Rekor，可能留下 email（[sigstore/gitsign](https://github.com/sigstore/gitsign)）。

## 4. AI 貢獻政策從全面禁止到人類全責，沒有一家讓 AI review 單獨放行

各專案的分歧點在於法律風險由誰承擔。禁止派的理由集中在授權與 DCO：QEMU 認為 AI 產出的著作權狀態不明，無法滿足 DCO，因此拒收。允許派則把同樣的風險轉給「能為內容辯護的人類提交者」。attribution 沒有跨專案標準：`Assisted-by:` 最接近事實標準，但要不要寫出模型版本正在分歧。

| 專案 | 立場 | 揭露／attribution | review 與究責規則 |
|---|---|---|---|
| Linux kernel | 允許，人類全責 | 7.0 版文件為 `Assisted-by: AGENT_NAME:MODEL_VERSION [TOOL]`（[7.0 coding-assistants](https://docs.kernel.org/7.0/process/coding-assistants.html)）；2026-07-01 有 patch 提議改成 `Assisted-by: LLM`，已有三個 Reviewed-by 與 Corbet sign off（[LKML](https://lkml.iu.edu/2607.2/13974.html)）。**矛盾**：2026-11-27 讀取的最新版文件找不到 Attribution 段落（[latest](https://docs.kernel.org/process/coding-assistants.html)），該 patch 是否已併入主線未確認 | **AI agent 不得加 `Signed-off-by`**，只有人類能認證 DCO；agent 不得自行送出任何東西，要回報哪些沒能 build／test／重現（[raw coding-assistants.rst](https://raw.githubusercontent.com/torvalds/linux/master/Documentation/process/coding-assistants.rst)）；cover letter 要揭露工具、prompt 摘要與測試方式，提交者解釋不了的 series 可以直接拒絕（[generated-content](https://docs.kernel.org/process/generated-content.html)） |
| LLVM | 允許，有限制 | 實質生成內容要標示，以 `Assisted-by:` 為例，確切格式因摘要截斷而未取得；maintainer 可加 `extractive` label | 貢獻者必須先讀過並 review 所有 AI 產出；貢獻的價值要大於 review 它的成本；**禁止未經人類核准就行動的 agent，也禁止未經人類審查就貼評論的自動 review**；good first issue 不可用 AI（[LLVM AI Tool Policy](https://llvm.org/docs/AIToolPolicy.html)） |
| Rust（rust-lang/rust 等六個 repo） | 可用 AI 檢查，不可用 AI 創作 | LLM 生成的程式碼要貼 `llm-assisted` label | **LLM review 只能 advisory**，不能作為 merge 或 reject 的依據；review bot 要用獨立且標示清楚的帳號；LLM 程式碼限 non-critical 變更；circuit breaker：6 週內合併的 PR 超過一半是 LLM 生成時，暫停新的 LLM PR（[Rust Forge LLM usage](https://forge.rust-lang.org/policies/llm-usage.html)）；2026-08-05 宣布（[Inside Rust](https://blog.rust-lang.org/inside-rust/2026/08/05/rust-langrust-is-adopting-an-llm-policy/)，僅搜尋摘要） |
| CPython | 允許 | 揭露受歡迎但不強制 | 提交者為內容負責；**禁止為了讓測試通過而修改或繞過測試**；有 `AI-needs-explanation`、`AI-guidelines-not-met` 兩段式 label（[devguide AI tools](https://devguide.python.org/getting-started/ai-tools/index.html)） |
| Fedora | 允許（2025-10 Council 通過） | `Assisted-by:` trailer；必須揭露還是鼓勵揭露，各來源說法不一 | reviewer 可以用 AI，但**不可完全自動化 review**（[Fedora Community Blog](https://communityblog.fedoraproject.org/council-policy-proposal-policy-on-ai-assisted-contributions/)；原文被 Anubis 擋下，未逐字驗證） |
| ASF | 允許，附著作權條件 | `Generated-by:` 或 `Co-authored-by: <工具> <版本>`，目的是產生機器可解析的 provenance | 工具條款要相容、第三方素材要確認、貢獻者要有合理確信（[ASF Generative Tooling](https://www.apache.org/legal/generative-tooling.html)） |
| Gentoo／NetBSD／QEMU | 禁止 | — | Gentoo 2024-04-14 Council 決議禁止（[Gentoo](https://wiki.gentoo.org/wiki/Project:Council/AI_policy)）；NetBSD 把 LLM 程式碼推定為 tainted，需 core 書面核准（[NetBSD](https://www.netbsd.org/developers/commit-guidelines.html)）；QEMU 已知或疑似使用 AI 就拒收（[QEMU](https://www.qemu.org/docs/master/devel/code-provenance.html)） |
| curl／Ghostty | 允許，嚴懲 slop | 必須揭露 | curl 結束 bug bounty，2026-01-31 生效（[Stenberg](https://daniel.haxx.se/blog/2026/01/26/the-end-of-the-curl-bug-bounty/)）；Ghostty 有公開的 denouncement list（[Ghostty AI_POLICY.md](https://raw.githubusercontent.com/ghostty-org/ghostty/main/AI_POLICY.md)） |
| GitHub Copilot cloud agent | 平台機制 | agent 為 author、指派者為 co-author | 只能 push 到 `copilot/` 分支；**發起者的 approval 不計入 required approvals**；agent 程式碼的 workflow 預設要人工核准才執行（[GitHub Docs: risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations)）；ruleset 有預設啟用的「未歸屬 Copilot PR 額外需一個 approval」（public preview，[Available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)）。**矛盾**：一份文件說 commit 有簽章、顯示 Verified，另一份搜尋摘要說 Copilot 不簽章 |
| Google（內部） | 允許 | 論文未描述標記方式 | LLM 變更和其他程式碼一樣由人工 review（[arXiv 2501.06972](https://arxiv.org/html/2501.06972v1)） |
| EIP／ERC、Chromium、Kubernetes、Meta、Microsoft、Uber、Shopify | **本次未找到一手政策** | — | 缺資料；要補查 ethereum/EIPs 的 CONTRIBUTING、各專案的 contributor guide |

GitHub 平台另外加上了數量控制：沒有寫入權的使用者在單一 repo 同時開啟的 PR 數有上限，**AI agent 開的 PR 也計入**。合併 PR 數從 2023-01 約每月 2,500 萬成長到超過 9,000 萬（[GitHub Blog: PR limits](https://github.blog/open-source/maintainers/how-pull-request-limits-are-cutting-down-the-noise/)）。推論：這些政策約束的是「對那些專案的貢獻」，不約束 AgentDock 自己的 repo。它們和 AgentDock 有關的情況有三種：AgentDock 想取得 Scorecard 或 SLSA 的等級宣稱；AgentDock 未來接受外部貢獻；AgentDock 的使用者要用這個產品向 kernel、LLVM、Fedora 等專案貢獻。第三種情況直接變成產品需求。

## 5. AI-only 合併與人類責任：待擁有者決定（五種處理方式）

**本節不替擁有者決定。** 下列選項只列出取捨，沒有推薦；選擇後的落實（ADR、ruleset、CODEOWNERS、範本、AGENTS.md）都是**另案**，本 PR 不改 AGENTS.md、PR 範本、ruleset 或任何設定檔。

**main 保護現況**（2026-11-27 以 `gh api repos/ChiJiun/agentdock/rulesets` 讀取，規則集「Protect main」）：只允許 squash merge、線性歷史、禁止刪除與 non-fast-forward；required status check 為 `check`（不要求分支與 base 同步）；review thread 必須 resolve；`required_approving_review_count` 為 0（**不要求任何 approval**）；不要求 code owner review、不要求最後一次 push 的 approval、不在新 push 時 dismiss 舊 approval；啟用「未歸屬變更需額外 approval」；沒有 bypass actor。推論：目前 repo 層級沒有任何機制強制「人類」核准，人類責任只存在於擁有者的流程指示。


現況是：AgentDock 多數程式由 AI agent 撰寫，由另一個 fresh session 的 AI agent review，review 判定可合併、CI 的 `check` 通過後就合併（squash-only ruleset）。擁有者已指示可在 fresh review 通過且 CI 無失敗時合併（該指示不在 repo 內）；AGENTS.md 寫明不得自動合併，除非明確核准。所以這不是違規，而是擁有者目前的選擇。和外部標準的落差有四處。Scorecard Code-Review 不計 AI review，Branch-Protection Tier 4 需要兩位 reviewer（[Scorecard checks.md](https://github.com/ossf/scorecard/blob/main/docs/checks.md)）。SLSA Source L4 需要兩位可信人員（[SLSA v1.2](https://slsa.dev/spec/v1.2/source-requirements)）。Rust 規定 LLM review 不足以 merge（[Rust Forge](https://forge.rust-lang.org/policies/llm-usage.html)）。Fedora 禁止完全自動化 review，LLVM 禁止未經人類審查的自動 review（[LLVM](https://llvm.org/docs/AIToolPolicy.html)）。另外，AgentDock 自己的 [roadmap](../roadmap.md) 在 V1.0 Definition of Done 寫了「independent review and human-approved merge boundary」，在 work order 寫了 push／merge 前要人類確認。推論：產品打算提供給使用者的邊界，比 repo 自己目前的流程更嚴，這個不一致本身就值得記錄成 ADR。

| 選項 | 做法 | 能對齊什麼 | 取捨（推論） |
|---|---|---|---|
| 1. 維持現狀並誠實揭露 | 不改合併流程；在 README 或 SECURITY 文件寫明「AI review 不等於人類 review」，不宣稱 Scorecard Code-Review 或 SLSA Source L4 | Scorecard Branch-Protection Tier 1–3、SLSA Source L1–L3 式的控制（受保護 main、required check、保留歷史）| 成本最低，吞吐量不變；Scorecard 分數會偏低；外部採用者看不到「有人為內容負責」的訊號；同一模型家族的 AI 互審可能有相同盲點，沒有獨立的第二道防線 |
| 2. 人類最終 sign-off 閘門 | AI fresh review 通過後，由擁有者 approve 或親自按 merge，或在 squash message 加自己的 `Signed-off-by` | kernel、LLVM、Fedora、CPython 的「人類負全責」精神；roadmap 的 human-approved merge boundary | 每個 PR 都要擁有者花時間，打斷目前的自動循環；仍然只有一個人，達不到 SLSA L4 或 Scorecard Tier 4。推論：若 agent 用擁有者帳號 push，「Require approval of the most recent reviewable push」會要求最後 push 者以外的人 approve（[Available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)），擁有者會不符資格；要做 GitHub 層的強制，agent 必須改用獨立的 bot 或 GitHub App 身分 |
| 3. 依路徑風險分級 | 低風險路徑（文件、UI 樣式、測試）維持 AI review 即合併；高風險路徑（`.github/workflows/**`、Tauri capabilities、backend policy 模組、`Cargo.toml`／`Cargo.lock`）需要人類 approval | Rust 的「LLM 程式碼只限 non-critical」、Chromium 的 `per-file`／`SECURITY_OWNERS`、Scorecard Dangerous-Workflow 的風險焦點 | 人類的時間集中在真正危險的地方；需要維護一份分級檔，分級錯誤會漏網；同樣需要 agent 用獨立身分 push，CODEOWNERS 才能強制擁有者 review |
| 4. 招募第二位可信人類 reviewer | 找共同維護者，高風險或全部 PR 都由人類 review | 唯一能誠實達到 SLSA Source L4 與 Scorecard Tier 4 的路徑 | 單人專案成本最高，有協調延遲；人選與信任建立超出流程設計的範圍 |
| 5. 合併後的定期人類稽核 | 維持自動合併，擁有者定期（例如每週）抽查或全量閱讀已合併的 diff，發現問題就 revert | LLVM 的 trust but verify、Google 緊急 commit 後補審的模式 | 不擋吞吐量，也保留人類責任的紀錄；但屬於事後審查，不符合任何「合併前 review」的標準；可能變成走形式 |

推論：這些選項可以組合，例如「1 + 3」或「3 + 5」。無論選哪一種，有兩件事都成立，而且成本很低。第一，把 AI reviewer 的結論記成和人類 approval 分開的狀態（例如 `ai-reviewed` 與 `human-approved` 兩個 label），讓「沒有人類 approval」這件事可以被稽核，而不是被隱藏。第二，把選擇寫成 ADR 放進 `docs/decisions`。

### 待擁有者決定的事項

| # | 要決定什麼 | 選項或建議的做法 | 影響範圍 |
|---|---|---|---|
| D1 | 採用哪一個選項（1–5，或「1 + 3」「3 + 5」等組合） | 見上表；本文件不推薦 | 全部後續項目 |
| D2 | 若選 2 或 3：agent 是否改用獨立的 bot 或 GitHub App 身分 push | 沒有獨立身分時，GitHub 的 approval 規則（例如要求最後 push 者以外的人 approve）會因擁有者同時是 push 者而無法使用 | ruleset、CODEOWNERS、#55 |
| D3 | AI 揭露要寫在哪裡、什麼格式（trailer 種類、是否寫模型版本、squash message 或 PR 描述） | kernel 的 `Assisted-by:` 格式在 2026 年就改過，建議格式可設定；寫入 AGENTS.md 或 PR 範本需擁有者核准 | AGENTS.md、#41、NI-V2、NI-V4 |
| D4 | 是否把「AI review 通過」與「人類核准」記成不同狀態（例如兩個 label） | 無論選哪個選項，這都能讓「沒有人類核准」可被稽核；誰能加 label 要限制，否則失去意義 | #55、#40、NI-V1 |
| D5 | 是否把本決定寫成 ADR（編號待定）並在 alpha 之前完成 | 研究建議寫成 ADR，因為 roadmap 對使用者承諾的 human-approved merge boundary 需要 repo 自己先示範 | `docs/decisions/` |
| D6 | 是否設可稽核的緊急通道與 revert-first 規則 | 見 A6、B21 | 流程文件、#49、#55 |

在擁有者決定前，現行流程維持不變；本 PR 不改變任何合併條件。


## 6. 可借鏡項目（A）：AgentDock 自己 repo 的流程

| 項目 | 來源專案與做法 | 優點 | 成本／適用規模 | 建議階段 | 風險 | 對應 issue／任務包 | owner 狀態 |
|---|---|---|---|---|---|---|---|
| A1. AI 揭露 trailer，agent 不加 `Signed-off-by` | kernel `Assisted-by:` 與「agent 不得 sign off」（[coding-assistants](https://docs.kernel.org/process/coding-assistants.html)）；Fedora、LLVM 同類做法；ASF `Generated-by:`（[ASF](https://www.apache.org/legal/generative-tooling.html)） | 人類可讀的 provenance；符合 AGENTS.md「no hidden model」 | 幾乎零成本，單人划算 | 立即 | squash-only 時，個別 commit 的 trailer 可能沒進 squash message，要寫進 PR 描述或 squash message；kernel 格式還在變（7.0 版 vs 2026-07 patch） | #41（PR 範本）、#40；寫入 AGENTS.md 或範本屬擁有者決定 | 缺口 → NI-V2 |
| A2. 作者 session 與 reviewer session 分離，並留下紀錄 | Kubernetes 作者不能 `/lgtm` 自己的 PR（[owners.md](https://raw.githubusercontent.com/kubernetes/community/master/contributors/guide/owners.md)）；GitHub 發起者 approval 不算數 | 現行 fresh-session review 已大致做到；補上紀錄就能稽核 | 低；在 review 留言寫入 reviewer 的 model 與 session 識別 | 立即 | 不同 session 但同模型家族，獨立性有限 | #10、#41；PR #68 P8-3。紀錄格式（reviewer 的 model 與 session 識別）無 owner | 部分 → NI-V2 |
| A3. AI review 結論與人類核准用不同的 label | Chromium Rubber Stamper 不給 OWNERS 核准（[code_reviews.md](https://chromium.googlesource.com/chromium/src/+/main/docs/code_reviews.md)）；Rust LLM review 只能 advisory | 誠實呈現核准來源，也是第 5 節任一選項的前提 | 低 | 立即 | label 若可由 agent 自己加上就失去意義，要限制誰能加 | #55（ruleset）、#40；與第 5 節選項綁定 | 缺口 → NI-V1 |
| A4. blocking 項目只能由 reviewer 關閉 | rfcbot 的 concern 只有提出者能 resolve（[rfcbot-rs](https://github.com/rust-lang/rfcbot-rs)） | 防止實作 agent 自己勾掉 blocking 項目 | 低；新 reviewer 要逐條判定前一輪的 blocking 項目 | 立即 | 新一輪 reviewer 不認同前一輪意見時，需要裁決規則 | #41（PR 流程）；規則本身無 owner | 缺口 → NI-V2 |
| A5. PR 範本必填「測了什麼、沒測到什麼」，禁止改測試來求通過 | kernel 要求回報未 build／test／重現的項目；CPython 禁止繞過測試（[devguide AI tools](https://devguide.python.org/getting-started/ai-tools/index.html)） | 針對 AI agent 常見的失敗模式 | 低 | 立即 | 只是範本文字，要靠 reviewer 實際檢查 diff 中的測試改動 | #41（PR 範本與提交前檢查） | 有 owner |
| A6. revert-first，revert 該 squash commit 後再 reland | LLVM revert to green（[DeveloperPolicy](https://llvm.org/docs/DeveloperPolicy.html)）；CPython 的 Revert 按鈕 | squash 讓 revert 很乾淨；避免 agent 在 main 上 fix forward | 零 | 立即 | revert PR 本身也要過 `check`；clean revert 能否走快速通道要另外定 | 無（屬流程文件） | 缺口 → NI-V2 |
| A7. 便宜的 Scorecard／ruleset 項目 | Scorecard Token-Permissions、Dangerous-Workflow、Pinned-Dependencies、Branch-Protection Tier 1–3（[checks.md](https://github.com/ossf/scorecard/blob/main/docs/checks.md)）；ruleset 的 dismiss stale approvals、conversation resolution | 不需要第二個人；workflow 安全對「AI 會改 workflow」的 repo 特別重要 | 低 | 立即（workflow 權限、pin）；alpha（跑 Scorecard） | Scorecard 有些項目需要 admin token 才能評分 | #55（main Ruleset、Required CI、防繞過驗收）。workflow 權限與 pin 屬同類；#63 是發行物 SBOM／provenance，另一個面向 | 有 owner（建議擴充 #55） |
| A8. ruleset 設定 IaC 化並放進 repo | Rust 遷到 Rulesets 以便 IaC（[Infra recap](https://blog.rust-lang.org/inside-rust/2026/01/13/infrastructure-team-q4-2025-recap-and-q1-2026-plan/)）；Kubernetes 不用 Teams 以利稽核 | 規則變更可以 diff、可以 review | 低到中；匯出 JSON 並定期比對 | alpha | 匯出檔與實際設定可能漂移，要有比對機制 | #55 | 有 owner（建議擴充 #55） |
| A9. 高風險路徑分級檔與 CODEOWNERS | Kubernetes OWNERS `filters`、Chromium `per-file`／`file://SECURITY_OWNERS`；Rust 把 CI 變更標 `iffy` | 第 5 節選項 3 的基礎 | 中；單人時 owner 都是擁有者，要搭配 agent 用獨立身分才有強制力 | alpha | 分級錯誤會讓高風險變更漏網 | #55（CODEOWNERS）；高風險路徑清單無 owner，且與第 5 節選項 3 綁定 | 部分 → NI-V1 |
| A10. ADR front matter 結構化並用 CI 驗證 | EIP eipw 的條件必填與 `preamble-requires-status`（[eipw](https://github.com/ethereum/eipw)）；PEP 必填 header；KEP kep.yaml | 現有 ADR 的狀態寫在散文裡，無法機器檢查；先 warn 後 deny 可以漸進導入 | 低；一支小 script | alpha | 目前只有兩份 ADR，太早做會變成形式；規則和文件會漂移，規則應只有一個來源 | 無 | 缺口 → NI-V3 |
| A11. 狀態轉換 PR 只改狀態欄位 | EIP Last Call → Final（[EIP-1](https://eips.ethereum.org/EIPS/eip-1)） | 「Accepted」的 diff 一目了然，CI 容易檢查 | 低 | alpha | 和 A10 一起做才有價值 | 無 | 缺口 → NI-V3 |
| A12. 決策紀錄連結 | PEP Resolution header（[PEP 1](https://peps.python.org/pep-0001/)） | ADR 能追到擁有者實際接受的 PR 或留言 | 零 | 立即 | 無 | 無 | 缺口 → NI-V2 |
| A13. `Fixes:` trailer | kernel 至少 12 字元的 SHA 加一行摘要（[submitting-patches](https://docs.kernel.org/process/submitting-patches.html)） | revert 與 backport 時可以追溯 | 零 | alpha | squash 時同樣要保留在 squash message | 無 | 缺口 → NI-V2 |
| A14. hold label 與簡易 freeze | Tide 的 `do-not-merge/hold`（[Tide](https://docs.prow.k8s.io/docs/components/core/tide/)）；Kubernetes freeze 的例外窗口 | 發版前只收修正 | 低 | V1（有 release 之後） | 太早做沒有用途 | 無；V1 有 release 後才需要 | 暫不立案 |
| A15. 外部貢獻控制 | GitHub PR 數量上限與只限 collaborator 開 PR（[GitHub Blog](https://github.blog/open-source/maintainers/how-pull-request-limits-are-cutting-down-the-noise/)）；LLVM 保護 good first issue | 防範 AI PR spam | 低 | V1（開放外部貢獻時） | 過嚴會擋掉正常的新貢獻者 | 無；V1 開放外部貢獻時才需要 | 暫不立案 |
| A16. commit 簽章 | ruleset 的 Require signed commits；gitsign 在 GitHub 上顯示 Unverified（[gitsign](https://github.com/sigstore/gitsign)） | 提高身分可信度 | 中；用 SSH 或 GPG 比 gitsign 實際 | V1 | squash merge 由 GitHub 產生 commit，簽章歸屬未查證；Copilot 的簽章說法有矛盾 | #55（Require signed commits）；squash 簽章歸屬未查證 | 部分（V1） |
| A17. GitHub merge queue 或 Mergify | GitHub merge queue（[Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）；Mergify batches | 多個 PR 同時就緒時，驗證它們的組合 | 單人 PR 量小；`check` workflow 必須監聽 `merge_group` 才會回報 | 不採用（V2 再評估） | 設定錯誤會讓 required check 永遠 pending | #49（整合佇列；本研究建議先不採用 GitHub merge queue，V2 再評估） | 不採用 |
| A18. Rust 式 circuit breaker（LLM PR 比例過半就暫停） | [Rust Forge](https://forge.rust-lang.org/policies/llm-usage.html) | — | 按設計 AgentDock 接近 100% 是 AI，這條規則會永久觸發 | 不採用 | — | — | 不採用 |
| A19. 輪值 sheriff、merge window、Mega-CQ、48 小時 stable committee、backport bot | Chromium、kernel、CPython | — | 只在多人與高變更量時划算 | 不採用 | — | — | 不採用 |

## 7. 可借鏡項目（B）：AgentDock 產品功能

| 項目 | 來源專案與做法 | 優點 | 成本／適用規模 | 建議階段 | 風險 | 對應 issue／任務包 | owner 狀態 |
|---|---|---|---|---|---|---|---|
| B1. 證據綁定 `base_sha`、`head_sha`、`merge_candidate_sha` 與 tree hash，合入時檢查 main 仍等於候選的 parent | GitHub merge queue 暫存分支的 SHA ≠ PR head（[Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）；Tide 對最新 base 重測；Chromium 用 commit 距離判斷新鮮度 | 防止「測的是 A、合的是 B」的 false green | 中；單機的核心功能 | alpha | 新鮮度規則太鬆會失效；單人規模建議 base 一變就重跑 | #48（不可偽造的驗證紀錄）、#49、#65；PR #68 P6-1、P8-4 | 有 owner（建議擴充 #48／#49） |
| B2. 只有受控 test runner 能寫入證據 store，agent 自報的結果只當參考 | Bazel 建議只讓 CI 寫 cache（[Bazel](https://bazel.build/remote/caching)） | 證據不可偽造；符合 backend policy 原則 | 中 | alpha | 證據 key 要包含 toolchain 版本與環境白名單，否則仍會誤用 | #48；PR #68 P6-1（受控 check runner） | 有 owner |
| B3. 本機 integration queue：先做序列處理 | Tide、bors；Uber 指出單一佇列能保綠但不能擴展（[the morning paper](https://blog.acolyer.org/2019/04/18/keeping-master-green-at-scale/)） | 單機規模下最簡單、可預測 | 中 | alpha | agent 數量增加後等待時間會線性變長 | #49 | 有 owner |
| B4. queue 狀態由事件重建，啟動時與實際 refs／worktree 對帳 | Shopify 的 in-memory 期望狀態加上 reconcile（[Shopify](https://shopify.engineering/successfully-merging-work-1000-developers)） | 符合 event-sourced 設計，能從崩潰中恢復 | 中 | alpha | 對帳規則有錯時可能誤刪 worktree，破壞性動作要另行確認 | #49、#7；PR #68 P2-6（crash recovery）、P5-3（worktree 對帳） | 有 owner |
| B5. 不在 agent 執行中移動它的 worktree；送入 queue 時才 restack | ezyang 的平行 agent 做法（[ezyang](https://blog.ezyang.com/2026/03/parallel-agents-heart-sapling/)） | agent 不會在工作途中看到程式碼變動 | 低 | alpha | 做完後才 restack，衝突可能比較大 | #49、#37 | 有 owner（建議擴充 #49） |
| B6. agent 專屬分支前綴，只能 push 到自己的分支 | Copilot 的 `copilot/` 分支（[GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations)） | backend 強制，不依賴 prompt | 低 | alpha | 分支命名要避開 merge queue 不支援的 `*` pattern | #9、#8；PR #68 P5-2／P5-3 | 有 owner（建議擴充 #9） |
| B7. backend 強制「產生者不能當自己的 reviewer」，並記錄每個 commit 的 actor | GitHub 發起者 approval 不計入；Kubernetes、Chromium 的自我核准限制 | 對應第 5 節的核心問題；讓產品使用者也能採用選項 2 或 3 | 中 | alpha | 「同模型不同 session」算不算獨立，要讓使用者自己設定 | #10、#8；與第 5 節選項 2、3 綁定 | 部分 → NI-V4 |
| B8. agent commit 只帶 `Assisted-by:`，完整的 agent、model、session 存在 event log；`Signed-off-by` 只能由人類的 UI 動作加上 | kernel（[coding-assistants](https://docs.kernel.org/process/coding-assistants.html)）；ASF 的 Tooling-Provenance 目標 | 讓使用者向 kernel、LLVM、Fedora 貢獻時直接合規 | 低到中 | alpha | trailer 格式在變，要可設定；`Co-authored-by` 在 ASF 與 Copilot 的語意相反，不建議混用 | #40、PR #68 P7-2（commit／push／PR）。commit trailer 與人類簽核動作無 owner | 缺口 → NI-V4 |
| B9. 依目標 repo 套用上游 AI policy profile | QEMU、Gentoo、NetBSD 禁止；LLVM 禁止未經人類核准就行動的 agent；Rust 只限 non-critical 程式碼 | 防止使用者在禁止 AI 的專案中誤用 | 中；profile 要維護 | V1 | 政策常變（kernel 2026 年就改過），profile 過期會誤導使用者 | 無 | 缺口 → NI-V5 |
| B10. 三個獨立的核准 bit：`peer_review`、`owner_approval`、`style_gate` | Google LGTM、OWNERS、readability（[SWE book ch.9](https://abseil.io/resources/swe-book/html/ch09.html)） | 讓 AI review、人類 owner、lint 三者分開判定 | 中 | V1 | 設定複雜度增加 | #10、#40 | 部分 → NI-V4 |
| B11. agent 產出的程式碼先經使用者核准，才在受控 runner 執行 | Copilot agent 的 workflow 預設要人工核准才執行（[GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/risks-and-mitigations)） | 降低惡意或失控程式碼在本機執行的風險 | 中；會增加互動次數 | alpha（高風險指令）；V1（可設定） | 核准太頻繁會讓使用者疲乏，最後一律按允許 | #8；PR #68 P4-2／P4-3、P6-1 | 有 owner |
| B12. 對照重跑判定 flaky：失敗時在 base 上重跑 | Chromium CQ 的含 patch／不含 patch 重跑（[CQ docs](https://chromium.googlesource.com/chromium/src/+/main/docs/infra/cq.md)） | 避免 agent 為了 flaky 測試去亂改程式 | 中；多跑一次 base | V1 | 測試時間加倍；預設要 ALLGREEN，flaky 容忍要明確且可稽核 | #47、#48 | 有 owner（建議擴充） |
| B13. 保存 main 每個 SHA 的基準結果，忽略原本就存在的失敗 | Rosie 忽略變更前就存在的 presubmit 失敗（[SWE book ch.22](https://abseil.io/resources/swe-book/html/ch22.html)） | 區分「agent 弄壞」和「本來就壞」 | 中 | V1 | 基準本身過期就會誤判 | #47、#48 | 有 owner（建議擴充） |
| B14. 依 Cargo crate 反向依賴選測；動到 `Cargo.lock`、`build.rs`、toolchain 時升級為全量測試 | TAP 依依賴圖選測（[SWE book ch.23](https://abseil.io/resources/swe-book/html/ch23.html)）；Bazel 的 hermeticity 教訓 | 縮短 queue 時間 | 中 | V1 | 漏追蹤的輸入會造成 false green | #47（變更影響分析） | 有 owner |
| B15. 穩定的 change-id 與 predecessor → successor 事件；只有 patch 不變時才沿用 review 結論，測試一律重跑 | Sapling mutation history（[Meta](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/)）；GitHub dismiss stale approvals | rebase 後不會誤用舊的核准 | 中 | V1 | 推論：`git patch-id --stable` 是否適合當判定依據，本次未驗證 | #10、#49 | 部分（建議擴充 #49） |
| B16. 任務授權範圍：變更只能動授權內的路徑，並限制同一授權下的在途變更數 | Google LSC 的事前授權、reviewer 不擴大範圍、限制在途 shard 數（[SWE book ch.22](https://abseil.io/resources/swe-book/html/ch22.html)） | backend 強制 scope restriction | 中 | V1 | 範圍定得太窄，agent 會頻繁卡住 | #8（workspace scopes）、#39（指派 packet）；PR #68 P4-1、P5-3 | 有 owner |
| B17. 風險分級標籤，決定能否和其他變更一起驗證 | Rust `rollup=always/maybe/iffy/never`（[Rollups](https://forge.rust-lang.org/release/rollups.html)） | 文件類一起驗證，CI 與 Tauri 設定類單獨驗證 | 低 | V1 | 標錯會把高風險變更混進批次 | #49、#47 | 部分（建議擴充 #49） |
| B18. ADR／規格狀態機：狀態帶資料的 enum（例如 `Withdrawn { reason }`）、`requires` 狀態不能落後、截止日寫進 front matter、閒置就標 Stagnant、取消記成新事件而不是刪除 | EIP-1 與 eipw；PEP Deferred 與 Superseded；rfcbot 的 `fcp cancel` 會刪紀錄（反例） | 狀態轉換可以驗證，也符合 event-sourced 設計 | 中 | V1 | 閒置門檻沒有來源依據，solo 專案的天數要自己定 | 無（#65／#10 的狀態機不含 ADR 狀態） | 缺口 → NI-V3 |
| B19. tree 狀態 Open／Closed／Throttled，revert 可例外落地 | Chromium gardener 與 `No-Tree-Checks`（[gardener.md](https://chromium.googlesource.com/chromium/src/+/main/docs/gardener.md)） | main 壞掉時自動暫停 queue | 低 | V1 | 例外通道可能被濫用 | #49 | 有 owner（V1） |
| B20. clean revert 快速通道：只跑必要 CI，但不給 owner 核准 | Chromium Rubber Stamper | 降低修復 main 的延遲 | 低 | V1 | 「clean」的判定要嚴格（diff 必須恰好是原 commit 的反向） | #49 | 有 owner（V1） |
| B21. 可稽核的緊急通道 | Shopify `/shipit --emergency`；Google 緊急 commit 後補審 | 事故處理不被流程卡住 | 低 | V1 | 被當成日常捷徑 | #49、#55；是否設緊急通道需擁有者決定 | 部分 → NI-V1 |
| B22. 人工修改比例指標：agent 原始輸出 commit vs 最終合入 commit | Google 以第一個 snapshot 與最終版本的差異計算 AI 作者比例（[arXiv 2501.06972](https://arxiv.org/html/2501.06972v1)） | observability，可以評估 agent 品質 | 低 | V1 | 不能拿來當配額或績效指標 | #13（觀測）、#14（基準） | 部分 → NI-H6（見 coding-harness-comparison.md） |
| B23. 每個 agent 同時開啟的 PR 數上限 | GitHub PR limits 也計入 AI agent 的 PR（[GitHub Blog](https://github.blog/open-source/maintainers/how-pull-request-limits-are-cutting-down-the-noise/)） | 防止 agent 灌爆 review 佇列 | 低 | V1 | 上限太低會限制平行度 | #10、#43；併入 NI-H5 的並行上限 | 部分 → NI-H5 |
| B24. agent 網路存取限制 | Copilot 的 firewall | 降低資料外洩與供應鏈風險 | 高；在 Windows 上實作複雜 | V2 | 擋到合法的套件下載 | #62（OS 隔離能力驗證） | V2 候補 → 由 #52 收納 |
| B25. batching、自動二分、flaky 容忍閾值 | Mergify、GitHub merge queue、Shopify 容忍 3 次 | 多 agent 同時完成時節省時間 | 中到高 | V2 | 容忍閾值會讓真正的失敗混進 main；插隊會作廢所有在途驗證，UI 要顯示作廢數量 | #49（V2） | V2 候補 → 由 #52 收納 |
| B26. stack-aware queue：下層被退回時，上層標成 blocked | Mergify 不拆 stack、Graphite 部分合併後自動 rebase upstack | 支援相依任務 | 高 | V2 | 狀態組合複雜 | #49（V2）、#61（跨 repo 相依） | V2 候補 → 由 #52 收納 |
| B27. speculation graph、ML 選測與 build 預測 | Uber SubmitQueue、Meta PTS | — | 需要大量歷史資料與算力，單機不適用 | 不採用 | — | — | 不採用 |

## 8. Conclusion

這次研究改變的判斷是：AgentDock 和大型專案的差距不在工具，而在「誰負責」這個角色。Tide、bors、CQ、merge queue 的核心邏輯在單機上都能以低成本重做，而且 AgentDock 在證據綁定 SHA、event log、fresh reviewer 這幾點上已經比多數開源專案更容易稽核。真正無法靠工具補上的，是 Scorecard、SLSA、Rust、Fedora、LLVM 共同預設的那個「為內容負責的人類」。推論：與其讓 AI reviewer 假裝成第二個人，更務實的做法是讓「沒有人類核准」這件事在 label、trailer、event log 中可見，再由擁有者依第 5 節選擇補多少人力。這個選擇最好在 alpha 之前寫成 ADR，因為 roadmap 承諾給使用者的 human-approved merge boundary，需要 repo 自己先示範。

產品面最有差異化的機會，在於大型專案的 AI 政策正快速分化而且頻繁改版：kernel 的 trailer 格式在 2026 年就改過一次，Rust 與 Fedora 對 AI review 的限制也不同。推論：一個能依目標 repo 自動套用上游政策的工作台（agent 不 sign off、自動揭露、人類核准才送出、禁止 AI 的專案直接警告），比再做一個 merge queue 更能解決使用者真正會遇到的合規問題。這一點的前提是 profile 要持續維護。本次未取得一手資料的部分（Meta land queue、Chromium／Kubernetes／EIP 的 AI 政策、eip-review-bot 的 automerge 規則、kernel 2026-07 patch 是否已併入主線、GitHub squash merge 的簽章行為），在做相關決策前需要補查。


## 9. 建議新 issue（尚未建立，待協調者與擁有者確認）

| ID | 建議標題 | 範圍 | 階段 | 驗收條件 |
|---|---|---|---|---|
| NI-V1 | `decision(governance): AI-only 合併與人類責任標準（待擁有者決定）` | 追蹤第 5 節 D1–D6：選擇選項、是否用獨立 bot 身分、label 分離、緊急通道。決定後的落實（ruleset、CODEOWNERS）由 #55 承接 | alpha 之前 | 擁有者的決定與取捨寫成 ADR（編號待定）並 Accepted；現行流程與決定一致；不在決定前修改任何設定 |
| NI-V2 | `docs(process): repo 貢獻與合併流程補強` | AI 揭露 trailer（A1）、`Fixes:` trailer（A13）、revert-first（A6）、blocking 項目只能由 reviewer 關閉（A4）、決策紀錄連結（A12）、reviewer 的 model 與 session 紀錄（A2）。範本部分與 #41 協調 | 立即 | 流程文件成文；是否寫入 AGENTS.md 與 PR 範本由擁有者核准後另案；不改 ruleset |
| NI-V3 | `chore(docs): ADR 結構化 front matter 與 CI 驗證` | 把 ADR 狀態從散文改為可解析欄位；狀態轉換 PR 只改狀態欄位（A10、A11）；`Withdrawn`／`Superseded` 帶原因與連結（B18 的簡化版）；先 warn 後 deny；規則只有一個來源 | alpha | 現有 ADR（0001–0005）遷移；驗證腳本與負面案例；不新增 required check 名稱（維持 `check`）；與 #41 協調 |
| NI-V4 | `design(provenance): commit／PR 的 AI 揭露與人類簽核（產品功能）` | agent commit 只帶 `Assisted-by:` 類 trailer（格式可設定）、完整 agent／model／session 存在事件；`Signed-off-by` 只能由人類在 UI 動作加上；後端強制產生者不能當自己的 reviewer；AI review、owner approval、style gate 三個獨立核准欄（B7、B8、B10） | alpha（規格）／V1 | 契約或 ADR 段落成文；負面案例：agent 無法加 sign-off、產生者無法核准自己的變更；使用者可設定「同模型不同 session」是否算獨立 |
| NI-V5 | `design(policy-profile): 依目標 repo 套用上游 AI 政策 profile` | 讓使用者向 kernel、LLVM、QEMU 等專案貢獻時，依該專案政策警告或限制（B9）；profile 帶來源 URL 與讀取日期，過期警告；不構成法律意見 | V1 | profile 格式與至少三個範例；過期偵測；預設 Ask；禁止 AI 的專案直接警告 |

### 建議擴充既有 issue（需擁有者同意；本 PR 不留言）

| issue | 建議補入 | 對應項目 |
|---|---|---|
| [#55](https://github.com/ChiJiun/agentdock/issues/55) | ruleset 設定匯出入 repo 並定期比對；workflow 權限與 action pin；跑 Scorecard；（V1）簽章；CODEOWNERS 與高風險路徑（取決於 D1） | A7、A8、A9、A16、B21 |
| [#41](https://github.com/ChiJiun/agentdock/issues/41) | PR 範本加「測了什麼、沒測到什麼」與「禁止為了通過而改測試」 | A5 |
| [#49](https://github.com/ChiJiun/agentdock/issues/49) | 證據綁定 `base_sha`／`head_sha`／候選 SHA、先序列的本機整合佇列、事件重建與對帳、送入佇列才 restack、風險分級標籤、tree 狀態、clean revert 快速通道 | B1、B3–B5、B15、B17、B19、B20 |
| [#48](https://github.com/ChiJiun/agentdock/issues/48) | 只有受控 runner 能寫入證據；證據 key 含 toolchain 版本與環境白名單；main 基準結果 | B1、B2、B13 |
| [#47](https://github.com/ChiJiun/agentdock/issues/47) | 依 crate 反向依賴選測；`Cargo.lock`／`build.rs`／toolchain 變動時升級為全量；失敗時在 base 重跑判定 flaky | B12–B14 |
| [#9](https://github.com/ChiJiun/agentdock/issues/9)／[#8](https://github.com/ChiJiun/agentdock/issues/8) | agent 專屬分支前綴與只能 push 自己的分支；任務授權範圍與在途變更數上限 | B6、B16 |
| [#52](https://github.com/ChiJiun/agentdock/issues/52) | 收納 V2 候補：agent 網路存取限制、batching 與自動二分、stack-aware queue | B24–B26 |

與驗證流程相關的 [#66](https://github.com/ChiJiun/agentdock/issues/66)、[#70](https://github.com/ChiJiun/agentdock/issues/70)（Lauren Tan 式 deterministic guardrails、驗證等級）和本文件 B1、B2、B12–B14（證據綁定 SHA、受控 runner、選測）主題相鄰；本研究**沒有**逐條比對 #66／#70 的內文，合併規劃時應由 #66／#70 的 owner 確認是否重疊。

## 10. 後續待更新（不在本 PR）

| 檔案 | 建議更新 | 原因 |
|---|---|---|
| `docs/research/agentdock-capability-map.md`、`docs/research/local-first-multiagent-sdlc.md`（PR #57） | 引用本文件 A1–A19、B1–B27 與 NI-V1–V5，把治理缺口列入能力地圖與分期 Gate | PR #57 正在改 |
| `docs/roadmap.md`（PR #57） | V1.0 DoD 的「human-approved merge boundary」連到第 5 節與 D1；alpha 項目對照 A7、A8、A10、B1 | PR #57 正在改 |
| `docs/PRD.md`、`docs/architecture.md`、`docs/sources.md`（PR #57） | 若採 NI-V4／NI-V5，PRD 加入「AI 揭露與人類簽核」「上游政策 profile」；`sources.md` 納入本文件的來源 | PR #57 正在改 |
| `AGENTS.md`、PR 範本、`.github/` 設定、ruleset | 依 D1–D6 的決定另案修改 | 擁有者決定；**本 PR 不改** |
| `docs/tasks/`（PR #68） | 若採 NI-V4，P7-2（commit／push／PR）補 trailer 與人類簽核 | PR #68 尚未合併 |

## 11. 未驗證與限制

- 本文件只是整理研究結果。除了第 5 節的 ruleset 現況是撰寫本 PR 時以 `gh api` 讀取之外，所有 URL 的內容都沿用 2026-11-27 的研究讀取結果，**撰寫階段沒有重新抓取來源**。
- 如開頭引言所述，WebFetch 回傳的是摘要工具產生的內容，不是原文；標「未驗證」的項目只見於搜尋摘要或二手報導。尚缺一手資料的項目：Meta land queue、Chromium／Kubernetes／EIP 的 AI 政策、eip-review-bot 的 automerge 規則、kernel 2026-07 patch 是否已併入主線、GitHub squash merge 的簽章行為。決策前需補查。
- 政策與標準（Scorecard、SLSA、各專案的 AI 政策）變動頻繁；第 4 節表格的內容在決策前請重新確認。這些政策約束的是對那些專案的貢獻，不約束 AgentDock 自己的 repo。
- 第 6、7 節的「優點」「成本／適用規模」「建議階段」「風險」欄位與新增的「對應」欄都是推論或依 issue 標題與內文開頭做的判斷，部分 issue 的細節沒有逐條比對。
