# P3-6: Adapter configuration, Claude/Codex launch methods, compatibility matrix and opt-in E2E

> **繁中摘要**：使用者層級的 adapter 設定檔放在 app data 目錄、**不從 repo 讀取**（agent 能改 repo）。兩種啟動方式：`executable`（絕對路徑執行檔）與 `node_script`（絕對路徑 node + `node_modules` 內的 `.js`，取代 npm `.cmd` shim）。自動偵測 npm 全域安裝的 `@agentclientprotocol/claude-agent-acp` 與 `codex-acp`（Windows 與 Linux 路徑都支援），只提出候選、使用者確認才寫入。`extra_env` 禁止秘密與會改變執行檔或放寬權限的變數（如 `INITIAL_AGENT_MODE`）。另有相容性矩陣文件與 `#[ignore]` 的真實 agent E2E，由擁有者在已登入的機器執行，缺設定時要失敗而不是靜默跳過。模型等級：一般模型可（E2E 由人執行）。

Issues: #6, #42 | Gate (#51): G2 (Claude Code and Codex complete real tasks through ACP) | Model tier: **standard model** (E2E run by a human)

## 1. Goal and non-goals

Goals:

- A user-level adapter file in the app data directory, **never read from a repo** (ADR-0002 APR-9: agents can edit repo files, so repo config must not choose programs or loosen rules).
- Two launch methods: `executable` (absolute path to a binary, e.g. claude-agent-acp's standalone executable) and `node_script` (absolute `node` + a `.js` script inside a package, replacing npm's `.cmd` shim).
- Discovery of candidates (suggestions only; written after user confirmation): npm global installs of `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`, on Windows and Linux.
- A built-in `mock` adapter (P3-3 binary), only in debug builds and tests.
- `docs/compatibility/acp-agents.md`: compatibility matrix of tested agent versions, OS versions and feature results.
- Opt-in real agent E2E tests (`#[ignore]`), run by the owner locally, results recorded in the matrix.

Non-goals: settings UI (after P8-2; alpha ships a JSON file plus Tauri commands), installing agents (users install them; AgentDock never downloads or bundles agents, ADR-0002 line 87), `session/load` / `resume`, an ACP auth UI (when login is needed, show only "log in to <agent> in a terminal").

## 2. Prerequisites and parallel work

- Prerequisites: P3-4 (E2E needs P3-5b). The Tauri commands need P1-2.
- Parallel: P4-*, P5-*.

## 3. Files

New:

- `crates/agentdock-acp/src/adapters.rs`
- `crates/agentdock-acp/src/adapters/discover.rs`
- `crates/agentdock-acp/tests/adapters_config.rs`
- `crates/agentdock-orchestrator/tests/real_agent_e2e.rs` (all `#[ignore]`)
- `docs/compatibility/acp-agents.md`
- `docs/dev/real-agent-e2e.md` (owner steps for E2E)

Modified: `crates/agentdock-acp/src/lib.rs`, `src-tauri/src/commands.rs` and `src-tauri/capabilities/default.json` (three commands, registered as in P1-2).

## 4. Public types and signatures

