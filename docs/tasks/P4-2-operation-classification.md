# P4-2: Operation classification (ACP permission → `PolicyClass`, command decomposition, fail closed)

> **繁中摘要**：在 `agentdock-policy` 提供純函式 `classify_permission`：把 ACP permission 的 `toolCall`（`kind`、`rawInput`、`locations`）轉成契約的 13 種 `PolicyClass`，並把每個路徑交給 P4-1 判斷。**只看解析出的指令、路徑與 URL，永遠不看 agent 寫的 `title`**。指令拆解涵蓋 `&&`／`;`／`|`、`bash -c`、`cmd /c`、`powershell -Command`／`-EncodedCommand`、`sudo`／`env`／`xargs`／`find -exec` 等；無法還原（`$(...)`、反引號、引號未關）、超過 16 KiB 或巢狀超過 4 層一律 `unclassified`（只能由使用者核准）。多段取最嚴重；線性時間，不用回溯型 regex。模型等級：強模型實作＋強模型審查。

Issue: #8 | Gate (#51): G7 | Model tier: **strong model implements and reviews**

## 1. Goal and non-goals

Goal: pure function `classify_permission` in `agentdock-policy` that turns an ACP `session/request_permission` `toolCall` (`kind`, `rawInput`, `locations`) into the contract's `PolicyClass`, plus a P4-1 decision for every path. **It looks only at parsed commands, paths and URLs, never at the agent-written `title` or descriptions** (schema `PolicyClass` description; ADR-0002 APR-1).

- `PolicyClass` (schema enum, 13 values): `read_only`, `workspace_edit`, `command`, `config_write`, `git_push`, `pr_write`, `external_write`, `pr_merge`, `force_push`, `branch_delete`, `worktree_remove`, `destructive_command`, `unclassified`.
- Command decomposition (APR-6): `&&`, `||`, `;`, `|`, `&`, newline, subshell `( )`, `$(...)`, backticks, `bash -c` / `sh -c`, `cmd /c`, `powershell` / `pwsh -Command` / `-c` / `-EncodedCommand`, `sudo` / `env` / `xargs` / `find -exec`, `uv run`, `npx`, heredoc bodies are data not commands, PowerShell `{ }` blocks.
- Commands that cannot be fully recovered → `unclassified` (APR-7, user approval only).
- Fail closed (APR-2): input over 16 KiB, nesting over 4 levels, internal parser error → `unclassified`, never `read_only`.
- Linear time (APR-3): no backtracking regexes; hostile input finishes in bounded time.
- Multi-segment commands take the most severe class (order in §4).

Non-goals: approvals and policy rules (P4-3), executing commands (alpha does not implement `terminal/*`), detecting agents' native bypass modes (#26).

## 2. Prerequisites and parallel work

- Prerequisites: P4-1, P2-1 (`acp_permission_fingerprint`).
- Parallel: P3-*, P5-*. P4-3 uses this packet.

## 3. Files

New:

- `crates/agentdock-policy/src/classify.rs`
- `crates/agentdock-policy/src/classify/tokenize.rs` (quote-aware tokenizing and segmenting, pure)
- `crates/agentdock-policy/src/classify/rules.rs` (per-command rules)
- `crates/agentdock-policy/tests/classify_cases.rs` (table-driven)
- `crates/agentdock-policy/tests/classify_hostile.rs`

Modified: `crates/agentdock-policy/src/lib.rs`, `Cargo.toml` (depend on `agentdock-core`).

## 4. Public types and signatures

