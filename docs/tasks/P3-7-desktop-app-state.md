# P3-7: Desktop app state (open the store, run recovery before accepting commands, startup failure screen)

> **繁中摘要**：在 `agentdock-desktop`（`src-tauri/`）建立 `AppState`，固定啟動順序：決定 app data 路徑 → 開 store（單一實例鎖、integrity check、migration）→ `Store::recover` → 才標記 Ready。Ready 前所有 command 回 `IpcError{code:"starting"}`。啟動失敗（第二個實例、資料庫損毀、schema 太新、migration 失敗、recovery 失敗）不 panic、不刪資料，前端橫幅顯示原因與備份路徑並停用工作區。建立共用的 `Redactor`（known secrets 只取名稱符合規則且長度 ≥ 8 的環境變數值）與 `ArtifactStore`。`bootstrap` 不依賴 Tauri 型別，可直接測試。模型等級：一般模型實作＋強模型審查。

Issues: #14, #15 | Gate (#51): G1 (install, start, close, reopen), G3 (true state after reopen), G8 (app recovery) | Model tier: **standard model implements, strong model reviews**

## 1. Goal and non-goals

Goals:

- `AppState` in `agentdock-desktop` (`src-tauri/`), the fixed place where later packets' Tauri commands get the store and services.
- Fixed startup order: **resolve the app data path → open the store (single-instance lock, integrity check, migrations) → `Store::recover` (P2-6) → only then mark Ready**. Before Ready, every command returns `IpcError { code: "starting" }` and can never read pre-recovery projections (contract: during recovery only recovery-actor events are accepted).
- Startup failures (second instance, corrupt database, schema too new, migration failure, recovery failure) never panic and never delete data; the frontend shows the reason and the backup path.
- Shared `Redactor` (P2-7) and `ArtifactStore` (P3-5b), both rooted inside app data.
- A `startup_status` command and a frontend startup banner.

Non-goals:

- Constructing services (`ApprovalService`, `CheckService`, `WorktreeManager`, ...): each owning packet adds a field to `Ready` and one construction line to `bootstrap` (rule in §5 step 2.5).
- Gracefully ending all sessions on close (P8-3); this packet only guarantees the store closes cleanly. Child processes end with the app via P3-2's Job Object / process group.
- Multiple windows, tray, auto-update.

## 2. Prerequisites and parallel work

- Prerequisites: P1-2 (Tauri shell and `IpcError`), P2-4, P2-6, P2-7, P3-5b (`ArtifactStore`).
- Parallel: P3-6, P4-1, P4-2, P5-1.
- **Tauri commands of P4-3a, P6-2, P7-1, P7-2, P8-1, P8-2, P8-3 depend on this packet.**

## 3. Files

New:

- `src-tauri/src/state.rs` (`AppState`, `Ready`, `StartupStatus`)
- `src-tauri/src/bootstrap.rs` (`bootstrap`, no Tauri types, callable from tests)
- `src-tauri/src/commands/startup.rs` (`startup_status`)
- `src-tauri/tests/bootstrap.rs`
- `src/ipc/startup.ts`
- `src/components/StartupBanner.tsx`
- `src/components/StartupBanner.test.tsx`

Modified: `src-tauri/src/lib.rs` (call bootstrap in `setup`, `manage`), `src-tauri/src/commands/mod.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`, `src-tauri/Cargo.toml` (depend on `agentdock-store`, `agentdock-orchestrator`), `src/App.tsx` (mount `StartupBanner` when `isTauri()`), `src/i18n/messages.ts`.

## 4. Public types and signatures

