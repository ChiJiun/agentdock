# P4-1: Workspace path scope checks (traversal, symlinks/junctions, Windows path traps)

> **繁中摘要**：建立 `agentdock-policy` crate 的 `WorkspaceScope`：AgentDock 任何「用路徑做事」的地方（session cwd、check cwd、worktree、ACP permission 的 locations）都要先通過它，結果為 `Allow(ScopedPath)`／`Ask`／`Deny`。先在原始字串上做純字串規則（Windows 規則以參數開關，Linux 也能測：裝置路徑、UNC、ADS、結尾點與空白、保留裝置名、8.3 短檔名 → Ask、`..` 逃逸），再對最深的已存在祖先 `dunce::canonicalize`（解析 symlink／junction），逐 component 比對根目錄（Windows 不分大小寫）。junction 與大小寫測試為 Windows-only，交給 CI。模型等級：強模型實作＋強模型審查。

Issue: #8 | Gate (#51): G7 (host policy and path escape) | Model tier: **strong model implements and reviews**

## 1. Goal and non-goals

Goal: crate `agentdock-policy` with `WorkspaceScope`. Every place where AgentDock acts on a path (session cwd, check runner cwd, worktree paths, ACP permission `locations`, future `fs/*`) must pass it first (CONVENTIONS §6 invariant 4).

