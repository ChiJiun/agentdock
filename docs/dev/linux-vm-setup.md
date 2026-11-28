# Linux VM development setup

> **繁中摘要**：在 Linux VM（Ubuntu 24.04）開發 AgentDock 的環境需求、基本驗收指令、選用的 `xvfb-run` smoke，以及如何讀取 Windows CI 結果。安裝任何系統套件前一律先問擁有者。Windows 專屬行為（Job Object、`.cmd` shim、WebView2 等）在這裡驗證不了，要看 `rust-windows` job。

Source of truth: [`docs/tasks/CONVENTIONS.md`](../tasks/CONVENTIONS.md) §1 and §8. If this file and CONVENTIONS disagree, CONVENTIONS wins.

## 1. Prerequisites

**Ask the owner before installing any system package.** Proposed commands:

```bash
# Rust (user-level, no sudo). The exact toolchain comes from rust-toolchain.toml.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
# Node.js 22 LTS: use the distribution the owner prefers (nvm, fnm or NodeSource)
# Tauri 2 build dependencies on Ubuntu/Debian (needs sudo; ask first).
# Source: https://v2.tauri.app/start/prerequisites/ (re-check the list before installing)
sudo apt-get update && sudo apt-get install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev
# Git >= 2.36 and the GitHub CLI (gh) for P5/P7 packets
git --version; gh --version
```

Packets that only touch crates other than `agentdock-desktop` do not need the Tauri packages.

Optional tools (each needs owner approval before installing):

- `cargo-deny` (`cargo install cargo-deny`, user-level) to run `cargo deny check` locally. Without it, rely on the `cargo-deny` CI job.
- `xvfb` (system package) for the optional smoke run in section 3.

## 2. Baseline commands

Run from the repository root. `cargo` commands apply from P1-1 on.

```bash
npm ci
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck
npm test
npm run build
```

`agentdock-desktop` (P1-2) embeds `../dist` through `tauri::generate_context!`, so run `npm run build` before `cargo clippy` / `cargo test` once that crate exists.

## 3. Optional smoke run under `xvfb-run`

Only after P1-2 (`src-tauri/`) has merged and `xvfb` is installed:

```bash
npm run build
cargo build -p agentdock-desktop
AGENTDOCK_SMOKE_REPORT=/tmp/agentdock-smoke.json xvfb-run -a ./target/debug/agentdock-desktop; echo $?
cat /tmp/agentdock-smoke.json
```

Exit code `0` and a report with `"ok": true` is a pass. The authoritative smoke is the Windows one in CI (section 4).

## 4. Reading Windows CI results

Windows-only behaviour is verified by the `rust-windows` job (`windows-latest`) in `.github/workflows/rust.yml`, not on the Linux VM. A skipped or missing job is not a pass.

```bash
gh pr checks <PR number> --repo ChiJiun/agentdock          # job list and state
gh run view <run id> --repo ChiJiun/agentdock --log-failed  # failed step logs
```

Jobs to expect on a PR: `check` (frontend), `rust-linux`, `rust-windows`, `cargo-deny`. The Tauri debug build and the two-launch smoke step in `rust-windows` are added after P1-2 merges.