```rust
// src-tauri/src/state.rs
use std::sync::{Arc, OnceLock};

pub struct Ready {
    pub data_dir: std::path::PathBuf,
    pub store: Arc<agentdock_store::Store>,
    pub artifacts: Arc<agentdock_store::ArtifactStore>,
    pub redactor: Arc<agentdock_core::redact::Redactor>,
    pub recovery: agentdock_store::RecoveryReport,
    // Later packets add fields here, e.g. `pub approvals: Arc<ApprovalService>` (P4-3a).
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum StartupStatus {
    Starting,
    Ready { recovered_items: usize },
    Failed { code: String, message: String, backup: Option<String> },
}

#[derive(Default)]
pub struct AppState { inner: OnceLock<Result<Arc<Ready>, StartupStatus>> }
impl AppState {
    /// Every command except startup_status starts with `let r = state.ready()?;`.
    pub fn ready(&self) -> Result<Arc<Ready>, crate::commands::IpcError>;   // Starting → code "starting"; Failed → code "startup_failed"
    pub fn status(&self) -> StartupStatus;
    pub(crate) fn set(&self, r: Result<Arc<Ready>, StartupStatus>);         // only bootstrap; second call ignored
}

// src-tauri/src/bootstrap.rs
pub struct BootstrapInput<'a> {
    pub data_dir: std::path::PathBuf,              // app.path().app_data_dir() in production
    pub host_env: &'a [(String, String)],          // std::env::vars() in production
    pub home_dirs: Vec<std::path::PathBuf>,
    pub now: agentdock_core::time::Timestamp,
}
/// Blocking (SQLite); call from spawn_blocking. Never deletes or rewrites user data on failure.
pub fn bootstrap(input: BootstrapInput<'_>) -> Result<Ready, StartupStatus>;

/// Names whose values are treated as known secrets (ASCII case-insensitive), values >= 8 chars only.
pub fn is_secret_env_name(name: &str) -> bool;   // *_API_KEY, *_TOKEN, *SECRET*, *PASSWORD*, ANTHROPIC_*, OPENAI_*, CODEX_*, GH_*, GITHUB_*
```

```ts
// src/ipc/startup.ts
export type StartupStatus =
  | { state: 'starting' }
  | { state: 'ready'; recovered_items: number }
  | { state: 'failed'; code: string; message: string; backup?: string };
export function isStartupStatus(v: unknown): v is StartupStatus;
export async function startupStatus(): Promise<StartupStatus>;
```

## 5. Implementation steps