- Three outcomes: `Allow(ScopedPath)`, `Ask(reason)` (needs user confirmation, e.g. 8.3 short names), `Deny(reason)`.
- Resolve symlinks and junctions before deciding whether a path is inside an allowed root (ADR-0002 APR-5 last sentence: AgentDock's path checks handle symlinks/junctions).
- Windows specifics: `\` and `/`, `//`, `x/..`, trailing dots and spaces, `::$DATA` (ADS), 8.3 short names, reserved device names (`CON`, `NUL`, `COM1`…), `\\?\` and `\\.\` device paths, UNC (including `\\wsl$\`, `\\wsl.localhost\`), case-insensitive comparison (WT-9).
- The pure lexical part (string normalization and rejection rules) is separate from the filesystem part (canonicalize), so the lexical rules are unit-tested on every platform.

Non-goals: command string parsing (P4-2), approval flow (P4-3), agents running inside WSL (ADR-0002 WT-11; unsupported in alpha, README "not covered"), OS-level sandbox (#62).

## 2. Prerequisites and parallel work

- Prerequisites: P1-1.
- Parallel: P2-*, P3-*, P5-1. P3-5b, P4-2, P5-2, P6-1 use this packet.

## 3. Files

New:

- `crates/agentdock-policy/Cargo.toml`, `src/lib.rs`
- `crates/agentdock-policy/src/path_scope.rs`
- `crates/agentdock-policy/src/path_scope/lexical.rs` (pure string rules)
- `crates/agentdock-policy/tests/path_scope_fs.rs` (adversarial tests with real symlinks/junctions)

Modified: root `Cargo.toml` (members).

## 4. Public types and signatures

```rust
// crates/agentdock-policy/src/path_scope.rs
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathIntent { Read, Write, Delete, Cwd }

/// A path that passed the scope check: absolute, canonical (no \\?\ prefix, real casing for the existing part),
/// and inside one of the roots. Only constructible by this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopedPath { path: PathBuf, root_index: usize }
impl ScopedPath { pub fn as_path(&self) -> &Path; pub fn root_index(&self) -> usize; }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenyReason {
    NotAbsolute, OutsideRoots, DevicePath, UncPath, AlternateDataStream, TrailingDotOrSpace,
    ReservedDeviceName, ParentEscapesRoot, NulByte, TooLong, RootMissing, ResolvesOutsideRoots,
    DeleteRoot,                // Delete intent on a root itself
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskReason { ShortName83, NonExistentParentChain }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeDecision { Allow(ScopedPath), Ask(AskReason), Deny(DenyReason) }

pub struct WorkspaceScope { /* canonical roots */ }
impl WorkspaceScope {
    /// Roots must exist; each is canonicalized once (dunce::canonicalize). Duplicate/nested roots are allowed.
    pub fn new(roots: &[PathBuf]) -> Result<Self, DenyReason>;
    /// `base` is the session cwd used for relative inputs; it must itself be inside the scope.
    pub fn check(&self, input: &str, base: Option<&ScopedPath>, intent: PathIntent) -> ScopeDecision;
    pub fn roots(&self) -> &[PathBuf];
}

// crates/agentdock-policy/src/path_scope/lexical.rs  (pure; unit-tested on every OS)
pub enum LexicalResult { Ok(Vec<String> /* normalized components, no '.' or '..' */), Ask(AskReason), Deny(DenyReason) }
/// `windows` is a parameter (not cfg!) so Linux runs the Windows rules too.
pub fn lexical_check(input: &str, windows: bool) -> LexicalResult;
```

## 5. Implementation steps

1. Write the §6 tests.
2. `lexical_check(input, windows=true)`, in order (the first matching rule decides):
   1. Contains `\0` → `NulByte`; longer than 32,767 UTF-16 units → `TooLong`.
   2. Starts with `\\?\`, `\\.\`, `//?/`, `//./`, `\??\` → `DevicePath`.
   3. Starts with `\\` or `//` (UNC, including `\\wsl$\`, `\\wsl.localhost\`) → `UncPath`.
   4. Replace `/` with `\`, collapse repeated `\`.
   5. Per component (skipping the drive `C:`):
      - Contains `:` → `AlternateDataStream` (`file.txt::$DATA`, `file.txt:stream`).
      - Ends with `.` or a space (but is not `.`/`..` itself) → `TrailingDotOrSpace` (Windows silently strips them: `secret.txt.` is `secret.txt`).
      - Name without extension (case-insensitive) is `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`, `CONIN$`, `CONOUT$` → `ReservedDeviceName`.
      - Matches the 8.3 short-name shape `^[^~]{1,6}~[0-9]+(\.[^.]{0,3})?$` (e.g. `GITHUB~1`, `PROGRA~1`) → remember it; at the end return `Ask(ShortName83)` (APR-5). Implement by hand, no regex.
      - `.` skipped; `..` pops the previous component; nothing to pop → `ParentEscapesRoot`.
   6. No drive prefix (`C:\`) and no leading `\` → return components; `check` treats it as relative. Leading `\` without a drive (root of the current drive) → `NotAbsolute`. `C:foo` (drive-relative) → `NotAbsolute`.
   - With `windows=false`: only rules 1 and 5's `.`/`..` handling, splitting on `/` only; absolute means a leading `/`.
3. `check`:
   1. `lexical_check(input, cfg!(windows))`.
   2. Relative path: `base` is `None` → `NotAbsolute`; otherwise append to `base`.
   3. Find the "deepest existing ancestor": walk up from the full path to the first path where `symlink_metadata` succeeds; `dunce::canonicalize` it (resolves symlinks and junctions; `dunce` removes `\\?\`). Re-append the remaining non-existent components (lexical already removed `..`, so they cannot climb). More than 1 remaining component → `Ask(NonExistentParentChain)` (prevents deep new paths slipping past the check; P5-2 creates at most 1 new directory level).
   4. Compare with each root, component by component: Windows uses ASCII case-insensitive plus simple Unicode case folding (`to_lowercase`); Unix is case-sensitive. Inside a root → `Allow`. Otherwise, if the unresolved input looked inside a root → `ResolvesOutsideRoots`, else `OutsideRoots`.
   5. `intent == Delete` and the result equals a root → `DeleteRoot`.
   6. **Never** compare with string `starts_with` (`/work/repo-evil` would count as inside `/work/repo`).
4. Document the TOCTOU limit in the module docs: between check and use an agent may swap a directory for a junction/symlink. Mitigation: callers (P5, P6) call `check` again right before use; when AgentDock writes a file itself, re-check after opening. Full elimination needs handle-level APIs; README "not covered".

## 6. Tests to write first

`lexical.rs` unit tests (`windows=true`; run on Linux too):

```rust
use super::*;
fn deny(s: &str) -> DenyReason { match lexical_check(s, true) { LexicalResult::Deny(r) => r, _ => panic!("expected deny for {s:?}") } }
fn ask(s: &str) -> AskReason { match lexical_check(s, true) { LexicalResult::Ask(r) => r, _ => panic!("expected ask for {s:?}") } }
fn ok(s: &str) -> Vec<String> { match lexical_check(s, true) { LexicalResult::Ok(v) => v, _ => panic!("expected ok for {s:?}") } }

#[test] fn device_and_unc_paths_denied() {
    assert_eq!(deny(r"\\?\C:\repo\a"), DenyReason::DevicePath);
    assert_eq!(deny(r"\\.\PhysicalDrive0"), DenyReason::DevicePath);
    assert_eq!(deny(r"\\server\share\a"), DenyReason::UncPath);
    assert_eq!(deny(r"\\wsl$\Ubuntu\home\u"), DenyReason::UncPath);
    assert_eq!(deny(r"//wsl.localhost/Ubuntu/x"), DenyReason::UncPath);
}
#[test] fn ads_and_trailing_dot_space_denied() {
    assert_eq!(deny(r"C:\repo\a.txt::$DATA"), DenyReason::AlternateDataStream);
    assert_eq!(deny(r"C:\repo\a.txt:hidden"), DenyReason::AlternateDataStream);
    assert_eq!(deny(r"C:\repo\secret.txt."), DenyReason::TrailingDotOrSpace);
    assert_eq!(deny(r"C:\repo\dir \a"), DenyReason::TrailingDotOrSpace);
}
#[test] fn reserved_names_denied_case_insensitive_with_extension() {
    assert_eq!(deny(r"C:\repo\nul"), DenyReason::ReservedDeviceName);
    assert_eq!(deny(r"C:\repo\Con.txt"), DenyReason::ReservedDeviceName);
    assert_eq!(deny(r"C:\repo\com1.log"), DenyReason::ReservedDeviceName);
}
#[test] fn short_names_ask() { assert_eq!(ask(r"C:\PROGRA~1\x"), AskReason::ShortName83); assert_eq!(ask(r"C:\repo\GITHUB~1"), AskReason::ShortName83); }
#[test] fn dotdot_cannot_escape_drive_root() { assert_eq!(deny(r"C:\..\..\Windows"), DenyReason::ParentEscapesRoot); }
#[test] fn mixed_separators_normalized() { assert_eq!(ok(r"C:/repo//src\.\a\..\b.rs"), vec!["C:", "repo", "src", "b.rs"]); }
#[test] fn drive_relative_and_rooted_without_drive_denied() {
    assert_eq!(deny(r"C:repo\a"), DenyReason::NotAbsolute);
    assert_eq!(deny(r"\repo\a"), DenyReason::NotAbsolute);
}
#[test] fn nul_denied() { assert_eq!(deny("C:\\repo\\a\0b"), DenyReason::NulByte); }
#[test] fn cjk_and_spaces_are_fine() { assert_eq!(ok(r"C:\agent dock 測試\a b.rs").len(), 3); }
#[test] fn unix_rules_do_not_apply_windows_names() {
    // windows=false: "nul" and "a.txt:x" are ordinary names on Linux; only '..' escape is denied.
    assert!(matches!(lexical_check("/repo/nul", false), LexicalResult::Ok(_)));
    assert!(matches!(lexical_check("/../../etc", false), LexicalResult::Deny(DenyReason::ParentEscapesRoot)));
}
```

`tests/path_scope_fs.rs` (temp dir name contains a space and CJK characters; root = `<tmp>/repo`; also `<tmp>/outside`, `<tmp>/repo-evil`):

| Test | Platform | How | Expected |
| --- | --- | --- | --- |
| `inside_file_allowed` | all | `<tmp>/repo/src/a.rs` (exists) | `Allow`; `as_path` has no `\\?\` |
| `new_file_in_existing_dir_allowed` | all | `<tmp>/repo/src/new.rs` (missing) | `Allow` |
| `deep_new_path_asks` | all | `<tmp>/repo/x/y/z.rs` (x missing) | `Ask(NonExistentParentChain)` |
| `sibling_prefix_is_outside` | all | `<tmp>/repo-evil/a` | `Deny(OutsideRoots)` |
| `dotdot_out_of_root_denied` | all | `<tmp>/repo/../outside/a` | `Deny(OutsideRoots)` |
| `case_insensitive_root_match` | Windows-only | root in lowercase, input in uppercase | `Allow` |
| `case_sensitive_on_unix` | Unix-only | root `<tmp>/repo`, input `<tmp>/REPO/a` (no such dir) | not `Allow` |
| `relative_with_base` | all | `src/a.rs`, base = `<tmp>/repo` | `Allow` |
| `relative_without_base_denied` | all | `src/a.rs`, base = None | `Deny(NotAbsolute)` |
| `symlink_dir_escape_denied` | all | `<tmp>/repo/link` → `<tmp>/outside` (`std::os::unix::fs::symlink` / `std::os::windows::fs::symlink_dir`); check `<tmp>/repo/link/secret` | `Deny(ResolvesOutsideRoots)` |
| `symlink_file_escape_denied` | all | `<tmp>/repo/f` → `<tmp>/outside/secret.txt` | `Deny(ResolvesOutsideRoots)` |
| `junction_escape_denied` | Windows-only | `<tmp>\repo\j` is a junction to `<tmp>\outside` (created with the `junction` crate); check `<tmp>\repo\j\secret` | `Deny(ResolvesOutsideRoots)` |
| `symlink_inside_root_allowed` | all | `<tmp>/repo/l` → `<tmp>/repo/src` | `Allow`, path resolved to `<tmp>/repo/src/...` |
| `delete_root_denied` | all | `Delete` intent on `<tmp>/repo` | `Deny(DeleteRoot)` |

Creating symlinks on Windows needs Developer Mode or admin; GitHub `windows-latest` runs as admin, so it works there. If creation fails locally, the test must `panic!` with "enable Developer Mode", never pass silently (X-4).

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-policy path_scope    # Linux: 10 lexical + 12 fs pass
```