```rust
// crates/agentdock-policy/src/classify.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyClass {
    // ordered from least to most severe; max() of segments wins
    ReadOnly, WorkspaceEdit, Command, ConfigWrite, ExternalWrite, PrWrite, GitPush,
    WorktreeRemove, BranchDelete, PrMerge, ForcePush, DestructiveCommand, Unclassified,
}
impl PolicyClass {
    /// pr_merge, force_push, branch_delete, worktree_remove, destructive_command, unclassified (schema PolicyClass).
    pub fn user_only(self) -> bool;
    /// Mapping to OperationKind when AgentDock itself would execute it (schema PolicyClass description):
    /// git_push, external_write, pr_merge, branch_delete, worktree_remove, destructive_command;
    /// PrWrite → None (caller picks pr_create/pr_update/pr_comment); ForcePush → "destructive_command".
    pub fn operation_kind(self) -> Option<&'static str>;
}

pub const MAX_INPUT_BYTES: usize = 16 * 1024; // APR-2 (Acpira cap)
pub const MAX_UNWRAP_DEPTH: u8 = 4;

#[derive(Debug, Clone, PartialEq)]
pub struct Classification {
    pub class: PolicyClass,
    pub reasons: Vec<String>,                  // short machine-made strings, e.g. "segment 2: git push --force"
    pub paths: Vec<(String, crate::path_scope::ScopeDecision)>, // every location / path argument checked by P4-1
    pub fingerprint: agentdock_core::ids::Sha256Hex,          // acp_permission_fingerprint(tool_call_id, title)
}

/// tool_call: the raw ACP `toolCall` JSON (untrusted). scope/base: P4-1 for locations and relative paths.
pub fn classify_permission(tool_call: &serde_json::Value, scope: &crate::path_scope::WorkspaceScope,
                           base: &crate::path_scope::ScopedPath) -> Classification;
/// Exposed for tests and for P6/P7 when AgentDock classifies its own commands.
pub fn classify_command(command: &str, depth: u8) -> (PolicyClass, Vec<String>);

// crates/agentdock-policy/src/classify/tokenize.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment { Argv(Vec<String>), Opaque(String) } // Opaque = could not be recovered (→ Unclassified)
/// POSIX-ish quoting ('...', "...", backslash), plus detection of $( ), backticks, <( ), heredoc bodies.
/// Splits on && || ; | & newline. Linear in input length; never recursive on input content.
pub fn split_segments(command: &str) -> Vec<Segment>;
```

Reading `toolCall` (ACP v1 `ToolCallUpdate`: `kind`, `rawInput`, `locations[].path` are all optional):

| Condition | Command source |
| --- | --- |
| `rawInput.command` is a string | that string |
| `rawInput.command` is an array of strings | that array as argv (no re-tokenizing; but if argv[0] is `bash` / `sh` / `cmd` / `powershell` / `pwsh`, still unwrap) |
| `rawInput.cmd` or `rawInput.commandLine` (string) | that string |
| `kind == "execute"` and none of the above | `Unclassified` (APR-7) |

## 5. Implementation steps

1. Write the §6 tests (tables first).
2. `split_segments`: one character loop state machine (states: normal, single quote, double quote, escape). On:
   - unquoted `&&`, `||`, `;`, `|`, `&`, `\n` → end the current segment.
   - `$(`, backtick, `<(`, `>(` unquoted or inside double quotes → the whole command is `Opaque` (alpha does not recover subcommands; APR-7 → ask).
   - heredoc `<<` / `<<-` + marker: skip the body until the marker line as data (not commands), but mark the segment "has redirection".
   - unquoted `>`, `>>`, `2>`, `1>`, `*>` (PowerShell) → record "file write redirection" (TR-3: redirection counts as a write).
   - unterminated quote → `Opaque`.
3. `classify_command(command, depth)`:
   - `command.len() > MAX_INPUT_BYTES` or `depth > MAX_UNWRAP_DEPTH` → `Unclassified`.
   - Per segment: `Opaque` → `Unclassified`. `Argv`: strip wrapper prefixes repeatedly: `sudo` (with options), `env` (with `K=V`), `nice`, `time`, `command`, `exec`, `xargs` (rest is the command), `uv run`, `npx` / `pnpm dlx` / `bunx` (rest is the command).
   - Unwrap (recursively with `depth + 1`): `bash|sh|zsh -c <s>`, `cmd /c|/k <rest>` (`/d`, `/s` may precede), `powershell|pwsh [-NoProfile ...] -Command|-c <rest>`, `-EncodedCommand|-enc|-e <b64>` (base64 → UTF-16LE; decode failure → `Unclassified`), `find ... -exec <cmd> ... ;` and `-delete` (`-delete` → `DestructiveCommand`).
   - argv[0]'s file name (strip directories, `.exe`, lowercase) goes to `rules.rs`.
   - Command class = `max()` over segments; a write redirection with class `ReadOnly` → `Command`.