```rust
// crates/agentdock-acp/src/adapters.rs
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Launch {
    Executable { program: PathBuf },
    NodeScript { node: PathBuf, script: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AdapterConfig {
    pub id: String,                       // ^[a-z][a-z0-9_-]{0,39}$ ; "mock" is reserved
    pub label: String,                    // <= 80 chars
    pub launch: Launch,
    #[serde(default)] pub args: Vec<String>,            // <= 32 items, each <= 400 chars
    #[serde(default)] pub auth_env_names: Vec<String>,  // names only; values never stored in this file
    #[serde(default)] pub extra_env: Vec<(String, String)>, // non-secret only; validated against a denylist
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AdapterFile { pub version: u32, pub adapters: Vec<AdapterConfig> } // version must be 1; <= 12 adapters

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AdapterError {
    #[error("invalid adapter id")] BadId,
    #[error("duplicate adapter id {0}")] Duplicate(String),
    #[error("too many adapters")] TooMany,
    #[error("unsupported adapter file version")] BadVersion,
    #[error("{field} must be an absolute path to an existing file")] BadPath { field: &'static str },
    #[error("{field} cannot be a .cmd/.bat/.ps1 shim; use node_script or the real executable")] Shim { field: &'static str },
    #[error("script must be a .js, .mjs or .cjs file inside a node_modules package")] BadScript,
    #[error("invalid argument")] BadArg,
    #[error("environment variable {0} is not allowed in extra_env")] ForbiddenEnv(String),
    #[error("could not read adapter file: {0}")] Io(String),
}

impl AdapterConfig {
    pub fn validate(&self) -> Result<(), AdapterError>;
    /// Builds the P3-2 command. cwd must already be checked by agentdock-policy (P4-1).
    pub fn to_command(&self, cwd: PathBuf) -> agentdock_process::AgentCommand;
}
/// Reads <app data>/adapters.json. Missing file → Ok(empty). Never reads from a repository.
pub fn load_adapter_file(path: &Path) -> Result<AdapterFile, AdapterError>;
/// Atomic write (temp + rename) after validate().
pub fn save_adapter_file(path: &Path, file: &AdapterFile) -> Result<(), AdapterError>;

// crates/agentdock-acp/src/adapters/discover.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate { pub suggested: AdapterConfig, pub source: String /* human-readable where it was found */ }
pub struct DiscoverEnv {
    /// npm global node_modules roots. Production fills:
    ///   Windows: %APPDATA%\npm\node_modules
    ///   Unix: $NPM_CONFIG_PREFIX/lib/node_modules (if set), $HOME/.npm-global/lib/node_modules,
    ///         /usr/local/lib/node_modules, /usr/lib/node_modules
    pub npm_global_roots: Vec<PathBuf>,
    pub path_dirs: Vec<PathBuf>,          // split from PATH
}
impl DiscoverEnv { pub fn from_host() -> Self; }
/// Looks for <root>/@agentclientprotocol/{claude-agent-acp,codex-acp}/package.json and for node in absolute
/// PATH entries. Reads files only; runs no programs.
pub fn discover(env: &DiscoverEnv) -> Vec<Candidate>;
```

`extra_env` denylist (names, case-insensitive): `PATH`, `PATHEXT`, `COMSPEC`, `SystemRoot`, `WINDIR`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, any name ending in `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD` (secrets go in `auth_env_names`; values come from the host environment, never this file), `CODEX_PATH`, `CLAUDE_CODE_EXECUTABLE` (they make the agent run another binary; that must be explicit in `launch`), `INITIAL_AGENT_MODE` (see §11).

## 5. Implementation steps

1. Write the §6 tests.
2. `validate`:
   - `program` / `node` / `script` must be `is_absolute()` and `is_file()`; under `cfg(windows)` extensions `cmd`, `bat`, `ps1` (case-insensitive) → `Shim`.
   - `script`: extension `js` / `mjs` / `cjs`, and some ancestor directory is named `node_modules` (no arbitrary scripts).
   - Compare paths after `dunce::canonicalize` (Windows `std::fs::canonicalize` returns `\\?\C:\...`).
3. `to_command`: `Executable` → `program` + `args`; `NodeScript` → `program = node`, `args = [script] + args`. Pass `auth_env_names` and `extra_env` through (P3-2 validates names again).
4. `discover`:
   - `<root>/@agentclientprotocol/claude-agent-acp/package.json` exists → read `bin["claude-agent-acp"]` (checked 2026-11-22: `dist/index.js`, version 0.109.1) → script path.
   - `<root>/@agentclientprotocol/codex-acp/package.json` → `bin["codex-acp"]` (checked: `dist/index.js`, version 2.9.0).
   - node: check each **absolute** `path_dirs` entry for `node.exe` (Windows) / `node` (Unix); skip relative and empty entries (they resolve against the current directory).
   - Suggested settings: claude `auth_env_names: ["ANTHROPIC_API_KEY"]`; codex `auth_env_names: ["CODEX_API_KEY", "OPENAI_API_KEY"]` (codex-acp README `e3a679f` lines 65, 72–73). claude-agent-acp can also use Claude Code's login state (reads the user profile; the env allow-list already has `HOME`/`USERPROFILE`/`APPDATA`).
   - Return candidates only; **never write files**.
