# Research: Orca ADE and the "Grok Bot + Jev/Laya" decision-layer pattern

Status: research note, 2026-11-17; facts about Grok Build, Grok Bot, Orca and OpenMausBot refreshed on 2026-11-27 (see [section 2](#2-how-this-was-checked) and the "Update 2026-11-27" markers). Refs [issue #30](https://github.com/ChiJiun/agentdock/issues/30). Written in English to match the other documents under `docs/`.

**No third-party code, text or asset was imported by this note.** It records what was read, what was measured, and what AgentDock could adopt. Every adoption item below still needs its own issue and PR; anything that copies code must use the migration PR template in [sources.md](../sources.md#required-source-migration-pr-template) and the rules in [ADR-0002](../decisions/0002-source-reuse.md).

The owner's request, verbatim: 「我今天看到grok bot特殊的設計好像有用到jev/laya這種工具；另外Orca的開發流程我也有興趣；我想要把這些都納入」.

## Contents

1. [Summary](#1-summary)
2. [How this was checked](#2-how-this-was-checked)
3. [Part A: Grok Bot and "jev/laya"](#3-part-a-grok-bot-and-jevlaya)
4. [Part B: Orca](#4-part-b-orca)
5. [Combined adoption list](#5-combined-adoption-list)
6. [Source table](#6-source-table)
7. [Issue #30 checklist](#7-issue-30-checklist)
8. [Proposed new issues](#8-proposed-new-issues)
9. [Not verified](#9-not-verified)

## 1. Summary

- **"Grok bot" + "jev/laya"** (section 3): high confidence it means Grok Bot (xAI) plus TypeSafe's Jev and the open-weight Laya decision models, as a *community pattern* of a cheap typed decision layer. Which post the owner saw is unknown; owner confirmation needed.
- **OpenMausBot** (section 3.8, added after the owner's follow-up "also see OpenMausBot"): `milind-soni/OpenMausBot`, Apache-2.0 plus a source-available `enterprise/` folder, an independent open-source alternative to Grok Bot that **ships a Jev decision-model integration** (`docs/decision-model.md`). It is the closest real implementation of the pattern in Part A.
- **Grok Build** (section 3.4, **updated 2026-11-27**): no longer a proprietary closed runtime. xAI open-sourced it on 2026-07-15 as [xai-org/grok-build](https://github.com/xai-org/grok-build) under Apache-2.0, and it is itself an ACP **agent server** (`grok agent stdio`, plus a WebSocket mode). It remains an external runtime AgentDock would drive, never bundle or copy.
- **Orca** (section 4): MIT Electron ADE; worktree-per-task, four-state agent status, OSC 7501 status protocol, batched diff annotations, orchestration completion contract. Orca's own workflow is high-throughput and not independent-review; several defaults (full-autonomy launch, auto-merge, force delete) conflict with AgentDock rules.
- **Nothing was copied.** Every item is a pattern or protocol integration (sections 3.7, 3.8, 4.7, 5).

## 2. How this was checked

Read-only: GitHub REST (`gh api`), a pinned read-only checkout of Orca, repository documents fetched at pinned SHAs, official vendor documentation, and independent write-ups, all on 2026-11-17 and 2026-11-18. Nothing was built, installed or run. Each section says what was read and what was not; section 9 collects the gaps.

**Update 2026-11-27.** The facts below about Grok Build, Grok Bot, Orca and OpenMausBot were refreshed from a newer, separate verification note (read-only `gh api` at the pinned SHAs in [section 6](#6-source-table), plus official pages; nothing cloned, built or run, no third-party code or text copied). Where a statement was re-read that day it is marked "re-read 2026-11-27" or carries the newer SHA; statements not re-read keep their 2026-11-17 / 2026-11-18 basis. The Part A and Part B designs, the adoption lists and the AgentDock rule mapping were **not** re-derived on 2026-11-27 beyond the facts called out below.

## 3. Part A: Grok Bot and "jev/laya"

### 3.1 What the owner most likely saw

| Term | Most likely meaning | Evidence | Confidence |
| --- | --- | --- | --- |
| "Grok bot" | **Grok Bot**, the always-on agent product from xAI (documented at `docs.x.ai/grok-bot/`), launched as an early beta on 2026-08-11 | Official docs pages read (section 3.4); VentureBeat launch report dated 2026-08-11 | High |
| "jev" | **Jev**, TypeSafe AI's hosted "System One" decision model: it returns typed answers with probabilities and generates no text | Official docs and launch post read (section 3.2) | High |
| "laya" | **Laya**, the open-weight (Apache-2.0) decision model from Convai Innovations that serves the same wire protocol as Jev | Repository README read at a pinned SHA (section 3.3) | High |
| "Grok bot's special design uses jev/laya" | A **community pattern**, not a built-in Grok Bot feature: a Grok Bot skill tells the bot to ask Jev (or a local Laya) a few typed questions before expensive or risky steps | Four community repositories and three write-ups (section 3.5). The Grok Bot official pages that were read never mention Jev, TypeSafe, Laya, "decision model" or "System One" | High for "this is the pattern"; **unknown which post the owner saw** |

Why the confidence is high for the pairing: GitHub has a cluster of repositories named after exactly this combination (`grok-jev-router`, `grokbot-jev-skills`, `grok-jev-reflex`, `grok-bot-jev`), and a community write-up is titled "Jev + Laya + AI agents, in 12 steps".

What stays open, and needs the owner's confirmation:

- **Which post or article the owner saw.** One candidate, an X post by Brian Roemmele whose title is about Grok Bot running out of plan usage, could not be read (x.com returned HTTP 402). If the owner saw a different design (for example the tool-list pruning idea or the multi-agent "company in a box" write-up), the priorities in section 3.7 may change.
- **Other things named "Laya"** that were ruled out as less likely, listed so the owner can correct this:
  - [aayushch/laya](https://github.com/aayushch/laya) (Apache-2.0, 827 stars): a local-first notification command center that aggregates Slack, Gmail, GitHub and other notifications with local LLMs. It is thematically close to Session Sentinel, but it has no link to Grok Bot or Jev. If this is what the owner meant, it deserves its own short review.
  - LayaAir (a game engine): unrelated.
- No repository `jev/laya` exists on GitHub (`gh api repos/jev/laya` returns 404), so "jev/laya" is read as "Jev and Laya", not as an owner/repo path.

### 3.2 Jev (TypeSafe AI): official facts

Read from `docs.typesafe.ai` and `typesafe.ai` on 2026-11-17. Numbers marked "vendor claim" were not measured here.

- **What it is.** A hosted model that takes a `state` (string, object or array) plus typed `questions` and returns one typed answer per question with probabilities. It does not generate text. Provider: TypeSafe AI, Inc. Launched 2026-09-15 and still labeled **early access**; no page read says GA.
- **API.** `POST https://api.typesafe.ai/v1/systemone` with a bearer key. Four question types:
  - `choice`: pick one of up to 255 options; returns `choice`, `probabilities`, `confidence`.
  - `score`: grade against an ordered rubric of up to 10 levels; returns the expected `score`, `probabilities`, `confidence`.
  - `noul`: yes/no; returns a probability from 0 to 1 and no `confidence`.
  - `box`: a location in an image.
- **Models.** `jev-1.14.0` and `jev-1.13.0` are version IDs; `jev-latest` and `jev-preview` are aliases that move. The docs advise sending a version ID once thresholds are tuned, because an alias can change answers without a code change.
- **Limits.** 64k tokens per request and 32k per question by default; 32 MiB body; rate limits are per organization.
- **`confidence` is not the probability of being right.** It is computed from the same probabilities and measures how concentrated they are. For `choice` with `n` options: `(p_max - 1/n) / (1 - 1/n)`. The docs advise putting a threshold on the probability of the option the program will act on.
- **SDKs.** Python `typesafe-sdk` and npm `@typesafe-ai/sdk`. No Rust SDK. The SDK license is not stated on the pages read.
- **Price and latency (vendor claims).** $0.042 per million input tokens, output currently free; 70 to 500 ms end to end. The launch post itself says its headline speed and cost ratios come from the vendor's own workflow evaluations and sit at the high end.
- **Data handling.** The privacy policy says inputs are not used for training. Inputs are collected and kept "as long as reasonably necessary", with no number of days. The service is hosted in the United States. Zero data retention is mentioned for enterprise customers only.
- **Limits the vendor documents.** Literal reading of questions; unreliable arithmetic, counting and date comparison; accuracy drops when `state` is large and mostly irrelevant; a bias toward earlier options in `choice`; and **adversarial content in `state` can change the answer** (injected instructions, misleading framing).
- **Not on the pages read:** self-hosting, open weights, Laya or other compatible servers, "shadow mode", "fail open" or "fail closed".

### 3.3 Laya (Convai Innovations): repository facts

Read from [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) `README.md` at `b1d656952f0f9581ea691a70cb6f38abf3eb13a9` (2026-11-16). License: Apache-2.0 (root `LICENSE`; the README states the weights are Apache 2.0 as well).

- **What it is.** An open, non-autoregressive decision model: a bidirectional encoder with a decision head. Checkpoints `laya` (English, 512-token context), `laya-multilingual` and `laya-typed-decisions` (1,024 by default).
- **Same wire protocol.** `laya.serve` (the `laya-serve` HTTP server) exposes `POST /v1/systemone` with the same answer shape as Jev, plus `POST /v1/systemone/batch`. The README states an existing Jev client only needs a different base URL. An MCP server is optional.
- **Differences from Jev that the README lists.** At most 100 `choice` options per question on the HTTP server; options share a small token budget, so accuracy falls off above about 20 options; and **`confidence` uses a different formula** (1 minus normalized entropy), so a threshold tuned on Jev does not transfer.
- **Accuracy caveats stated by the project itself ("Honest limits").** The base checkpoints score 0.362 and 0.352 on its typed-decisions benchmark against a 0.318 random baseline; the 0.766 figure is for the checkpoint fine-tuned on that benchmark's training split. On Banking77 the README reports Jev 0.870 and Laya 0.425, and notes the Jev figures are third-party published and were never measured by the Laya project. Negated requests can be misread with very high probability (one example: 0.9998).
- **Runtime.** A Python package (`pip install laya`, Python 3.10+) built on PyTorch, with an ONNX option. The repository has `laya-rust`, `laya-ts`, `laya-go` and other binding directories; `laya-rust` has its own `Cargo.toml`. Whether `laya-rust` is published on crates.io, what it depends on, and whether it runs on Windows were **not checked**.
- **Related open projects, recorded for completeness** (not reviewed beyond repository metadata): [jaredpalmer/kev](https://github.com/jaredpalmer/kev) (Apache-2.0, Jev-like models on Qwen that serve the same endpoint) and [ollaya-dev/ollaya](https://github.com/ollaya-dev/ollaya) (Apache-2.0, a server for several open decision models behind `/v1/systemone`).

### 3.4 Grok Bot and Grok Build: official facts

Read from `docs.x.ai/grok-bot/` and `x.ai/news/grok-build-cli` on 2026-11-17. Grok Bot's `overview`, `chat-and-collaboration`, `approvals-security-and-privacy` and `faq` pages were re-read on 2026-11-27, and Grok Build was re-researched from its open-source repository the same day (below). Naming on 2026-11-27: the Grok Build README and `LICENSE` say SpaceXAI, while the x.ai and docs.x.ai pages read say SpaceXSI; the company naming is not settled here and is not relied on.

**Grok Bot** is a proprietary, closed-source product. Only its public documentation was read; nothing from it can be copied (text, assets or implementation).

Update 2026-11-27 (re-read; the 2026-11-17 points below still hold unless noted):

- The 30-minute expiry of cards raised by routines, incoming messages or background work, the *Allow once* / *Always allow* / *Deny* choices, the *Ask first wins* rule (up to 20 rules per kind, 1,000 characters each) and "only the requester approves; no *Always allow* in group chats" were seen again on the approvals page (the chat-and-collaboration page separately says approval requests do not appear in a group chat). The approvals page also says Auto Review treats only the user's own messages as requests, and "Do not use separate Bots as a security boundary".
- Plans: included with X Premium, Super and Ultra (and the legacy Cursor plans); Plus and Free do not include it. The FAQ lists **no US-dollar price**; third-party prices contradict each other, so **price is unverified**. Platforms: macOS, Windows and Linux desktop, iPhone, iPad and Android. Sign-in uses a Cursor account. Usage depends on the plan route (per the FAQ): with an X Subscription it draws from the same weekly usage pool as Cursor and the Grok apps; with a legacy Cursor plan it is metered on the Cursor account, separately from SuperGrok, except that an account linked to SuperGrok or X Premium+ uses whichever grants more weekly usage (the two do not add up). Grok Bot picks the model per task and the user cannot choose it.
- The overview and FAQ pages read still do **not** mention ACP, Grok Build, a public API or open source. The technical relationship between Grok Bot and Grok Build is **unverified**.
- Enterprise "Inference Hooks" (below) were **not** re-verified; the approvals page read on 2026-11-27 does not mention them. Treat that bullet as 2026-11-17 information.

- All Bots of one user share **one persistent cloud computer** (browser, command line, filesystem, `/workspace`). The docs say a Bot's screen is not a security boundary and that files, browser sessions and command-line credentials are visible to every Bot on the account.
- **Skills** are reusable task instructions; **routines** run a skill on a schedule or on an event (Slack, GitHub, Linear, e-mail, webhook), with documented rate limits.
- **Auto Review** is an independent review model that checks each action before the Bot runs a command, uses a connected app or uses the computer. Most actions run; some produce an **approval card**. Details that matter for AgentDock's approval design:
  - Card choices: *Allow once* (no rule stored), *Always allow* (stores an allow rule), *Deny*.
  - Custom rules are plain-language, either *Allow automatically* or *Ask first*; when both match, **Ask first wins**; built-in safety checks always apply.
  - Cards raised by a routine, an incoming message or background work **expire after 30 minutes**; cards raised from chat do not.
  - In a team or group chat, only the person who made the request can approve, and *Always allow* is not offered.
  - Only the user's own messages count as instructions; e-mail and web text do not.
  - Auto Review can be switched off, after which the Bot runs without checks.
- There is no user-level lifecycle hook (pre or post tool call). Enterprise "Inference Hooks" (beta) send each model request to the organization's own security server, and new configurations start in a shadow mode.
- MCP servers and plugins are supported. **ACP is not mentioned on the Grok Bot documentation pages read**, and there is no documented headless mode or public API that drives a Bot conversation.

**Grok Build** is xAI's terminal coding agent. History: announced as an early beta on 2026-05-25 (the announcement stated plan mode, parallel subagents, "deep worktree integrations", a headless mode `-p`, `AGENTS.md`, plugins, hooks, skills, MCP servers, and "full ACP support"). **Update 2026-11-27 — it is now open source and the earlier "proprietary" label is out of date:**

- **Open source.** Announced 2026-07-15 ([x.ai/news/grok-build-open-source](https://x.ai/news/grok-build-open-source)); repository [xai-org/grok-build](https://github.com/xai-org/grok-build), Rust, created 2026-07-14, `has_issues=false`. Read at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` (2026-09-29, "Synced from monorepo"). Root `LICENSE` is **Apache-2.0**, "Copyright 2023-2026 SpaceXAI"; the README says first-party code is Apache-2.0 and third-party or vendored code keeps its own license. Third-party reports say the open-sourcing followed a cloud-upload incident that exposed SSH keys and repositories; the official page does not say so, so treat that as unconfirmed second-hand reporting.
- **It is an ACP agent server.** The user guide (`15-agent-mode.md`) documents `grok agent stdio` and `grok agent serve --bind 127.0.0.1:2419 --secret <token>` (WebSocket). ACP covers session create, load and resume, prompt and streaming, tool-call updates, thought streaming, plans and permission requests, plus many private `x.ai/*` extension methods (git, worktree, terminal, rewind, session fork). `Cargo.lock` pins the Rust `agent-client-protocol` crate at 0.10.4. The user guide lists compatible clients (Zed, Neovim, Emacs, marimo; JetBrains "coming soon") and recommends `--always-approve` (alias `--yolo`) for scripts, CI, evals and agent servers, and `session/new` `_meta` can set `yoloMode`. **Not tested here:** the real `initialize` response, the protocol version, and behavior on Windows.
- **Windows.** The README offers a PowerShell installer and prebuilt Windows binaries, but says Windows builds are best-effort and "not currently tested from this tree". The sandbox (Landlock on Linux, Seatbelt on macOS) is not documented for Windows.
- **Contribution model.** One-way sync from an internal monorepo; the repository accepts no external pull requests. The last sync was 2026-09-29, so published binaries may be newer than the source (inference).
- **License review needed before any copy.** `THIRD-PARTY-NOTICES` lists mostly MIT and Apache-2.0 dependencies but also MPL-2.0 packages, a vendored `libgit2` (inside the `libgit2-sys` crate) under "GPL-2.0 WITH linking exception", and in-tree ports adapted from openai/codex (Apache-2.0) and sst/opencode (MIT). This note still recommends **no code reuse**; AgentDock would only talk to the `grok` binary over ACP.
- Product features that could inform AgentDock's UX (an agent dashboard that answers permission requests in place, plan mode with line comments, subagents with worktree isolation) were seen in its user guide but are **not** analyzed in this note.
- Unverified: whether Grok Bot and Grok Build share a runtime, the latest released binary version and changelog, and the exact `x.ai/*` method set (the docs say the list is not exhaustive).

### 3.5 The community pattern: a cheap typed decision layer in front of an agent

Sources: four repositories (README only, at the SHAs in [section 6](#6-source-table)) and community write-ups. **None is official and none has a reproducible benchmark.** The directory site `madewithjev.com` states it is not affiliated with TypeSafe and that all figures come from the post authors.

How it works:

1. The user installs a skill in Grok Bot. The skill says: before a browser run, research, a retry or starting another bot, call a small router and follow the action it returns.
2. The router sends a short summary of the step (the `state`) and a fixed set of typed questions to Jev in one request, for example "is the task already done?", "is this action reversible?", "does it leave the account?", "is this the same failing retry?".
3. Plain code turns the probabilities into one action. Examples from the READMEs: `proceed`, `dry_run`, `ask_human`, `skip`, `reuse_cache`, `stop_retry`, `research_capped`, `chat_only`, `allow_subagent`.
4. In the hybrid variant, a local Laya answers routine, high-volume questions; uncertain or high-risk ones go to Jev; a material disagreement between the two goes to a person.

Design rules these projects share:

- **The model may only make the agent do less or ask more.** It never approves something irreversible. Hard rules in code override the model: anything that leaves the account, is irreversible, is looping or has low confidence goes to a person.
- **It is advice, not enforcement.** Grok Bot has no hook, so the bot must choose to call the router. The READMEs say so plainly ("a rule it follows, not a hook inside it").
- **Shadow mode first.** The router logs what it would have decided next to what the bot actually did; a report shows the disagreement rate; only then is it switched to active. There is a kill switch.
- **Fail open** in these projects: when Jev is slow or down, the full tool list or the default path is used. One project lists per-command fallbacks, for example "wake" for a notification decision and "needs attention" for every message in a mail sort.
- **Govern effects, not tool names.** Reading, searching, testing and drafting run automatically; publishing, deploying, spending, deleting and exposing secrets need a person.
- **"No proof, no done."** A completion check is a judgment; verifying that a file was saved or a message was sent is separate, and a high-confidence answer does not prove it.
- **Keys and data.** Use a dedicated key with a spend cap; never paste it in chat; pass summaries rather than transcripts.

What it is claimed to fix, with author-reported numbers only:

- Tool-list size: 25 tool definitions on every call reduced to 8, first prompt 17.8k to 9.5k tokens (reported for Grok Build by a third party; not reproduced).
- Wasted work: repeated identical retries, re-opening a page whose result is already cached, uncapped research.
- Waking an expensive orchestrator for every event.

Criticism recorded in those same sources:

- A typed answer always fits the schema, but it can still pick the wrong branch.
- Confidence thresholds must be re-tuned per model, per version and per question wording.
- Escalating low-confidence answers to a larger model does not catch **high-confidence errors**: one analysis found that on Jev's 84 most confident mistakes, three LLM judges repeated the same answer in 242 of 252 judgments (a community write-up; the exact source was not recorded in this note and the figure was not reproduced).
- A screen built on the decision model can itself be steered by injected text.
- **Independent evaluation** ([Anaconda, 2026-10-20](https://www.anaconda.com/blog/decision-time), full text read): on 2,400 held-out CFPB complaints, zero-shot Jev scored below always guessing the majority class on all three questions; after the rules were written into the prompt it reached 82% on one question and 54% and 55% on the others, still below a classifier trained on the structured fields alone. Reordering options changed the answer in 1 of 80 cases but moved probabilities by up to 0.20 (7 cases crossed a 0.9 threshold); identical requests differed by up to 0.04; `confidence` is not a second accuracy estimate. Takeaway: good when label meaning is generic, weak when labels depend on one's own rules or history, so thresholds must be tuned and re-checked per question.

### 3.6 Fit with AgentDock's rules

| AgentDock rule | Consequence for this pattern |
| --- | --- |
| "No hidden model or tool interception" for external ACP agents (`AGENTS.md`) | **Tool-list pruning is out.** AgentDock does not see or rewrite the tool list that Claude Code or Codex sends to its model. Context compaction and per-turn model routing are also owned by the agent |
| Privileged operations are enforced by Rust policy, not by prompts (`AGENTS.md`); an extension may tighten but never approve (APR-1 in ADR-0002) | A decision model can only ever move a host-controlled operation from "allow" to "ask". It cannot be an approver |
| A safety component that times out or crashes must fail closed (APR-2, X-3) | The community default (fail open) is acceptable only outside the approval path. Inside it, a failed call means "ask" |
| "Polls should not incur model fees"; no secret exfiltration; treat tool output and issue text as untrusted (PRD, architecture) | Hosted Jev sends session text to a US-hosted third party and bills per token: it must be opt-in, off by default, and disclosed per call site. A local Laya avoids the transfer but adds a Python/PyTorch runtime |
| No misleading capability claims (PRD) | The UI must say a classifier's answer is a probability from an optional component, show which model and version answered, and never present it as a verification |
| Deterministic stop conditions for the review loop (PRL-3 in ADR-0002) | The stop function stays a pure function over raw facts. A classifier may at most label free text (for example the category of a reviewer finding) and that label must be stored as evidence with its probability |

### 3.7 What AgentDock could adopt from Part A

Approach vocabulary: **pattern** (interaction or process reference, no code), **protocol** (talk to an external process or service over a public protocol), **dependency** (consume a published package), **copy PR** (needs a migration PR). None of the items below is a copy PR.

| ID | Item | AgentDock target | Approach | License and source | Main risks |
| --- | --- | --- | --- | --- | --- |
| A1 | Optional **decision provider**: a small Rust trait plus an HTTP client for the `/v1/systemone` wire protocol with a configurable base URL (hosted Jev, or a self-hosted `laya-serve` on loopback). Off by default; pinned model version ID; every call recorded as an event with model, version, question set, probabilities and latency | New feature; closest to #13 (cost-aware orchestration) | Protocol | No code needed. Jev is a proprietary hosted API (terms not reviewed). Laya is Apache-2.0 at `b1d65695…` and would run as a separate process, not be bundled | Data leaves the machine with hosted Jev; early-access API; alias drift; calibration differs per model; one more runtime to install for Laya |
| A2 | **Sentinel triage on free text**: for events that have no typed signal (for example an agent's closing message that asks a question in prose), a classifier may *raise* an inbox item. Typed events (approval requests, errors, completion) stay rule-driven. Failure or low confidence means "notify" | #15 | Pattern, on top of A1 | As A1 | A wrong "stay silent" hides a needed decision, so the classifier is never allowed to suppress or archive an item; prompt injection through agent output |
| A3 | **Shadow-mode rollout** for any new automated judgment: log the judgment next to what the person actually did, report the disagreement rate, keep a kill switch, activate per judgment type | #13, #10, #14 | Pattern | None | Needs enough logged decisions to mean anything; a report nobody reads gives false comfort |
| A4 | **Effect-based autonomy ladder** (read, prepare, reversible write, external action, money or irreversible) as the vocabulary for operation classes | #8 | Pattern | None | Overlaps the default "ask" set already listed in APR-10; adopt the vocabulary, keep the existing rules |
| A5 | **"Judged complete" is not "verified complete"**: keep completion claims separate from evidence checks in the timeline | #10 (evidence gates), #15 | Pattern | None | None beyond wording; it matches TR-1 in ADR-0002 |
| A6 | **Bounded assignment packet** for child and reviewer sessions: one owner, one goal, approved inputs, expected output, forbidden actions, definition of done | #10, #13 | Pattern | None | Packet text is still a prompt; limits that matter must also be enforced by backend scope |
| A7 | **Approval card details from Grok Bot's public docs**: "allow once" versus "always allow" creating a visible rule; ask-rules beat allow-rules; cards from non-interactive triggers expire; only the requester approves; an "cannot be undone" label | #8, #15 | Pattern (public documentation of a proprietary product; no text or asset reuse) | Proprietary; documentation read only | Copying wording or layout too closely; AgentDock must use its own copy and visuals |
| A8 | **Grok Build as a third ACP adapter candidate** | #6 | Protocol (external runtime, never bundled) | Apache-2.0 open source (`xai-org/grok-build` at `2bdd1d6a…`, re-read 2026-11-27); it is an ACP agent server. The user installs the binary; AgentDock copies nothing. Bundled third-party parts include MPL-2.0 and a GPL-with-exception `libgit2` (section 3.4) | ACP support is now documented in the open source tree, but the real `initialize` response, protocol version and Windows behavior are untested. Its recommended automation mode is always-approve and `_meta.yoloMode` exists, so AgentDock must never send it and must say it cannot intercept in the agent's own bypass mode. Many capabilities are private `x.ai/*` methods, so they can only be optional, capability-gated extras. ADR-0002 already lists Grok extension methods (`ask_question`, `exit_plan`) as compatibility notes |
| A9 | **Tighten-only classifier gate** on host-controlled operations (may turn "allow" into "ask", never the reverse; fail closed) | #8 | Pattern, on top of A1 | As A1 | Low value next to deterministic policy, and it adds latency and a new input that can be steered. **Recommendation: do not build until A3 data shows a need** |

Excluded, with reasons:

- **Tool-list pruning, compaction by a decision model, per-turn model routing of an external agent:** these require intercepting the agent's model requests, which `AGENTS.md` forbids and ACP does not expose.
- **Copying any of the community routers:** they are small MIT Python scripts tied to Grok Bot's skill folder; the idea is the reusable part.
- **Letting a decision model approve, merge, push or delete:** against APR-1 and the PRD.
- **Using a decision model as a prompt-injection filter that the system relies on:** the vendor documents that injected text can change the answer.

### 3.8 OpenMausBot (added on the owner's follow-up)

**Identification.** Spelling confirmed as `OpenMausBot` (also "MausBot"; the README says "formerly OpenGrokBot"). Several same-name repositories exist (forks, a Chinese localization, `OpenMausBot/OpenMausBot` with 10 stars that only hosts downloads, `harmanhanjra/OpenMausBotV2`). **The one used in this note, provisionally, is [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot)**: it is the one the others describe themselves as forks of or plugins for, and its homepage is mausbot.com. **That this is the project the owner meant is not confirmed; it stays pending the owner's answer in [issue #34](https://github.com/ChiJiun/agentdock/issues/34).** Star and fork counts: about 25,000 and 3,500 on 2026-11-18; **28,230 stars and 4,022 forks on 2026-11-27** (`gh api`). Their authenticity was not checked.

| Item | Value |
| --- | --- |
| Pinned commit | First read at `21acf05ca7d28a937e4b27558e2e7c7885018b43` (2026-11-18T08:16Z). **Re-read 2026-11-27 at `54ab8e3afafe4460a9c6d5241e498d849de3d318`** (2026-11-27 04:42 UTC), documents only: `LICENSING.md`, `docs/approval-levels.md`, `docs/decision-model.md`, `docs/usage-caps.md`, `docs/runtime-contract.md`. Created 2026-08-11, the day Grok Bot launched; releases almost daily (v0.1.169 on 2026-11-17; **latest release v0.1.184 on 2026-11-26**, with a Windows `OpenMausBot-0.1.184-setup.exe`, dmg, AppImage, deb and rpm); one maintainer dominates (6,711 of the commits by `milind-soni`, as of 2026-11-18) |
| License | Apache-2.0 (`LICENSE`), relicensed from MIT per `NOTICE`. **`enterprise/` is source-available under a separate license, not Apache** (`LICENSING.md`, re-read 2026-11-27: readable, buildable and evaluable, but production use needs a license key; deleting the folder gives the OSS edition). Bundled `third_party/` keeps its own licenses (MIT mostly; Playwright, Puppeteer and Vexa are Apache; not re-checked). The names and mascot are trademarks of Supamaus Software Private Limited. The `enterprise/` license text itself was not read |
| Relation to Grok Bot | Independent, "inspired by" it, "not affiliated with xAI"; imports an existing Grok Bot through an adapted MIT plugin. Not a fork of anything from xAI |
| Stack | Electron + React + TypeScript; local harness server on `127.0.0.1:8799`; drivers for the `claude`, `codex` and `grok` CLIs (stream-JSON, JSON-RPC, ACP) plus any custom ACP agent; MCP server; headless CLI |
| Windows | Released Windows x64 installer (not code-signed) |

**Design points relevant to AgentDock** (from `README.md`, `docs/decision-model.md`, `docs/approval-levels.md`, `docs/runtime-contract.md`, `docs/sentinel.md`, `docs/usage-caps.md`, `docs/pausing-bots.md`, all at the pinned SHA):

- **Re-read 2026-11-27 (documents only, at `54ab8e3a`):** approval levels are *Ask for approval*, *Auto-accept edits*, *Approve for me*, *Full access* and Codex-only *Custom*, each mapped to the engine's own permission mode where the engine has one (API engines are gated by OpenMausBot's own tool gate), with no silent widening when a mode is rejected (the document states this generally; that it covers Grok Build is an inference, since Grok Build is listed among the engines with their own modes); **every bot and conversation still starts at Full access** (the hosted company workspace default stays Ask), and choosing Full access takes effect without a confirmation dialog; a thread takes the level of the conversation that opened it, and external sources such as webhooks can lower but never raise a level. Usage caps (`dailyUsd`, `monthlyUsd`, `dailyTokens`, `monthlyTokens`, per server and per bot, unset by default; dollar figures are notional under a subscription) and the `Assignment` runtime contract (SQLite, append-only events, exactly-once report, stall detection) match the description in this section. The `SECURITY.md`, `sentinel.md` and `pausing-bots.md` statements below, and the "never mid-turn" cap behavior, were **not** re-read and keep their 2026-11-18 basis.
- **Decision model is real and shipped.** Providers: TypeSafe Jev (default), Cloudflare Workers AI, OpenRouter, or a custom endpoint speaking System One or OpenAI Decisions. Used for "who answers in a room" and inbox triage. Threshold 0.6 on the top probability; **fails open** to the room's lead; every answer is validated; 1.5 second budget; each call logged as an NDJSON row with provider, probability, latency and a hash of the state (never the text). The documents state what leaves the machine for each provider. This confirms pattern A1 and A3 is workable, and shows a custom endpoint is how a self-hosted Laya would plug in.
- **Provenance labels.** Every line an agent reads starts with a harness-written `[From <who> · <what> · <authority>]` note; model-written text that imitates it is escaped; a relayed "approved" from another bot, webhook or outside page is information only. Matches APR-1 and PRL-8 (untrusted text is rendered quoted so it cannot spoof an approval card) and the architecture rule that tool output and issue text are untrusted; adopt the idea.
- **Job runtime contract** (`docs/runtime-contract.md`): one assignment record with a lifecycle, append-only event table, exactly-once result report, restart policy that never re-runs a turn that already acted outward, per-root budgets, invariants asserted after every test scenario. Strong reference for ADR-0003 and #10.
- **Usage caps** that stop *unattended* work first, never mid-turn; **pause** switch that returns a typed "held" error.
- **Health scanner ("Sentinel")**: plain code, read-only, out-of-process, groups failures by a normalized signature; no model calls. Same name as AgentDock's Session Sentinel but a different thing (log health, not an attention inbox).
- **Not to adopt:** **default approval level is Full access**; a Chief's level flows down to delegated bots; `Approve for me` relies on the provider's own auto review; a documented, unclosed risk lets a bot's shell reach Full-access threads (`SECURITY.md`); plaintext secrets for some settings; cloud computer and Composio connectors are third-party services. These conflict with backend-enforced approval (#8, APR-1).
- **Tool selection** (allow and exclude selectors) works for API engines OpenMausBot itself runs; for external CLIs it is limited, so it does not change the exclusion of tool-list pruning in section 3.7.

**Additional adoption items** (pattern or protocol only; no copy): **C1** provenance labels and escaping of look-alike notes (#8, #15); **C2** assignment record, restart policy and invariant-style tests (#10, ADR-0003); **C3** unattended-first usage caps and a pause switch (#13); **C4** decision-call log schema for A1 (state hash, never text); **C5** signature-based failure grouping for #15. Risk common to all: single-maintainer, fast-moving project; its docs were read, its source was not audited.

## 4. Part B: Orca

### 4.1 Snapshot and license

| Item | Value | How it was checked |
| --- | --- | --- |
| Repository | [stablyai/orca](https://github.com/stablyai/orca), default branch `main`, created 2026-03-17 | `gh api repos/stablyai/orca` |
| Pinned commit | `c1da9cbe717d614575553f559a1a8feefff4d774` (2026-11-17 09:50 UTC, "fix(sidebar): … (#43558)"), the SHA named in issue #30. `main` had already moved to `9fe58fd7729cc1111e503c98b28c0deba70534b7` 28 minutes later | `gh api …/commits/<sha>`; local read-only fetch, `git rev-parse HEAD` |
| License | MIT, `Copyright (c) 2026 Lovecast Inc.` (`LICENSE:3`). GitHub reports SPDX `MIT` | File read |
| Other license markers | No `NOTICE` or `THIRD_PARTY*` file in the repository root. `package.json` has no `license` field. `src/main/acp/generated/acp-protocol.generated.ts:2` carries `SPDX-License-Identifier: Apache-2.0` (generated from the official ACP schema v1.21.0), so **not every file is MIT** | File reads |
| Stack | Electron 43 + TypeScript + React 19; `node-pty`, `ssh2`, `i18next`, `zustand`, `monaco-editor`, `zod` | `package.json` |
| Size | 39,189 tree entries; `src/main` about 13,000 files, `src/renderer` about 10,700 | Tree listing |

**Update 2026-11-27.** Re-read at `main` = `a6fb44ab972622b52ec1d7d696ebb4b9ff56f6ab` (2026-11-27 05:03 UTC; the repository description now reads "run a fleet of bots with your own subscription (e.g. Claude Code, Grok, Agy, Codex)"; 140,887 stars and 9,015 forks per `gh api`, authenticity not checked):

- **Re-verified at that SHA:** `LICENSE` is still MIT, "Copyright (c) 2026 Lovecast Inc."; `AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done']` (`src/shared/agent-status/contracts/agent-status-types.ts`, line 31, so the `:29` reference elsewhere in this note is for the older SHA); the full-autonomy flag table in `tui-agent-permissions.ts` still has `claude: '--dangerously-skip-permissions'` and `codex: '--dangerously-bypass-approvals-and-sandbox'`; `acp-structured-acquire.ts` still chooses `'full-access'` or `'ask'` from `launch.fullAccess` (line 153 sets it; line 88 passes `launch.fullAccess` into `acpLaunchPermission`; the `allow_once` auto-answer cited in 4.4 was found in that file at `c1da9cbe` but **not** at `a6fb44ab`, so the logic may have moved and its current location is unverified); the worktree removal pre-flight file still exists.
- **Newly read documents** (no code): the Agents feed (a catch-up list of completions, blocking questions and unread items across worktrees), experimental agent hibernation (off by default; stops a finished agent's PTY only when every listed condition holds, then resumes with the agent's own resume command), native chat (structured ACP chat, terminal by default on new installs), and the attribution and annotate-diff pages. The attribution page describes per-line AI marking, but whether the source implements it is still unknown.
- **Not re-verified on 2026-11-27 (2026-11-17 basis):** evidence-clock fields, hook and OSC 7501 channels, worktree pre-flight contents, ACP client internals, orchestration, the PR-sample statistics in section 4.5, and the SSH and CLI sections.
- The 2026-11-17 pinned commit `c1da9cbe…` below remains the commit the line references in 4.4 to 4.6 were read at, unless a line says otherwise.

A full-repository search for `Copyright`, `SPDX-License-Identifier`, `@license` and "adapted from" did **not** complete, and dependency licenses were not resolved (no install, no lockfile audit). Any future copy PR must do both for the files it touches.

### 4.2 Gap analysis: what Orca has, what AgentDock has

**AgentDock state snapshot, as of 2026-11-17 (not re-derived on 2026-11-27).** On that date `main` contained documentation only, and the "AgentDock" column also names pull requests that were then unmerged. Since then #16, #22 and #24 have merged, so `main` now has the React preview UI, the i18n work and a frontend CI workflow (`.github/workflows/frontend.yml`); #25, #27, #28 and #29 were still open on 2026-11-27. Read the column below as the 2026-11-17 picture; it does not claim any listed pull request is done.

| Capability | Orca (at the pinned commit) | AgentDock | Gap or note |
| --- | --- | --- | --- |
| Agent runtime link | Mostly agent CLIs in a PTY, observed through hooks, terminal titles and OSC 7501; plus its own ACP client for "native chat" (`src/main/acp/`, protocol version 1) | ACP only, through the official Rust crate (ADR-0002); live ACP runtime preview in PR #25 | Different centre of gravity. Orca's PTY observation stack is mostly not needed; its ACP compatibility notes are |
| Agent status | Four states `working`, `blocked`, `waiting`, `done`; folded for the UI into needs-you, working, done, rest | Task and Session state machines in ADR-0003 (PR #22); Session Sentinel inbox in PR #27 | Do not rebuild a second status model. Borrow the evidence-clock ideas (4.4, B1) |
| Notifications | System notification, sound and unread chip when an agent goes from working to idle; unread bell; mark unread; per-machine mute; phone push | Deterministic attention items with dismiss (PR #27); OS notifications not built | Borrow details, not code |
| Worktrees | One worktree per task; background creation with progress and cancel; guarded removal | WT-1 to WT-11 scenarios in ADR-0002; explicit worktree creation in PR #28 | Orca has good removal safety checks to mirror, and two behaviors AgentDock rejects (4.6) |
| Review | Line comments on a diff, sent to an agent as one batch; PR comments and failed checks handed to an agent | Review drawer and comment-to-agent are in the PRD; not built | Adopt the batch pattern (B6) |
| PR, CI, merge | Create PR, see checks, merge, auto-merge, merge queue, stacked merge from the app | Human-driven evidence gates in PR #29; no merge by design | AgentDock deliberately stops before merge |
| Multi-agent | Experimental orchestration: runs, tasks, dispatches, mailbox, decision gates | Child sessions and review loop in ADR-0003 fixtures; not built | Adopt the completion contract ideas (B7) |
| Repo setup | `orca.yaml` setup and archive scripts, shared directories, `.worktreeinclude` | Not specified | Candidate (B5) |
| Remote | SSH with its own uploaded daemon, remote servers, cloud VMs | Rust worker over SSH planned (#12) | Reference only |
| i18n | `i18next`, 11 locales, pseudo-localization | Typed dictionaries, `zh-TW`/`en-US` in PR #24 | Borrow the QA technique (B16) |
| Mobile, design mode, computer use, plugins | Present | Out of scope for MVP (PRD section 8) | Excluded for now |

Capabilities AgentDock should **not** rebuild from Orca because its own design already covers them: the ACP client (official SDK), the task state machine and evidence gates (ADR-0003, PR #29), the deterministic inbox (PR #27), and approval policy in the backend (#8).

### 4.3 Module matrix for the paths named in issue #30

Sizes were measured with `git ls-files -- <path>` piped to `wc -l` on the pinned checkout ("tests" counts `*.test.ts(x)` and `*.spec.ts(x)` only). "Depth" says how much was actually read: **full** (entry points, design and tests read by a reviewer agent), **partial** (some files read), **names** (directory and file names only). Nothing was built or run.

| Path | Files / non-test TS lines / test files | Depth | Depends on | Windows and WSL | Decision for AgentDock | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| `src/shared/agent-status/` | 179 / 16,839 / 16 | Partial | `src/shared/program-status`, `agent-session`, `orchestration`; no Electron in the files read | A process-presence test per platform exists (not read) | **Reimplement in Rust; design reference only** (state set, clocks, history) | Medium |
| `src/shared/agent-hook-listener/`, `src/main/agent-hooks/` | 174 + 210 / 18,184 + 19,480 / 21 + 50 | Partial | About 20 per-agent providers; a loopback hook server; installers that edit agent config files | Dedicated `wsl-relay/` (18 files) and Windows hook commands | **Excluded** as a mechanism (see 4.6); event-name tables are reference material if non-ACP terminal agents are ever observed | Medium |
| `src/shared/git/worktrees/`, `src/main/git/worktrees/` | 5 + 86 / 364 + 6,981 / 1 + 38 | Partial | Spawns `git` with argument arrays (`gitExecFileAsync`); no `simple-git` | `windows-worktree-removal.ts`, `wsl-worktree-git-path.ts`, long-path arguments | **Reimplement in Rust; design and test scenarios as reference** | Medium |
| `src/main/acp/` | 205 / 17,689 / 25 (49 of the files are recorded fixtures) | Partial | Own JSON-RPC peer; zod schemas generated from the ACP schema; **no official ACP SDK** | Launch and process code not read | **Protocol integration only; no code reuse.** Compatibility notes and test ideas | Medium-high |
| `src/shared/i18n/` | 10 / 458 / 0 | Partial | `i18next`, `react-i18next` | n/a | **Design reference only** | Low-medium |
| `src/main/ssh/` | 280 / 26,463 / 87 | Full (by a reviewer agent; two line references spot-checked) | `ssh2`, falls back to the system `ssh` for ProxyJump, FIDO2, GSSAPI; uploads its own Node daemon | Windows-host tests exist | **Reimplement in Rust; scenarios as reference; one behavior rejected** (4.6) | Medium-high |
| `src/renderer/src/` | 10,666 / about 1.2 million / 681 | Names only | React, zustand, monaco, xterm | n/a | **UI interaction reference only**, taken from the public documentation rather than the source | Low (not audited) |
| `src/cli/` | 454 / 47,000 / 72 | Full (by a reviewer agent; not spot-checked) | Private newline-delimited JSON over a Unix socket or Windows named pipe | Named pipe transport | **Contract design reference; reimplement** | Medium |

### 4.4 What was read in each module

**Agent status** (`src/shared/agent-status/`)

- States: `AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done']` (`contracts/agent-status-types.ts:29`).
- The UI folds them into four phases, `needs-you`, `done`, `working`, `rest`, and derives transitions `prompt-submitted`, `turn-finished`, `errored`, `needs-input` (`lifecycle/agent-transitions.ts:14`, `:17`).
- An entry keeps separate clocks: `updatedAt` moves on every tool or prompt ping, `stateStartedAt` only when the state changes, and `evidenceObservedAt` records when the underlying evidence was seen, so a replay after reconnect does not look like fresh activity. A bounded `stateHistory` is kept. A `done` can be marked `interrupted` or `sessionBoundary`.
- Status is attached to a terminal pane, not to a task.
- `approval/hook-silent-approval-agents.ts` lists agents whose hooks keep reporting "working" while an approval menu is waiting. Orca uses the list to avoid sending text that a pasted Enter could turn into an approval. This is a guard against accidental approval, not an auto-approve list.

**Hooks** (`src/main/agent-hooks/`, `src/shared/agent-hook-listener/`)

- The module README describes two status channels: Orca-managed hooks, plugins and extensions that POST to a loopback server, and **OSC 7501**, a terminal escape sequence ("Program Status Protocol") that the agent writes itself. Hooks win; OSC 7501 fills in when hooks are off, not installed, or silent for two minutes. The README's support table (dated 2026-10-17) lists Claude Code, Grok, pi, oh-my-pi and Codex as sending OSC 7501.
- Managed hooks are written into the agent's own configuration. For Claude Code the target is `settings.json` under `~/.claude` (`src/main/claude/hooks/hook-settings.ts:45`, `:60`); other agents use their own `hooks.json` or TOML files. The public docs say turning the setting off removes them.
- Not read: the normalization rules, backup and restore of the edited files, the WSL relay.

**Worktrees** (`src/main/git/worktrees/`)

- Creation runs `git worktree add --no-track -b <branch> <path>` through an argument array, optionally `--no-checkout` (`creation/worktree-add.ts:236`, `:244`, `:250`). It then records the creation base in local git config, sets `push.autoSetupRemote` only if unset at every scope, and tracks a same-name remote branch explicitly (`:97`, `:124`, `:154`). Creation is split into prepare, add, and finalize or discard steps under a lock (`worktree-preparation-*.ts`).
- Removal first checks `git status --untracked-files=all` and refuses on uncommitted or untracked changes and on dirty submodules; a `force` flag skips the check (`removal/worktree-removal-preflight.ts:17`, `:23`, `:54`, `:82`).
- A separate scan lists "at-risk local files" (ignored files that would be destroyed), and treats a timeout, byte cap or git failure as **unknown, never safe** (`removal/worktree-at-risk-local-files.ts:187`).
- Windows removal bypasses git and therefore re-checks first; an empty observation never authorizes recursive deletion (`removal/windows-worktree-removal.ts:160`).
- Reported by a reviewer agent and not re-checked here: branch deletion uses `git branch -d` and keeps the branch when git refuses (`removal/worktree-branch-removal.ts:55-71`).
- 38 test files exist; their scenarios were not catalogued.

**ACP client** (`src/main/acp/`)

- Orca wrote its own client. Types and validators are generated from the official schema (`generated/acp-protocol.generated.ts`, `ACP_PROTOCOL_VERSION = 1` at `:200`).
- `initialize` advertises `fs.readTextFile`, `fs.writeTextFile` and `terminal` as `false` by default, and closes the connection with `-32602` when the agent answers with another protocol version (`protocol/acp-session-runtime.ts:89-108`).
- A per-agent dialect layer exists for Grok, Cursor, Copilot, Kimi, OpenCode, Antigravity and oh-my-pi (`acp-dialects/`), with recorded messages per agent version under `fixtures/` (for example `grok-v1.0.70-initialize.jsonl`).
- Line limit: 31 MiB, chosen to stay under a 32 MiB stdin line limit that would kill the agent (`transport/acp-peer-limits.ts:3-4`).
- **With "full access" on, Orca answers `session/request_permission` by selecting the `allow_once` option itself**, unless the agent has its own permission mode or the dialect claims the request (`session/acp-structured-acquire.ts:115-121`).

**SSH** (`src/main/ssh/`): by default an **unknown host key is accepted and recorded without asking** (`host-keys/ssh-host-key-decision.ts:6`, `:195`, spot-checked). The reviewer agent listed 40 test scenarios (reconnect, multiplexing, hostile hosts) that are useful as ideas for #12.

**CLI** (`src/cli/`): a table-driven command specification generates validation, help and a machine-readable schema; commands report `error.code` plus `nextSteps`; there is capability pre-flight and idempotent replay. The reviewer agent inferred that `terminal send` has no ownership check on the CLI side, so one agent may be able to type into another agent's terminal. That inference was not verified.

**i18n**: `i18next` with 11 locales including `zh-Hant`; a pseudo-locale `en-XA` that wraps strings in brackets, accents letters and adds about 40% length so untranslated or clipped strings are obvious (`src/shared/i18n/pseudo-localization.ts`).

### 4.5 Orca's development workflow

This section separates **how the Orca team builds Orca** from **what the product offers its users**. The owner asked about the former; both matter for AgentDock.

#### How the team works (from the repository and from GitHub)

Written rules are short:

- `AGENTS.md` (66 lines): run `pnpm check:changed` after the last edit or rebase and before every push; never `--no-verify`; do not poll CI, use `gh run watch` or `gh pr checks --watch`; `main` is always releasable; **"Do not add tests by default"**, add one only if it fails when the change is reverted and hard-codes its expected values; every change must consider cross-platform support, remote hosts, mobile and folder workspaces.
- `.github/CONTRIBUTING.md`: descriptive branch names (`fix/…`, `feat/…`); small PRs on one topic; run lint, typecheck, test and build before opening a PR.
- `.github/pull_request_template.md`: ELI5, what changed, why, linked issue, visual proof (before and after), testing, **risk with a level and how to back it out**, AI disclosure for outside contributors. One testing checkbox reads "Every added test fails without this change".
- Nothing in the repository prescribes how tasks are split, one worktree per task, who may merge, or an independent review. The template's "Review" section is, per `CONTRIBUTING.md:67`, a short summary written by the author's own coding agent.
- `.github/CODEOWNERS` covers only locale files and `cloud/`.

CI:

- 77 workflow files. `pr.yml` runs about 20 jobs and ends in a single aggregate job named **"PR checks passed"** (`pr.yml:1532-1533`). A script fails the build if any other job takes that name or if it is allowed to fail (`.github/scripts/check-required-pr-context.mjs`).
- Expensive jobs are selected by changed paths; an empty diff runs everything (fail closed).
- **End-to-end tests are advisory**: a comment says they stay out of the gate "while main's scheduled suite is red" (`pr.yml:1555`).
- Windows is covered by `package_windows` and `windows_wsl` jobs plus separate WSL and Windows-host workflows.
- `pullfrog.yml` is a manually triggered AI review bot with a pause switch; whether it is in use was not checked.
- Branch protection rules and merge-queue settings could not be read.

Observed practice (GitHub REST, sampled on 2026-11-17; **a small sample from a single day**):

- Volume: pull request numbers had reached #43,596 eight months after the repository was created. In one listing, 45 pull requests were merged between 08:40 and 13:06 UTC.
- A reviewer agent's sample of 40 merged PRs from about four hours: median 14 minutes from open to merge, longest 1.8 hours; `reviewDecision` empty on all 40; 20 of them by one account (`OrcaWin`), all titled "test: remove low-value … tests".
- Five PRs were inspected individually (#43558, #43309, #43575, #43596, #43560; its detail request timed out the first time and was repeated afterwards). On the four first inspected: **the author merged their own PR in all four**; a fifth, #43560, opened by an outside contributor, was merged by a maintainer about 64 minutes later, so self-merge describes maintainers' own PRs, not every PR; auto-merge was not used; the only reviewer other than the author was the `coderabbitai[bot]` app, which commented on three of them and submitted no approval. PR #43575 changed 563 files and merged 67 minutes after opening with no review comments.
- Commit subjects end in `(#NNNN)` with committer "GitHub", which is consistent with squash merging. The parent count of the merge commits was not confirmed.
- Releases: about one desktop release a day (10 stable versions in 11 days), cut by a manually triggered workflow.

Reading: the Orca team optimizes for throughput. Many small PRs, an automated gate, a bot reviewer, maintainers merging their own PRs (outside contributors' PRs are merged by a maintainer), and daily releases. It is **not** an independent-review workflow, and it deliberately keeps the test suite small.

#### What the product offers (public docs at `orca.dev/docs`, same content under `docs/site/content/docs/` in the repository)

- **Model.** "Every task gets its own git worktree, its own agent terminal, and its own browser tab." Lifecycle: create (name, start-from ref, optional GitHub, Linear, Jira or GitLab link), work, review, ship, archive or delete.
- **Parallel agents.** The documented "killer move" is racing three agents on the same task in three worktrees and keeping the best diff.
- **Launch defaults.** Orca "launches every supported agent with its full-autonomy permission flag pre-applied", for example Claude with `--dangerously-skip-permissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`, on the argument that "the worktree itself is the sandbox". The flag table is in `src/shared/agent-launch/permissions/tui-agent-permissions.ts:12`.
- **Status and notifications.** Spinner (working), amber question mark (waiting on you), green (done), red (blocked, interrupted or failed), gray (idle). An experimental dashboard groups agents into Needs You, Working, Done and Idle (quiet for about 30 minutes, hidden by default). A notification fires when an agent goes from working to idle; a bell shows unread items; an item can be marked unread again.
- **Review.** "Annotate AI Diff": comment on diff lines, then **send all comments as one batch** to a chosen agent; unresolved comments ride along in the next batch. The docs give the reason: one comment at a time makes the agent swing back and forth.
- **Ship.** Commit, push and create the PR from the app. Plain Push never falls back to force; "Force push with lease" is a separate, labeled action. The PR view offers merge, **auto-merge**, merge queue and stacked merge; the default merge method in code is squash (`src/main/github/client/merge/merge-pr.ts:19`). Failed checks and PR comments can be handed to an agent.
- **Repository setup.** `orca.yaml` holds setup and archive scripts; gitignored files reach a new worktree through shared directories (linked) or `.worktreeinclude` (copied). Reported by a reviewer agent: trust in a script is stored as a hash of its content, so an edited script asks again.
- **Orchestration (experimental).** A Run with Tasks, Dispatches, a mailbox and decision gates, driven from the Orca CLI by a coordinator agent:
  - A worker reports `worker_done` exactly once, with both the task ID and the dispatch ID, so a stale retry cannot complete the task.
  - The coordinator ends its turn after dispatching and is woken by Orca; polling is explicitly discouraged.
  - Silence, a timeout or an unverifiable liveness check is never evidence that a worker finished.
  - Three failed starts on the same retry chain trip a circuit breaker.
  - A worker stuck on a permission prompt escalates; by default only a person can allow, and the coordinator can only deny. An opt-in setting lets coordinators approve.
  - Workers may start helpers up to a nesting depth (default 4).
- **Checkpoints.** An agent can set a free-text comment and a card status (`todo`, `in-progress`, `in-review`, `completed`) on its worktree from the CLI, to keep people informed without chat.
- **Usage.** A status-bar display of plan usage and reset times per provider; "a provider that returns no balance reads as unavailable rather than zero". Some sources are local agent state; one requires pasting a full session cookie.
- A line often quoted from the Orca site, "Reviewers read only; writers get worktrees … One owner integrates and tests", is a **user testimonial** on the home page, not a rule in Orca's docs or code.

### 4.6 Orca behaviors AgentDock should not adopt

| Orca behavior | Evidence | AgentDock rule it breaks |
| --- | --- | --- |
| Agents start with their full-autonomy flag by default, and in ACP sessions "full access" answers permission requests with `allow_once` automatically | Docs "Launch defaults"; `tui-agent-permissions.ts:12`; `acp-structured-acquire.ts:115-121` | No implicit approval; approvals are enforced by backend policy (architecture, #8). AgentDock must also say plainly that it enforces nothing when the user picks an agent's own bypass mode (APR-11) |
| Merge, auto-merge and stacked merge from the app; squash by default | Docs "Hosted reviews"; `merge-pr.ts:19` | No automatic merge; human-approved merge boundary; owner rule: merge commits only |
| No independent review in the team's process; authors merge their own PRs within minutes | PR sample above | Independent fresh review before merge (PRL-1, PRL-2) |
| Status hooks are written into the user's agent configuration (`~/.claude/settings.json` and equivalents) | `hook-settings.ts:45`, `:60`; docs "Agent status hooks" | "No hidden model or tool interception". ACP already delivers session events. If terminal agents are ever observed, the change must be explicit, visible and reversible |
| "Force Delete" with an "Always force delete" memory; deleting a worktree also removes its branch | Docs "Worktrees"; `worktree-removal-preflight.ts:23` | WT-5: never `--force`, never delete the branch implicitly |
| Unknown SSH host keys are accepted silently by default | `ssh-host-key-decision.ts:6`, `:195` | Architecture: SSH host key verification |
| "Do not add tests by default"; end-to-end tests do not gate merges while `main` is red | `AGENTS.md:20`; `pr.yml:1555` | Explicit acceptance tests; release gates must list skipped end-to-end tests (X-4) |
| Usage figures read from local agent state or a pasted session cookie | Docs "Usage & rate-limit tracking" | No reading of credentials; no quota claim without a provider source |

### 4.7 What AgentDock could adopt from Part B

Same approach vocabulary as section 3.7. All Orca material is MIT at `c1da9cbe…` except the generated ACP schema file (Apache-2.0). **Every item below is a pattern or a protocol integration; none copies Orca code.** The only place where copying might later be worth a migration PR is marked.

| ID | Item | AgentDock target | Approach | Main risks |
| --- | --- | --- | --- | --- |
| B1 | **Status evidence clocks**: keep "last activity", "state entered at" and "evidence observed at" as separate fields; mark a `done` as interrupted or as a session boundary; keep a bounded state history; fold states into needs-you, working, done, rest for the sidebar | #15, #3 (ADR-0003 in PR #22) | Pattern | Must map onto ADR-0003 states rather than add a parallel model |
| B2 | **OSC 7501 Program Status Protocol** as a status source for terminal sessions that are not ACP sessions | #15, #6 | Protocol | The specification itself was not read (only Orca's README about it); only relevant if AgentDock embeds terminals |
| B3 | **Notification details**: notify on working-to-idle; unread bell that jumps to the session; mark unread; a successful structured turn marks unread without a sound; per-machine mute | #15 | Pattern | Overlap with PR #27; reconcile there |
| B4 | **Worktree safety**: background creation with progress, cancel and retry; staged create with discard on failure; record the creation base; removal pre-flight including submodules; list ignored files that removal would destroy and treat an incomplete scan as unsafe; keep the branch when git refuses to delete it; Windows removal re-checks before any recursive delete | #9 (PR #28) | Pattern, plus test scenarios | Orca's "force" paths must not come along |
| B5 | **Repository setup script with trust by content hash** (`setup` after create; policy: run, ask, skip), and two explicit ways to bring gitignored files into a worktree (link versus copy) | #9, #8 | Pattern | A repo-supplied script is code execution: it goes through the approval policy, re-asks when the content changes, and the file is agent-editable (APR-9) |
| B6 | **Batched diff annotations**: line-anchored comments, sent as one prompt to a chosen session; unresolved comments carry into the next batch; resolve and re-review | #9, PRD review drawer | Pattern | The batch is a prompt containing user text and code; render and log it as such |
| B7 | **Child-session completion contract**: exactly-once completion carrying task and dispatch IDs; parent ends its turn and is woken by an event; silence or timeout is never completion; bounded retries with a breaker; nesting depth limit; a child's permission prompt escalates to a person, and a parent agent can only deny | #10, #13, #15, ADR-0003 | Pattern | Orca's version is experimental and only its documentation was read |
| B8 | **Untrusted-data wrapping**: issue text and PR comments are wrapped and size-capped before they reach an agent; the fix prompt forbids push, commit and resolving threads | #10, #8 | Pattern | Wrapping is not a security boundary; the backend policy is |
| B9 | **CI shape for AgentDock's own repository**: one aggregate required check, protected against being renamed or made optional; path-based job selection that fails closed; agents run the change-scoped check before every push, never skip hooks, and watch CI instead of polling | #4, #14 | Pattern | As of 2026-11-17 AgentDock had no CI; a frontend CI workflow (`check`) has since landed on `main`, so this item now means extending it (aggregate required check, fail-closed path selection), not creating CI. The GitHub token used then lacked the `workflow` scope (noted in PR #24 and #27) |
| B10 | **PR template fields**: plain-language summary, risk level and how to back out, before/after proof, "every added test fails without this change" | Repository process, #10 evidence | Pattern | None |
| B11 | **ACP compatibility practice**: advertise no `fs` or `terminal` capability by default; refuse a protocol-version mismatch; keep a per-agent dialect list; record real agent messages per agent version as regression fixtures; cap line length below the agent's own limit; never auto-answer a permission request the agent's mode owns | #6 | Pattern. **Copy PR only if Orca's recorded fixtures are wanted**; recording AgentDock's own is preferred | Orca's fixtures are MIT, but they are recordings of third-party agents' output |
| B12 | **Agent-written checkpoint**: a short free-text status plus a small status enum that the agent can set | #15, #10 | Pattern | Needs a channel the agent can call (MCP tool or ACP extension); agent-written text is untrusted |
| B13 | **"Unavailable is not zero"** for usage: a provider with no data shows as unavailable | #13 | Pattern | Do not copy Orca's data sources |
| B14 | **Explicit force-push-with-lease as a separate labeled action** showing how many commits it replaces; plain push never escalates | #9, #8 | Pattern | Still an "ask" operation under APR-10 |
| B15 | **SSH test scenarios** (reconnect, multiplexing, hostile host behavior) | #12 | Pattern | Host-key default must be the opposite of Orca's |
| B16 | **Pseudo-localization** for UI QA and a key-parity check between locale files | #18 | Pattern | None |
| B17 | **Machine-readable CLI contract**: one table generates validation, help and schema; errors carry a code and next steps | #10, #15 (later) | Pattern | Only if AgentDock ships a CLI |

### 4.8 Vertical slice (issue #30, not done here)

Issue #30 asks for one high-value, low-coupling module to be built as a reversible vertical slice with real tests. **This note does not do that.** Recommended slice, for a separate issue and PR:

- **Attention fold as a pure function with table tests**: input is a session's event history in ADR-0003 terms; output is one of needs-you, working, done, rest plus the three clocks from B1. It needs no Orca code, has no I/O, can be reverted by deleting one module, and gives #15 a tested core. Test cases come from the situations Orca's types encode (interrupted done, session-boundary done, replay after reconnect must not look fresh, a silent source must not flip the state).
- Alternative: worktree removal pre-flight on real temporary repositories (dirty tree, untracked files, ignored files, submodule, Windows path), which extends the WT-5 and WT-6 scenarios.

## 5. Combined adoption list

Priority is a recommendation for the owner, not a decision. "Issue" is the tracking issue opened for the item (section 8).

| Priority | Items | Why |
| --- | --- | --- |
| 1. Safety and process, cheap to adopt now | B9, B10 (CI and PR template), B4 (worktree safety), B8 (untrusted wrapping), A4, A7 (approval vocabulary and card behavior) | They harden work that is already in open PRs (#28, #29) and need no new runtime |
| 2. Core product patterns | B1, B3 (status and notifications), B6 (batched diff annotations), B7, A6, A5 (child-session contract) | They shape #15, #9 and #10 before those are built in Rust |
| 3. Protocol work | B11, A8 (ACP compatibility and Grok Build), B2 (OSC 7501) | Depends on #6 landing |
| 4. Optional, needs an owner decision first | A1, A2, A3 (decision provider, Sentinel triage, shadow mode) | New external dependency and a privacy decision; value is unproven; the one independent evaluation read (Anaconda, 2026-10-20) found calibration must be validated per use |
| 5. Later | B5, B12, B13, B14, B15, B16, B17, A9 | Useful details; no urgency |

## 6. Source table

Kept in this note because pull requests that also edit `docs/sources.md` were open on 2026-11-17 (#16, since merged, and #19, still open on 2026-11-27). These rows should be merged into `sources.md` once #19 lands. All SHAs are full and were read from the GitHub REST API on 2026-11-17 (Orca, OpenMausBot and the Laya and community repositories; OpenMausBot also on 2026-11-18) or on 2026-11-27 (rows that say so).

| Source | Pinned SHA or date read | License (SPDX) | What was read | Role |
| --- | --- | --- | --- | --- |
| [stablyai/orca](https://github.com/stablyai/orca) | `c1da9cbe717d614575553f559a1a8feefff4d774` (2026-11-17); re-read 2026-11-27 at `a6fb44ab972622b52ec1d7d696ebb4b9ff56f6ab` | MIT, "Copyright (c) 2026 Lovecast Inc."; one generated file Apache-2.0 (2026-11-17, not re-checked) | Files listed in section 4, read-only checkout, no build; on 2026-11-27 via `gh api`: `LICENSE`, status contract, permission flag table, ACP acquire file, five documentation pages | Design and test-scenario reference; no code reuse |
| [orca.dev/docs](https://orca.dev/docs) | Read 2026-11-17 | Site content, all rights reserved | Worktrees, agents and sessions, orchestration, parallel agents, annotate diff, commit and push, hosted reviews, notifications, hooks and memory, usage tracking, worktree checkpoints | Interaction reference |
| [NandhaKishorM/laya](https://github.com/NandhaKishorM/laya) | `b1d656952f0f9581ea691a70cb6f38abf3eb13a9` | Apache-2.0 | `README.md`, root listing, `LICENSE` header | Optional external decision server (protocol) |
| TypeSafe Jev: [docs.typesafe.ai](https://docs.typesafe.ai/introduction), [typesafe.ai](https://typesafe.ai/) | Read 2026-11-17 | Proprietary hosted API; terms for the API not reviewed | Introduction, API, confidence, confidence routing, models, errors, limitations, launch post, privacy policy, site terms | Optional hosted decision service (protocol) |
| [typesafe-ai/skills](https://github.com/typesafe-ai/skills), [typesafe-ai/system-one-adapter-python](https://github.com/typesafe-ai/system-one-adapter-python) | `302eea662c54bca6730873fe245bec1d69ebc23d`, `e1d4cc938204b22fc5a3c3aca7044072fe3f712d` | MIT | Metadata only | Not used |
| xAI Grok Bot: [docs.x.ai/grok-bot](https://docs.x.ai/grok-bot/overview) | Read 2026-11-17; overview, chat-and-collaboration, approvals and FAQ re-read 2026-11-27 | Proprietary, closed source | Overview, skills and routines, approvals, how it works, computer and apps, FAQ, teams | Interaction reference only |
| [xai-org/grok-build](https://github.com/xai-org/grok-build) (SpaceXAI) | `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` (2026-09-29; `SOURCE_REV` `559751fdcec02d413e4c57c8832ab275e4f44980`), read 2026-11-27 | Apache-2.0 (GitHub SPDX and root `LICENSE`); `THIRD-PARTY-NOTICES` includes MPL-2.0 packages, `libgit2` under GPL-2.0 with linking exception, and ports from openai/codex (Apache-2.0) and sst/opencode (MIT) | `README.md`, `LICENSE`, `CONTRIBUTING.md`, `THIRD-PARTY-NOTICES`, user-guide pages on agent mode, permissions, sandbox, plan mode, subagents, background tasks and dashboard, `Cargo.lock`, file tree (names only); no clone, no build, nothing run | ACP adapter candidate (external runtime, never bundled); no code reuse |
| xAI Grok Build announcements: [x.ai/news/grok-build-cli](https://x.ai/news/grok-build-cli) (2026-05-25), [x.ai/news/grok-build-open-source](https://x.ai/news/grok-build-open-source) (2026-07-15) | Read 2026-11-17 and 2026-11-27 respectively | Site content, all rights reserved | Announcements | Background for the repository row above |
| [colinmcdermott/grok-jev-router](https://github.com/colinmcdermott/grok-jev-router) | `b52cc4c3c4ad9ac4ef1269deeab5b143c4e4c2df` | MIT | README | Pattern evidence |
| [fal3/grokbot-jev-skills](https://github.com/fal3/grokbot-jev-skills) | `0cea9708e63cdc7c2a41731e1e0e0244c7889017` | MIT | README | Pattern evidence |
| [RazeDen/grok-jev-reflex](https://github.com/RazeDen/grok-jev-reflex) | `a4994bd8bd61101a43628de523d317bcfef8fae0` | MIT | README | Pattern evidence |
| [Bodila51/grok-bot-jev](https://github.com/Bodila51/grok-bot-jev) | `d01527914012ccd75d3d16e0dcfc26e6e1fc56ff` | MIT | README | Pattern evidence |
| [kerpopule/hermes-jev-skills](https://github.com/kerpopule/hermes-jev-skills) | `6e606eb66389b6556d694bb1069bc5a9c8288f7b` | MIT | Metadata only | Upstream of one of the above |
| [jaredpalmer/kev](https://github.com/jaredpalmer/kev), [ollaya-dev/ollaya](https://github.com/ollaya-dev/ollaya) | `2074cc44256200bb37540103fa4572901faa10f3`, `d3cf29fa9f68dc370860f914052e96a659afa785` | Apache-2.0 | Metadata only | Alternative open decision servers |
| [aayushch/laya](https://github.com/aayushch/laya) | `550ce574baa3df9c1964c7b6a6ea4a60d190aae3` | Apache-2.0 | Metadata only | Ruled-out name candidate |
| Anaconda, ["Decision Models: Jev vs. a Fine-Tuned Classifier"](https://www.anaconda.com/blog/decision-time) | Published 2026-10-20 | Article | Full text | Independent evaluation |
| [madewithjev.com](https://madewithjev.com/resources/jev-laya-agents-stack) (independent directory), [Trilogy AI on open decision models](https://trilogyai.substack.com/p/jev-open-decision-models), [Layer3Labs guide](https://www.layer3labs.io/guides/system-one-decision-models) | 2026-09-26 to 2026-10-15 | Articles | Full text of the pages named in section 3.5 | Community pattern and criticism |
| [milind-soni/OpenMausBot](https://github.com/milind-soni/OpenMausBot) (identification pending owner confirmation, issue #34) | `21acf05ca7d28a937e4b27558e2e7c7885018b43` (2026-11-18); documents re-read 2026-11-27 at `54ab8e3afafe4460a9c6d5241e498d849de3d318` | Apache-2.0; `enterprise/` under a separate source-available license (not reused); `third_party/` keeps its own licenses (mostly MIT) | `README.md`, `LICENSING.md`, `NOTICE`, `SECURITY.md`, `docs/{decision-model,approval-levels,runtime-contract,sentinel,usage-caps,pausing-bots,tool-selection}.md`, file tree (2026-11-18); `LICENSING.md` and the approval-levels, decision-model, usage-caps and runtime-contract documents (2026-11-27) | Design reference only; no code reuse |
| [milind-soni/openmausbot-teams](https://github.com/milind-soni/openmausbot-teams) | `f5b2548b44c8d99882583bd5379d9a365ffe11d8` | MIT | Metadata only | Not used |

No source in this table is AGPL. `grok-build` bundles a vendored `libgit2` under GPL-2.0 with linking exception (and MPL-2.0 packages); AgentDock neither copies nor bundles it.

## 7. Issue #30 checklist

| Item in issue #30 | Status in this note |
| --- | --- |
| Gap analysis and list of capabilities not to rebuild | Done (section 4.2) |
| Dependency tree, entry API, portability, Windows and WSL, security and test list per path | **Partly done.** Complete for `src/main/ssh/` and `src/cli/` (by reviewer agents); partial for agent status, hooks, worktrees, ACP and i18n; `src/renderer/src/` was not audited beyond its size |
| Per-module decision table | Done, with confidence levels (section 4.3). No module is "reuse directly" |
| One vertical slice with real tests | **Not done**; recommended slice in section 4.8 |
| Update `docs/sources.md`, ADRs, API and test notes | **Deferred.** The source table is in section 6 to avoid conflicts with PR #16 (since merged) and #19 (still open). No ADR was changed |
| Do not make the Orca Electron app a dependency | Respected |

Because the vertical slice and parts of the matrix are missing, this note **refers to** issue #30 and does not close it.

## 8. Proposed new issues

Opened on 2026-11-18 at the owner's request (titles are in Traditional Chinese, matching the issue tracker). Each issue states what to adopt, sources with pinned SHAs, the related AgentDock issue, approach, license and risk, and acceptance criteria.

| Issue | Items | Subject |
| --- | --- | --- |
| [#34](https://github.com/ChiJiun/agentdock/issues/34) | 3.1, 3.8 | **Owner must confirm** which tool and post the owner meant (Grok Bot, Jev, Laya, OpenMausBot) |
| [#35](https://github.com/ChiJiun/agentdock/issues/35) | A1, A2, A3, A9 | Optional decision provider (Jev or self-hosted Laya), protocol integration |
| [#36](https://github.com/ChiJiun/agentdock/issues/36) | B1, B3, C5 | Status evidence clocks and attention fold |
| [#37](https://github.com/ChiJiun/agentdock/issues/37) | B4, B5 | Worktree create and remove safety checks |
| [#38](https://github.com/ChiJiun/agentdock/issues/38) | B6 | Batched diff annotations sent to a session |
| [#39](https://github.com/ChiJiun/agentdock/issues/39) | A5, A6, B7, C2 | Child-session completion contract and bounded assignment packet |
| [#40](https://github.com/ChiJiun/agentdock/issues/40) | A4, A7, B8, B14, C1 | Approval vocabulary, provenance labels, untrusted wrapping |
| [#41](https://github.com/ChiJiun/agentdock/issues/41) | B9, B10 | Aggregate required check, PR template, pre-push checks |
| [#42](https://github.com/ChiJiun/agentdock/issues/42) | A8, B2, B11 | ACP compatibility practice and Grok Build adapter candidate |
| [#43](https://github.com/ChiJiun/agentdock/issues/43) | A3, B13, C3 | Unattended-first usage caps and pause switch |
| [#44](https://github.com/ChiJiun/agentdock/issues/44) | B12, B15, B16, B17 | Low-priority notes |

Item C4 (decision-call log schema) is folded into #35.

## 9. Not verified

- **Which post the owner saw** about Grok Bot and Jev/Laya. The X posts could not be opened (HTTP 402).
- Nothing was built, installed or run: not Orca, not Laya, not any router. Jev was never called. All behavior statements come from reading source or documentation.
- Jev: API terms and data processing agreement, SDK licenses, rate limits, and every speed, cost and accuracy figure (vendor or author claims; the Anaconda article is the only independent test that was read).
- Laya: `laya-rust` (publication, dependencies, Windows), model weights' license on the model hub, real latency on Windows without a GPU.
- Grok Build (open source since 2026-07-15, section 3.4): the ACP protocol version and `initialize` capabilities actually returned by a released binary, ACP stdio behavior on Windows (PTY, paths, Ctrl+C), whether Windows builds have any sandbox, the published binary version versus the 2026-09-29 source, the `THIRD-PARTY-NOTICES` entries beyond the headline licenses, and the open-sourcing incident link (second-hand only). Only documentation, `Cargo.lock` and file names were read; nothing was built or run.
- Grok Bot: price, regional availability, push-notification behavior, the Grok Bot to Grok Build relationship, and the enterprise "Inference Hooks" (not re-verified on 2026-11-27). Its official launch post was not read.
- Orca:
  - `src/renderer/src/` source; the hook normalization rules, backup and removal of edited agent config files, and the WSL relay; the worktree test scenarios; ACP launch and process handling on Windows; orchestration source (documentation only).
  - Line references reported by reviewer agents and not re-checked: branch removal, PR comment and checks prompts, `orca.yaml` trust hashing, CLI transport, most of the SSH section.
  - Two documented features for which a reviewer agent found no implementation (per-line AI attribution; confirmation before amending a pushed commit). This is a negative search result and may be wrong.
  - Branch protection, merge queue, the parent count of merge commits, whether `OrcaWin` is a person or an agent, and review practice outside the one-day sample.
  - A repository-wide search for third-party license headers, and the licenses of Orca's dependencies.
- The OSC 7501 specification was not read; only Orca's description of it.
- OpenMausBot (section 3.8): only the README, `LICENSING.md`, `NOTICE`, `SECURITY.md` and seven documents were read; **its source code was not audited**, nor the `enterprise/` license text, the `third_party/` licenses beyond their names, the mausbot.com blog, or `openmausbot-teams` (`f5b2548b44c8d99882583bd5379d9a365ffe11d8`, MIT, metadata only). The star and fork counts were not checked for authenticity. Which of several same-name repositories the owner meant is unconfirmed (issue #34). On 2026-11-27 only `LICENSING.md` and four documents were re-read at `54ab8e3a`; `SECURITY.md`, `sentinel.md`, `pausing-bots.md`, the README and the `NOTICE` were not, so those statements keep their 2026-11-18 basis.
- Section numbers in the issue bodies refer to this note; the note is not on `main` until this pull request merges.