4. `rules.rs` (anything incomplete errs toward stricter):

| argv shape | Class |
| --- | --- |
| `git push` with `-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, or any refspec starting with `+` | `ForcePush` |
| `git push` with `--delete` / `-d`, or a refspec starting with `:` | `BranchDelete` |
| `git push` (other) | `GitPush` |
| `git branch -d|-D|--delete`, `git tag -d`, `git update-ref -d` | `BranchDelete` |
| `git worktree remove|prune` | `WorktreeRemove` |
| `git reset --hard`, `git clean` with `-f`, `git checkout -- <path>` or `git checkout .`, `git restore` (not `--staged`), `git stash drop|clear`, `git filter-branch`, `git filter-repo` | `DestructiveCommand` |
| `git config` (not `--get` / `--list` / `-l`), `git remote add|set-url|remove` | `ConfigWrite` |
| `git status|log|diff|show|rev-parse|ls-files|blame|branch` (no delete flags) `|remote -v|fetch` | `ReadOnly` (`fetch` is a network read; still `ReadOnly`) |
| `gh pr merge` | `PrMerge` |
| `gh pr create|edit|comment|review|close|reopen`, `gh issue create|comment|edit|close` | `PrWrite` (issue writes count as `PrWrite`: same GitHub write surface) |
| `gh repo delete`, `gh release delete` | `DestructiveCommand` |
| `gh api`: `-X|--method` not `GET`, or any of `-f|-F|--field|--raw-field|--input` (gh defaults to POST) → `ExternalWrite`; `gh api graphql` whose query has no `mutation` → `ReadOnly`; with `mutation` → `ExternalWrite` | per rule (APR-8) |
| `gh pr view|list|checks|diff|status`, `gh run view|list`, `gh issue view|list` | `ReadOnly` |
| `curl` / `wget`: `-X|--request` not GET, `-d|--data*|-F|--form|-T|--upload-file|--json`, `wget --post-*|--method` → `ExternalWrite`; otherwise `Command` | per rule (APR-8) |
| `Invoke-RestMethod|irm|Invoke-WebRequest|iwr`: `-Method` not `Get`, or `-Body|-InFile` → `ExternalWrite`; otherwise `Command` | per rule |
| `rm` with `-r|-R|--recursive|-f`, `rmdir /s`, `rd /s`, `del /s|/q`, `Remove-Item` with `-Recurse|-Force`, `format`, `mkfs*`, `dd`, `diskpart`, `shred`, `truncate`, `sqlite3` / `psql` / `mysql` with `DROP|DELETE|TRUNCATE` (case-insensitive, in arguments) | `DestructiveCommand` |
| `rm` (single file, no flags), `mv`, `cp`, `touch`, `mkdir`, `Set-Content`, `Out-File`, `New-Item` | `WorkspaceEdit` (every path argument goes to P4-1; any `Deny` is put into `paths`, and P4-3 refuses) |
| `ls|dir|cat|type|head|tail|less|more|wc|rg|grep|findstr|find` (no `-delete` / `-exec`) `|echo|pwd|which|where|Get-ChildItem|Get-Content|Select-String|tree` | `ReadOnly` |
| `cargo|npm|pnpm|yarn|node|python|pytest|go|make|dotnet|tsc|vitest|jest|eslint` | `Command` |
| any other argv[0] | `Command` |

   - Path arguments or redirection targets touching policy files (P4-3's policy file, `.git/config`, `.git/hooks/*`, `.github/workflows/*`) → at least `ConfigWrite` (APR-9, APR-10 "config files").
5. `classify_permission`:
   - `kind` `read` / `search` (no command) with every `locations` path `Allow` → `ReadOnly`; `edit` / `delete` / `move` → `WorkspaceEdit` (`delete` of a directory → `DestructiveCommand`); `fetch` → `Command`; `think` / `switch_mode` → `ReadOnly`; `execute` → by command; other or missing → by command if present, else `Unclassified`.
   - Every `locations[].path` and every path argument in the command goes through P4-1 (`PathIntent` by class: `ReadOnly` → `Read`; `WorkspaceEdit` → `Write`; `DestructiveCommand` → `Delete`).
   - `fingerprint = acp_permission_fingerprint(toolCallId, title)` (contract definition; `title` is used only for the fingerprint, never for classification).

## 6. Tests to write first

`tests/classify_cases.rs`: a `const CASES: &[(&str, PolicyClass)]` table asserting `classify_command(cmd, 0).0` row by row, including at least:

```rust
("git status", ReadOnly),
("git push origin HEAD", GitPush),
("git push --force origin main", ForcePush),
("git push origin +main", ForcePush),
("git push --force-with-lease", ForcePush),
("git push origin :feature", BranchDelete),
("git push origin --delete feature", BranchDelete),
("git branch -D feature", BranchDelete),
("git worktree remove ../wt", WorktreeRemove),
("git reset --hard HEAD~1", DestructiveCommand),
("git clean -fdx", DestructiveCommand),
("git checkout -- .", DestructiveCommand),
("git config user.email x@y", ConfigWrite),
("git config --get user.email", ReadOnly),
("gh pr merge 6 --squash --auto", PrMerge),
("gh pr create --fill", PrWrite),
("gh pr view 6", ReadOnly),
("gh api repos/o/r/pulls -f title=x", ExternalWrite),
("gh api -X DELETE repos/o/r", ExternalWrite),
("gh api graphql -f query='query { viewer { login } }'", ReadOnly),
("gh api graphql -f query='mutation { addStar(input:{}) { clientMutationId } }'", ExternalWrite),
("curl https://api.github.com/repos/o/r", Command),
("curl -X POST https://api.github.com/repos/o/r/issues -d '{}'", ExternalWrite),
("Invoke-RestMethod -Method Post -Uri https://api.github.com/x -Body '{}'", ExternalWrite),
("rm -rf build", DestructiveCommand),
("Remove-Item -Recurse -Force .\\dist", DestructiveCommand),
("ls -la && git push --force", ForcePush),
("echo ok; rm -rf /", DestructiveCommand),
("bash -c \"git push -f\"", ForcePush),
("cmd /d /s /c \"git push --force\"", ForcePush),
("powershell -NoProfile -Command \"git push --force\"", ForcePush),
("sudo env FOO=1 git push", GitPush),
("find . -name '*.tmp' -delete", DestructiveCommand),
("find . -exec rm -rf {} ;", DestructiveCommand),
("echo $(git push -f)", Unclassified),
("echo `whoami`", Unclassified),
("echo 'unterminated", Unclassified),
("cat a.txt > b.txt", Command),
("cat <<EOF\ngit push --force\nEOF", ReadOnly),   // heredoc body is data, not a command (APR-6)
("npx eslint .", Command),
("uv run pytest", Command),
("cargo test", Command),
```

Also:

- `encoded_command_is_decoded`: `powershell -EncodedCommand <base64 of UTF-16LE "git push --force">` → `ForcePush`; invalid base64 → `Unclassified`.
- `nested_depth_limit`: build 5 levels of `bash -c` programmatically (each level single-quotes the inner command with a `shell_quote` helper that escapes inner single quotes), innermost `ls` → `Unclassified`; 4 levels → `ReadOnly`.
- `user_only_set_matches_schema`: the set where `user_only()` is true is exactly `{PrMerge, ForcePush, BranchDelete, WorktreeRemove, DestructiveCommand, Unclassified}`.
- `operation_kind_mapping`: `ForcePush → Some("destructive_command")`, `GitPush → Some("git_push")`, `PrWrite → None`, `ReadOnly → None`.
- `title_is_ignored`: two `toolCall`s differing only in `title` (`"Safe read"` vs `"git push --force"`) with the same `rawInput.command` → same class; different `fingerprint`.
- `execute_without_command_is_unclassified`: `{"toolCallId":"c","kind":"execute"}` → `Unclassified`.
- `location_outside_scope_is_reported`: `kind: "edit"`, `locations: [{"path": "<outside>"}]` → `paths[0].1` is `Deny(..)`.
- `policy_file_write_is_config_write`: `echo x > .github/workflows/ci.yml` → `ConfigWrite`.

`tests/classify_hostile.rs` (APR-3; must pass in debug and release):

```rust
#[test] fn many_git_tokens_then_merge_is_fast_and_caught() {
    let cmd = format!("echo {}; gh pr merge 6 --squash --auto", "git ".repeat(30_000));
    let t = std::time::Instant::now();
    let (class, _) = classify_command(&cmd, 0);
    assert!(t.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(class, PolicyClass::Unclassified); // > 16 KiB → fail closed (still user-only)
}
#[test] fn under_cap_merge_is_found() {
    let cmd = format!("echo {}; gh pr merge 6 --squash --auto", "git ".repeat(3_000));
    assert_eq!(classify_command(&cmd, 0).0, PolicyClass::PrMerge);
}
#[test] fn glob_like_input_is_linear() {
    let cmd = format!("ls {}", "*a".repeat(5_000));
    let t = std::time::Instant::now();
    let _ = classify_command(&cmd, 0);
    assert!(t.elapsed() < std::time::Duration::from_millis(500));
}
#[test] fn deeply_nested_quotes_do_not_overflow() { /* 8_000 alternating quote chars → returns, no panic */ }
```

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-policy classify             # all pass (42 table rows + 8 + 4)
cargo test -p agentdock-policy classify --release
```