Windows-only (CI `rust-windows`): 10 lexical + 13 fs pass, including `junction_escape_denied` and `case_insensitive_root_match`. Link the run in the PR.

## 8. Spec references and porting sources

- Issue #8 Requirement 2 (scoped paths, symlink resolution, deny outside workspace), Acceptance.
- ADR-0002 line 124 APR-4 (relative paths resolve against the session cwd), line 125 APR-5 (Windows normalization, 8.3 → ask, symlinks/junctions handled by AgentDock), line 143 WT-9 (case-insensitive), line 145 WT-11 (WSL; this packet only rejects the UNC form).
- `docs/architecture.md` line 91 (explicit workspace path checks including symlink resolution).
- Behavior references (Node draft, ideas only, do not port code): PR #25, SHA `7d41c9f1`, `apps/runtime/adapters.mjs` lines 41–52 `ensureInside` (`realpath` then `relative`; this packet resolves before comparing too and adds Windows rules); `runtime.test.mjs` line 43 (traversal/symlink escape refused before any process starts). Acpira PR #6 path cases inspire tests only (listed by ADR-0002 line 125); no code copied.

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `dunce` | 1.0.5 | needs audit |
| `junction` (dev-dependency, `cfg(windows)` only) | latest 1.x | needs audit; tests only |
| `tempfile` (dev) | 3.27.0 | needs audit |