5. In `src-tauri` add `adapters_list() -> AdapterFile`, `adapters_discover() -> Vec<Candidate>`, `adapters_save(file: AdapterFile) -> ()` (validate before writing). File path: `app.path().app_data_dir()?.join("adapters.json")`. Map errors to `IpcError { code, message }` (P1-2).
6. `real_agent_e2e.rs`: each test first checks `AGENTDOCK_REAL_AGENT_E2E == "1"` and reads ids `claude` and `codex` from the `AdapterFile` JSON at `AGENTDOCK_E2E_ADAPTERS`. Anything missing → **fail** with an explanation (never return early: "skipped looks like passed", ADR-0002 X-4).
7. `docs/dev/real-agent-e2e.md`: install (`npm install -g @agentclientprotocol/claude-agent-acp`, `npm install -g @agentclientprotocol/codex-acp`, or claude-agent-acp's standalone release binary), login (each agent's own login; AgentDock never touches it), creating the `AGENTDOCK_E2E_ADAPTERS` file, the commands for Linux and Windows, and filling the matrix. State that global npm installs are user decisions; implementers must ask the owner before installing.
8. `docs/compatibility/acp-agents.md` header: `Agent | Version | Launch | OS / version | initialize | session/new | prompt streaming | cancel | permission forwarding | behavior when login is needed | test date | AgentDock commit | notes`. This PR fills only the mock row; real agent rows are filled by the owner after running (the PR says "not run").

## 6. Tests to write first

`tests/adapters_config.rs` (temp directories with fake `node`/`node.exe`, `package.json`, `dist/index.js`; contents irrelevant):

| Test | Expected |
| --- | --- |
| `valid_executable_adapter_passes` | `validate()` Ok |
| `relative_program_rejected` | `BadPath { field: "program" }` |
| `cmd_shim_rejected_case_insensitive` (Windows-only) | `C:\...\claude-agent-acp.CMD` → `Shim` |
| `script_outside_node_modules_rejected` | `<tmp>/evil.js` → `BadScript` |
| `script_wrong_extension_rejected` | `<tmp>/node_modules/x/run.exe` → `BadScript` |
| `reserved_and_bad_ids_rejected` | `mock`, `Claude`, `a b`, 41 characters → `BadId` |
| `duplicate_ids_rejected` | `Duplicate("claude")` |
| `more_than_12_rejected` | `TooMany` |
| `secret_like_extra_env_rejected` | `("MY_API_KEY", "x")` → `ForbiddenEnv`; `("node_options","--require x")` → `ForbiddenEnv` (case-insensitive) |
| `node_script_builds_node_command` | `to_command` `program` is node, `args[0]` is the script |
| `discover_finds_npm_global_installs` | fake `<root>/@agentclientprotocol/claude-agent-acp/package.json` (`bin` → `dist/index.js`) + fake node in PATH → one claude candidate with the right script path |
| `discover_skips_relative_path_entries` | node only in `path_dirs = [".", "bin"]` → not used |
| `missing_file_loads_empty` | missing path → empty `adapters` |
| `file_with_version_2_rejected` | `BadVersion` |
| `save_then_load_roundtrip` | same content; temp path contains a space and CJK characters |

`real_agent_e2e.rs` (all `#[ignore = "needs real agent; set AGENTDOCK_REAL_AGENT_E2E=1"]`):

| Test | Steps | Expected |
| --- | --- | --- |
| `claude_prompt_roundtrip` / `codex_prompt_roundtrip` | `SessionRuntime::launch` (with an `abort` receiver that never flips) in a temp git repo (`git init`) → prompt `Reply with exactly the word: pong` | `EndTurn`; delta text contains `pong` (case-insensitive); session `idle` in the store |
| `claude_cancel_midturn` / `codex_cancel_midturn` | prompt `Count slowly from 1 to 200, one number per line.`; `cancel` after the first delta | `Cancelled` within 10 s |
| `claude_permission_forwarded` / `codex_permission_forwarded` | prompt `Create a file named agentdock-e2e.txt containing hello.`; fake handler always answers `reject_once` | at least one `on_permission`; file **absent** after the turn. If the agent wrote the file without asking, fail with a hint: "agent may be in bypass/full-access mode (ADR-0002 APR-11)" |
| `claude_shutdown_reaps_tree` / `codex_shutdown_reaps_tree` | launch, then `shutdown(Cancelled)` (P4-3 §5A rows H1–H2) | the agent's process tree is gone within 5 s; the closing transition carries `outcome: cancelled` |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-acp --test adapters_config            # 14 pass on Linux (15 on Windows)
cargo test -p agentdock-orchestrator --test real_agent_e2e    # 8 ignored (must be "ignored", not "passed")
# Owner only, on a machine with logged-in agents (Linux VM or Windows):
AGENTDOCK_REAL_AGENT_E2E=1 AGENTDOCK_E2E_ADAPTERS=/path/to/adapters.json \
  cargo test -p agentdock-orchestrator --test real_agent_e2e -- --ignored --test-threads=1