No Windows-only items (Windows command shapes are plain strings and are tested on Linux).

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- Schema `$defs.PolicyClass` (13 values, user-only classes, OperationKind mapping).
- `docs/contracts/checkpoint-and-replay.md` lines 71–87 (OperationKind table; force push classified as `destructive_command`), lines 91–96 (ACP permissions are always `operation_kind: tool_call`, decided by `classified_kind`; APR-11 scope).
- `docs/contracts/acp-capabilities.md` line 93 (`classified_kind` is computed in Rust from parsed command/path/URL, never from agent text).
- ADR-0002 lines 121–131 (APR-1..APR-11), especially line 122 APR-2 (16 KiB, fail closed), line 123 APR-3 (hostile input examples, used directly in the tests), line 126 APR-6, line 127 APR-7, line 128 APR-8, line 130 APR-10; line 167 TR-3 (redirection, `sed -i`, `find -delete` / `-exec` count as writes).
- Test-case source only: the Acpira PR #6 (approval-rules) cases recorded in ADR-0002 (Issue #8 "reuse requirements/test cases"); no code copied. PR #25 (SHA `7d41c9f1`) has no command classification (it only used ACP option kinds); this is new.

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `base64` | latest 0.22.x | needs audit (`-EncodedCommand` decoding) |
| `serde_json` | added by P2-1 | — |
| `agentdock-core` | workspace | fingerprint |