## 10. Model tier

Strong model implements and reviews. Any hole lets an agent read or write outside the workspace (e.g. the user's SSH keys).

## 11. Common mistakes and pitfalls

- String `starts_with(root)`: `/work/repo-evil` passes. Compare components.
- Comparing `std::fs::canonicalize` output directly: on Windows it returns `\\?\C:\...`, which never matches the plain root form; use `dunce::canonicalize` for both roots and targets.
- Canonicalizing a missing path: fails; canonicalize the deepest existing ancestor.
- Canonicalizing before the lexical check: Windows rewrites names like `secret.txt.` during canonicalization, hiding the problem. Lexical checks run on the raw string first.
- Forgetting junctions: junctions are not symlinks (`is_symlink()` is false for them on Windows); do not inspect reparse points yourself, let canonicalize resolve them.
- Case: Windows `C:\Repo` and `c:\repo` are the same; on Unix they are not. Never case-fold on Unix.
- `/mnt/c/...` is not absolute on Windows and is caught by `NotAbsolute`; do not "helpfully" convert it to `C:\` (WT-11 unsupported).
- Treating `Ask` as `Allow`: callers (P4-3) must turn `Ask` into a user approval, never default to pass.

## 12. Reviewer checklist

- [ ] Do lexical checks run on the raw input before any filesystem call?
- [ ] Is containment decided by component comparison (case-insensitive only on Windows)?
- [ ] Are symlink and junction escapes denied, and was the Windows junction test run in CI?
- [ ] Does a deep non-existent path return `Ask`, and a root delete return `Deny`?
- [ ] Is `ScopedPath` constructible only inside the module?
- [ ] Is the TOCTOU limitation documented for callers?