1. Write the §6 tests.
2. `bootstrap`:
   1. `create_dir_all(data_dir)`; subdirectories `artifacts/`, `worktrees/` (P5-2's default root).
   2. `Store::open(OpenOptions { path: data_dir/"agentdock.sqlite3", authority: local })`. Error mapping:

      | `agentdock_store::Error` | `code` | Meaning |
      | --- | --- | --- |
      | `AlreadyOpen` | `already_running` | another AgentDock is using the same data |
      | `Corrupt { backup }` | `database_corrupt` | `backup` = path; original kept |
      | `TooNew { .. }` | `database_too_new` | use a newer version |
      | `Migration { backup, .. }` | `migration_failed` | `backup` = path |
      | other | `startup_io` | `message` = error kind only |

   3. `store.recover(now)`; failure → `recovery_failed` (do not continue: projections may lie until recovery finishes).
   4. `Redactor::new(known_secrets, home_dirs)`: `known_secrets` = values in `host_env` whose name satisfies `is_secret_env_name` and whose value has ≥ 8 characters. `ArtifactStore::open(data_dir/"artifacts")`.
   5. Return `Ready`. Later packets adding services: add a field to `Ready` and construct it at the end of this function; **service construction must not write events** (recovery is over; writing events is a user action).
3. `lib.rs` `setup`: `app.manage(AppState::default())`; `tauri::async_runtime::spawn_blocking(bootstrap)`; when it finishes, `state.set(..)` and `emit("startup-status", status)`. Show the window immediately (do not wait for bootstrap); the frontend shows "starting".
4. `startup_status` command: returns `state.status()`; the only command that does not call `ready()`.
5. Frontend `StartupBanner`: `starting` → "Checking the state of your last session…"; `ready` with `recovered_items > 0` → "AgentDock did not close normally last time; N items were marked for your review" (link to the inbox after P8-2; text only before); `failed` → the matching message and backup path (plain text) and the whole workspace becomes `inert`. All strings go through `src/i18n/messages.ts` (en and zh-TW).

## 6. Tests to write first

`src-tauri/tests/bootstrap.rs` (temp directory with a space and CJK characters; calls `bootstrap` directly, no Tauri runtime):

| Test | Expected |
| --- | --- |
| `fresh_data_dir_starts_ready` | empty dir → `Ok`; `agentdock.sqlite3` and `artifacts/` exist; `recovery.is_empty()` |
| `recovery_runs_before_ready` | first write an `active` session and a `running` check through the store API, drop → after `bootstrap`, `recovery` lists that session and check; the store contains `system.recovery_completed` |
| `second_instance_reports_already_running` | while the first `Ready` is alive, `bootstrap` the same dir → `Failed { code: "already_running" }` |
| `corrupt_db_reports_backup_and_keeps_original` | overwrite the middle of the database file with garbage → `Failed { code: "database_corrupt", backup: Some(_) }`; original still present with unchanged bytes |
| `too_new_schema_reported` | `PRAGMA user_version` above supported → `database_too_new` |
| `secret_env_values_are_redacted` | `host_env` has `OPENAI_API_KEY=sk-test-abcdefgh` and `MY_TOKEN=short` (< 8) → `redactor.redact_text("x sk-test-abcdefgh")` lacks the value; `short` is not a known secret |
| `secret_env_name_rules` | `is_secret_env_name`: `anthropic_api_key`, `GH_TOKEN`, `DB_PASSWORD`, `CODEX_HOME` true; `PATH`, `USERNAME` false |
| `artifacts_root_inside_data_dir` | files written by `ready.artifacts` are under `data_dir/artifacts` |

`src-tauri/src/state.rs` unit tests:

| Test | Expected |
| --- | --- |
| `ready_before_set_is_starting` | `AppState::default().ready()` → `Err(code "starting")` |
| `ready_after_failure_is_startup_failed` | after `set(Err(Failed{..}))`, `ready()` → `Err(code "startup_failed")` |
| `set_twice_keeps_first` | the second `set` changes nothing |

`src/components/StartupBanner.test.tsx`:

| Test | Expected |
| --- | --- |
| `starting_text` | `starting` → the checking text appears |
| `recovered_items_text` | `ready, recovered_items: 3` → text mentions 3; `0` → no banner |
| `failed_shows_backup_as_text` | `backup: "<b>x</b>"` → no `b` element in the DOM; the text appears literally |
| `failed_makes_workspace_inert` | `failed` → the workspace container has the `inert` attribute |
| `startup_status_type_guard` | the three shapes are true; `{state:'ready'}` (missing `recovered_items`) is false |

## 7. Acceptance commands and expected results

```bash
# Linux needs the Tauri system packages (CONVENTIONS §1; ask the owner before installing) to compile agentdock-desktop.
npm run build                                                          # src-tauri embeds ../dist
cargo test -p agentdock-desktop --test bootstrap -- --test-threads=1   # 8 pass
cargo test -p agentdock-desktop state::                                # 3 pass
npm test                                                               # 5 new tests pass
```

Manual (owner, desktop session or `xvfb-run` on Linux, or Windows): `npm run tauri dev` → the banner shows "starting" then disappears; a second instance shows the `already_running` message.

Windows-only (CI `rust-windows`): the same Rust tests pass on `windows-latest`.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/checkpoint-and-replay.md` line 54 (recovery before accepting commands; only recovery-actor events meanwhile), lines 52–67 (recovery steps).
- `docs/contracts/README.md` line 62 (non-system events rejected during recovery).
- `docs/architecture.md` (app data separate from repos); `docs/contracts/events.md` line 113 (artifacts never in user repos).
- ADR-0003 (event store is the single source of truth; projections rebuilt from events).
- Issue #51 items 1 (start, close, reopen) and 3 (true state after reopen).
- No porting source.

## 9. Dependencies

No new crates (Tauri 2 `Manager::path()` came with P1-2).

## 10. Model tier

Standard model implements, strong model reviews. Review focus: no command reads or writes the store before Ready; failure paths delete nothing; known secrets are collected as values only and never logged.

## 11. Common mistakes and pitfalls

- Running bootstrap synchronously in `setup`: recovery on a large database freezes the window and Windows marks it "not responding". Use `spawn_blocking`.
- Opening the store in each command: the second open hits the single-instance lock. Open once, keep it in `Ready`.
- "Rebuilding a fresh database" on corruption: the user's history disappears. Report only; keep the original and the backup.
- Replacing `app_data_dir()` with a repo `.agentdock/`: artifacts and logs become readable/writable by agents and may be committed.
- Treating all of `std::env::vars()` as known secrets: ordinary values like `PATH` get redacted and logs become unreadable. Only rule-matching names with values ≥ 8 characters.
- Forgetting to add the command to `build.rs`'s AppManifest and capabilities: Tauri 2 rejects the call at runtime, and `cargo test` does not notice; manual acceptance must click it once.

## 12. Reviewer checklist

- [ ] Can any command reach the store before `ready()` succeeds?
- [ ] Is `recover` called before `set(Ok(..))`, and does a recovery failure stop startup?
- [ ] Do all failure paths keep the original database and report backups?
- [ ] Are known secrets selected by name rule and length, never logged?
- [ ] Is bootstrap run off the UI thread, and is the window shown immediately?
- [ ] Are banner strings localized and rendered as text (no HTML injection)?