No `regex` for command parsing (the state machine suffices); if a rule ever needs matching, only the `regex` crate (linear time), never `fancy-regex` or other backtracking engines.

## 10. Model tier

Strong model implements and reviews. Misclassification (force push as `command`) lets policy auto-approve something only a user may approve.

## 11. Common mistakes and pitfalls

- Deciding by `title` or the agent's description: an agent can title `git push --force` "Read file". Only `rawInput`.
- Returning `Command` or `ReadOnly` on parse failure: must be `Unclassified` (user-only).
- Looking only at the first segment: `ls && git push -f`.
- Forgetting to unwrap `cmd /c` and `powershell -Command`: agents on Windows run commands this way.
- Decoding `-EncodedCommand` as UTF-8: PowerShell specifies UTF-16LE.
- Recursive descent on user strings without a depth limit: can overflow the stack (X-2: Windows debug main thread has 1 MB).
- Escalating network reads (`git fetch`, `curl` GET) to denial: classification decides *who may approve*; over-escalation makes every read need a click. But "unsure" always goes stricter.
- Classification is defense in depth, not a guarantee (APR-11): the PR and docs must never claim it "catches all dangerous commands".

## 12. Reviewer checklist

- [ ] Is `title` used only for the fingerprint, never for the class?
- [ ] Does every unrecoverable construct, oversized input and deep nesting return `Unclassified`?
- [ ] Are `cmd /c`, `powershell -Command` and `-EncodedCommand` (UTF-16LE) unwrapped?
- [ ] Is the class the maximum over all segments, with write redirection raising `ReadOnly` to `Command`?
- [ ] Do hostile tests pass in release and debug within their time budgets?
- [ ] Do policy-file writes classify as at least `ConfigWrite`?
