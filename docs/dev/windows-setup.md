# Windows development setup

> **繁中摘要**：在 Windows 10/11 原生開發 AgentDock 的需求（VS 2022 Build Tools C++、WebView2、rustup、Node.js 22+、Git ≥ 2.36）、常用指令、WSL 的限制，以及常見問題排除。除了安裝這些工具，不需要變更任何系統設定。

Source of truth: [`docs/tasks/CONVENTIONS.md`](../tasks/CONVENTIONS.md) §7 and §8.

## 1. Requirements

- Windows 10 or 11.
- Visual Studio 2022 Build Tools with the **Desktop development with C++** workload (provides the MSVC linker `link.exe` and the Windows SDK).
- WebView2 Runtime (preinstalled on Windows 11; on Windows 10 install the Evergreen runtime from Microsoft).
- [rustup](https://rustup.rs/). The exact toolchain is pinned in `rust-toolchain.toml` (the MSVC target is the default on Windows); `rustup show` inside the repository installs and prints it.
- Node.js 22 or newer.
- Git 2.36 or newer.
- Optional: GitHub CLI (`gh`) for reading CI results.

No system setting other than installing these tools needs to change (no registry edits, no execution-policy changes, no Developer Mode requirement for the baseline commands).

## 2. Commands

Run from the repository root in PowerShell.

```powershell
npm ci
npm run tauri dev        # available after P1-2 (src-tauri/) has merged
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck
npm test
npm run build
```

`agentdock-desktop` (P1-2) embeds `../dist`, so run `npm run build` before `cargo clippy` / `cargo test` once that crate exists.

Smoke run (after P1-2 and a debug build of `agentdock-desktop`); the app writes a JSON report and exits by itself:

```powershell
$env:AGENTDOCK_SMOKE_REPORT = "$env:TEMP\agentdock-smoke.json"
.\target\debug\agentdock-desktop.exe
$LASTEXITCODE
Get-Content $env:AGENTDOCK_SMOKE_REPORT
```

Exit code `0` and `"ok": true` in the report is a pass. Run it twice (start, close, reopen) as CI does.

## 3. WSL

Alpha runs the desktop app natively on Windows only. Running agents inside WSL is unsupported (ADR-0002 WT-11: path isolation between Windows and WSL forms is not verified).

## 4. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `linker 'link.exe' not found` | The C++ workload of Visual Studio 2022 Build Tools is missing. Install **Desktop development with C++**, then reopen the terminal. |
| The app window does not open or WebView2 errors | WebView2 Runtime is missing. Install the Evergreen runtime. |
| Unexpected compiler errors or "toolchain not installed" | Wrong cargo version. Run `rustup show` in the repository root and check it matches `rust-toolchain.toml`. |
| `cargo test` or the build fails with "Access is denied" / file in use under `target/` | Antivirus or the indexer is locking `target/`. Exclude the repository's `target/` folder in your antivirus, or rerun. Do not hide intermittent failures with retry loops; record and report them. |