```

Windows-only: `cmd_shim_rejected_case_insensitive` runs in CI `rust-windows`. Real agent E2E on Windows is an owner action; record the OS in the matrix.

## 8. Spec references and porting sources

- ADR-0002 line 18 (decision 4: external runtimes are protocol adapters, not bundled), line 87, line 129 (APR-9), line 131 (APR-11 honest scope), line 174 (X-1), line 177 (X-4: skipped is not green).
- `docs/sources.md` lines 33–34 (claude-agent-acp `0073280`, codex-acp `7c98a16`, both Apache-2.0; external runtimes only, no code copied).
- Checked 2026-11-22: npm `@agentclientprotocol/claude-agent-acp` 0.109.1 (`bin.claude-agent-acp = dist/index.js`, `engines.node >= 22`), `@agentclientprotocol/codex-acp` 2.9.0 (`bin.codex-acp = dist/index.js`, repository `agentclientprotocol/codex-acp`). There is also `@zed-industries/codex-acp` (0.16.0, repository `zed-industries/codex-acp`), which is **not** the source in `docs/sources.md`; do not use it.
- claude-agent-acp README (`4af4581`) "Standalone executables": each release ships Windows x64/arm64 binaries that need no Node.js; `CLAUDE_CODE_EXECUTABLE` can expose MCP server env/headers on the command line.
- codex-acp README (`e3a679f`) lines 60–66 (authentication), lines 70–80 (environment variables, including `INITIAL_AGENT_MODE`, `CODEX_PATH`).
- Behavior references (Node draft, ideas only, do not port code): PR #25, SHA `7d41c9f1`, `apps/runtime/adapters.mjs` line 5 (id rule), lines 8–21 (absolute paths, reject shims), lines 24–40 (file validation, at most 12, unique ids); `adapters.example.json`.
- Issue #42 (licensing and support of other agents such as Grok Build; alpha covers Claude and Codex only).

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `dunce` | 1.0.5 | needs audit (P4-1 uses it too) |
| `serde`, `serde_json` | added by P2-1 | — |

## 10. Model tier

Standard model. Real E2E results require the owner to run them on a machine with logged-in agents; a model must never claim they passed.

## 11. Common mistakes and pitfalls

- Reading adapter config from the repo's `.agentdock/` or `package.json`: the agent can edit the repo, so it would choose what AgentDock launches. App data directory only.
- Launching `%APPDATA%\npm\claude-agent-acp.cmd` directly: P3-2 rejects it; use `node_script`. On Linux the npm bin entry is a symlink to the script; resolve via `package.json`'s `bin`, not by executing the symlink through a shell.
- Writing API keys into `extra_env`: the file is plain text; only names go into `auth_env_names`.
- Allowing `INITIAL_AGENT_MODE=agent-full-access`, Claude `bypassPermissions` and similar: the agent stops sending permission requests and AgentDock's approval guarantee is gone. Alpha forbids `INITIAL_AGENT_MODE` in `extra_env`. If the user enables bypass in the agent's own config, AgentDock cannot detect it; the UI must say per APR-11 "AgentDock only governs permissions the agent sends" (the indicator is #26, not this packet).
- Treating `@zed-industries/codex-acp` as the official package: different repository.
- Returning early in E2E when env vars are missing: shows as passed (X-4). `panic!` with an explanation.
- Node version: claude-agent-acp needs Node ≥ 22; with older Node the error is on stderr, and P3-5's `launch_failed` must include the redacted stderr tail so users understand it.

## 12. Reviewer checklist

- [ ] Is the adapter file read only from the app data directory?
- [ ] Are relative paths, shims, scripts outside `node_modules`, and denylisted env names rejected?
- [ ] Does discovery only read files, skip relative PATH entries, and cover both Windows and Linux npm roots?
- [ ] Do E2E tests fail (not pass) when configuration is missing, and are they `#[ignore]` in CI?
- [ ] Does the compatibility matrix mark real agent rows as "not run" unless the owner ran them?
