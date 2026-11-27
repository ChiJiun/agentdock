# P1-3: Rust CI on Linux and Windows, cargo-deny, developer setup docs

> **繁中摘要**：新增 `.github/workflows/rust.yml`：`rust-linux`（安裝 Tauri 系統套件後跑整個 workspace 的 fmt／clippy／test）、`rust-windows`（fmt／clippy／test、Tauri debug build、啟動兩次的 smoke，所有 Windows-only 測試在這裡跑）、`cargo-deny`。新增 `deny.toml` 與 Linux VM／Windows 的開發環境說明。不改 `frontend.yml`（它的 `check` 是 main 的 required check），新 job 不設為 required、名稱不可叫 `check`。模型等級：一般模型可。

Issues: #4, #41, #55 | Gate (#51): G1 (reproducible build and minimal smoke CI) | Model tier: **standard model**

## 1. Goal and non-goals

Goals:

- `.github/workflows/rust.yml` with three jobs:
  - `rust-linux` (ubuntu-latest): install the Tauri build packages on the runner, then fmt / clippy / test for the **whole** workspace (the implementer's environment is Linux, so CI mirrors it).
  - `rust-windows` (windows-latest): fmt / clippy / test (this is where every `#[cfg(windows)]` test runs), Tauri debug build, smoke launched twice (start, close, reopen).
  - `cargo-deny`: `cargo deny check`.
- `deny.toml` (licenses, advisories, sources, bans).
- `docs/dev/linux-vm-setup.md` and `docs/dev/windows-setup.md`.

Non-goals:

- **Do not modify** `.github/workflows/frontend.yml` (its job `check` is the required check of the "Protect main" ruleset, #55; renaming or splitting it blocks merging).
- **Do not make the new jobs required**; the owner does that later (#55/#41).
- No release packaging (P9-1), no PR template (#41).

## 2. Prerequisites and parallel work

- Prerequisites: P1-1. The Tauri build and smoke steps need P1-2; if P1-2 has not merged, ship fmt/clippy/test/deny first and say in the PR that smoke follows in a small PR after P1-2.
- Parallel: P1-2.

## 3. Files

New:

- `.github/workflows/rust.yml`
- `deny.toml`
- `docs/dev/linux-vm-setup.md`
- `docs/dev/windows-setup.md`

Modified: none.

## 4. Configuration (replaces "types and signatures")

`.github/workflows/rust.yml` (pin every action to a **full commit SHA** with the tag in a comment; find SHAs with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`):

```yaml
name: Rust
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: rust-${{ github.ref }}
  cancel-in-progress: true
jobs:
  rust-linux:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: actions/setup-node@<sha> # v4
        with: { node-version: '22', cache: npm }
      - name: Tauri system packages (runner only)
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
            libssl-dev libayatana-appindicator3-dev librsvg2-dev
      - run: rustup show            # installs the toolchain from rust-toolchain.toml
      - uses: Swatinem/rust-cache@<sha> # v2 (third-party action, needs audit)
      - run: npm ci && npm run build   # Tauri's generate_context! needs ../dist
      - run: cargo fmt --all -- --check
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo test --workspace
  rust-windows:
    runs-on: windows-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: actions/setup-node@<sha> # v4
        with: { node-version: '22', cache: npm }
      - run: rustup show
      - uses: Swatinem/rust-cache@<sha> # v2
      - run: npm ci
      - run: cargo fmt --all -- --check
      - run: cargo clippy --workspace --all-targets -- -D warnings
      - run: cargo test --workspace
      - run: npm run tauri build -- --debug --no-bundle
      - name: Smoke (launch, create window, exit; twice)
        shell: pwsh
        run: |
          $report = Join-Path $env:RUNNER_TEMP 'agentdock-smoke.json'
          $env:AGENTDOCK_SMOKE_REPORT = $report
          $p = Start-Process -FilePath target\debug\agentdock-desktop.exe -PassThru -Wait
          if ($p.ExitCode -ne 0) { throw "smoke exit code $($p.ExitCode)" }
          $r = Get-Content $report | ConvertFrom-Json
          if (-not $r.ok) { throw "smoke report not ok" }
          $p2 = Start-Process -FilePath target\debug\agentdock-desktop.exe -PassThru -Wait
          if ($p2.ExitCode -ne 0) { throw "second launch failed" }
  cargo-deny:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: EmbarkStudios/cargo-deny-action@<sha> # v2 (third-party action, needs audit)
        with: { command: check }
```

`deny.toml` essentials:

```toml
[graph]
all-features = false

[advisories]
version = 2
yanked = "deny"

[licenses]
version = 2
confidence-threshold = 0.93
# Allow-list pending owner confirmation (ADR-0002 §5: AgentDock's own license is undecided)
allow = ["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unicode-3.0", "Zlib"]

[licenses.private]
ignore = true   # workspace crates are publish = false / UNLICENSED

[bans]
multiple-versions = "warn"
wildcards = "deny"

[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
```

GPL/AGPL/LGPL/MPL are **not** allowed; CI fails and the owner decides on exceptions (never add them yourself).

`docs/dev/linux-vm-setup.md` must contain: the CONVENTIONS §1 prerequisites (with "ask the owner before installing system packages"), the baseline commands of CONVENTIONS §8, how to run the optional `xvfb-run` smoke, and how to read Windows CI results (`gh pr checks`, `gh run view --log-failed`).

`docs/dev/windows-setup.md` must contain:

1. Requirements: Windows 10/11, Visual Studio 2022 Build Tools (C++ workload), WebView2 Runtime, rustup (toolchain from `rust-toolchain.toml`), Node.js 22+, Git ≥ 2.36, optional GitHub CLI.
2. Commands: `npm ci`, `npm run tauri dev`, the CONVENTIONS §8 commands, the smoke command.
3. WSL: alpha runs the desktop app natively on Windows only; agents inside WSL are unsupported (ADR-0002 WT-11).
4. Troubleshooting: `link.exe` not found (missing C++ workload), WebView2 missing, wrong cargo version (`rustup show`), antivirus locking `target/`.
5. A statement that no system settings beyond installing these tools need to change.

## 5. Implementation steps

1. Check that the GitHub credentials can push workflow files (needs the `workflow` scope; PRs #24 and #27 recorded tokens without it). If not, stop and report; do not switch accounts or tokens.
2. Create the files per §4; resolve each action tag to a SHA.
3. Run `cargo deny check` locally only if `cargo-deny` is installed or the owner approves `cargo install cargo-deny` (user-level, but still ask); otherwise rely on CI and say so in the PR.
4. Push and confirm all three new jobs appear in the PR checks and `frontend.yml`'s `check` still exists with the same name.
5. Link the CI run in the PR description.

## 6. Tests to write first

CI is the test. Also verify the failure cases once and record the results in the PR (do not leave breaking commits on the branch; revert with a new commit, never force push):

| Case | How | Expected |
| --- | --- | --- |
| fmt failure | temporary commit with broken indentation | `rust-linux` and `rust-windows` fail at fmt |
| smoke failure | temporarily write `ok:false` in the smoke report | the Smoke step fails |
| license violation | locally `cargo deny check licenses` with an empty `allow` | fails and lists licenses |

## 7. Acceptance commands and expected results

```bash
cargo deny check                                   # if cargo-deny is available: exit 0
gh pr checks <PR number> --repo ChiJiun/agentdock
# expected: check (frontend), rust-linux, rust-windows, cargo-deny all pass
```

Windows-only (CI): `rust-windows` must be green including both smoke launches; read failures with `gh run view <run id> --repo ChiJiun/agentdock --log-failed`.

## 8. Spec references and porting sources

- Issue #4 Steps 3, 4, 6, 7; Issue #41 (aggregated required check, fail closed, `gh pr checks --watch`); Issue #55 comment 2026-11-22 (ruleset 27827462 requires the GitHub Actions `check`).
- ADR-0002 line 100 (`cargo deny`, `cargo audit`, dependency audit from M1; this repo uses npm, not pnpm), line 175 X-2 (Windows debug and release smoke).
- ADR-0004 decision 6 (Linux first, Windows-only verified by `windows-latest`).
- `docs/roadmap.md` lines 164–171 (CI items).
- Tauri 2 Linux prerequisites: https://v2.tauri.app/start/prerequisites/
- No porting source.

## 9. Dependencies

| Package / action | Version | Status |
| --- | --- | --- |
| `actions/checkout`, `actions/setup-node` | v4 (pin SHA) | already used in `frontend.yml` |
| `Swatinem/rust-cache` | v2 (pin SHA) | needs audit |
| `EmbarkStudios/cargo-deny-action` | v2 (pin SHA) | needs audit |
| `cargo-deny` (local tool) | latest | owner approval before installing |

## 10. Model tier

Standard model.

## 11. Common mistakes and pitfalls

- **Naming a new job `check`**: collides with the ruleset's required check. Use `rust-linux`, `rust-windows`, `cargo-deny`.
- **Adding `paths:` filters**: if the job becomes required later, docs-only PRs stay pending forever (#55). No path filters.
- Intermittent Windows `cargo test` failures from antivirus locking `target/`: do not hide them with retry loops; record and report.
- `Start-Process -Wait` on a GUI app: the smoke mode must exit by itself (P1-2's 20 s cap) or the job hangs.
- `rust-linux` needs `npm run build` before compiling `agentdock-desktop` because `tauri::generate_context!` embeds `../dist`.
- No `pull_request_target`, no `contents: write`.

## 12. Reviewer checklist

- [ ] Is `frontend.yml` untouched and no new job named `check`?
- [ ] Are all actions pinned to full SHAs, and permissions `contents: read`?
- [ ] Does `rust-windows` run the full `cargo test --workspace` (so `#[cfg(windows)]` tests execute) and both smoke launches?
- [ ] Does `rust-linux` build the whole workspace, including `agentdock-desktop`?
- [ ] Is the license allow-list free of copyleft licenses, with private crates ignored?
