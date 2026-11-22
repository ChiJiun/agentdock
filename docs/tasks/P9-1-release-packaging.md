# P9-1: v0.1.0-alpha release packaging (Windows NSIS installer, checksums, draft release, release notes, known limits)

> **繁中摘要**：新增只在推送 `v*-alpha.*` tag 時執行的 release workflow：在 `windows-latest` 以 Tauri 產生 NSIS 安裝檔（MSI 不接受 `-alpha` 版本號，所以不用）、安裝後跑 smoke、移除、計算 SHA-256，建立**草稿** GitHub Release 附上安裝檔與 checksum，由擁有者檢查後自行發布。另外寫 release notes 範本與「已知限制」文件（未簽章會出現 SmartScreen 警告、alpha 不做 merge／遠端執行等）。版本號在 `package.json`、`src-tauri/Cargo.toml`、`tauri.conf.json` 三處一致並有測試檢查。模型等級：一般模型可。

Issues: #51, #41, #55 | Gate (#51): G1 (installable, reproducible build), G9 (traceable commit, release notes, known limits, installer checksum) | Model tier: **standard model**

## 1. Goal and non-goals

Goals:

- `.github/workflows/release.yml`, triggered only by pushing a tag matching `v[0-9]+.[0-9]+.[0-9]+-alpha.[0-9]+` (and `workflow_dispatch` for a dry run that uploads an artifact instead of creating a release).
- Build on `windows-latest`: `npm ci`, pinned Rust toolchain (P1-1), `npm run tauri build -- --bundles nsis`. Output: `AgentDock_<version>_x64-setup.exe`.
- **Installer smoke**: silent install (`/S`) into a temp directory (NSIS `/D=`), run the installed exe with `AGENTDOCK_SMOKE_REPORT` (P1-2 smoke mode), require `ok: true`, then run the uninstaller silently and confirm the install directory is gone.
- `SHA256SUMS.txt` (`sha256  filename`, lowercase hex) for the installer.
- Create a **draft** GitHub Release for the tag with the installer, `SHA256SUMS.txt`, and the notes from `docs/release/v0.1.0-alpha.md`. The owner reviews and publishes; the workflow never publishes and never marks "latest".
- Version consistency: `package.json` `version`, `src-tauri/Cargo.toml` `package.version`, `src-tauri/tauri.conf.json` `version` and the tag must be equal; a script checks it in CI before building.
- `docs/release/v0.1.0-alpha.md`: release notes template (commit SHA, what works, known limits, checksums placeholder, how to verify the checksum, how to uninstall, where data lives).
- `docs/release/known-limitations.md`: the alpha's honest limits (see §5 step 6).

Non-goals: code signing (no certificate; listed as an owner decision), auto-update, MSI, macOS/Linux bundles, publishing to winget/Scoop, bundling Node.js or any agent adapter (ADR-0002 decision 4), changing branch protection or required checks (#55).

## 2. Prerequisites and parallel work

- Prerequisites: P1-2 (smoke mode), P1-3 (Rust CI patterns, pinned action SHAs), P3-7 (app data location to document). Ideally after P8-* so the release contains the workflow; the workflow itself can land earlier.
- Parallel: P9-2.

## 3. Files

New:

- `.github/workflows/release.yml`
- `scripts/check-version.mjs` (Node, dev tooling only; reads the three files and an optional tag argument)
- `scripts/check-version.test.mjs` (run by `node --test`)
- `docs/release/v0.1.0-alpha.md`
- `docs/release/known-limitations.md`
- `docs/dev/release-process.md` (owner steps: bump version, tag, check the draft, verify checksum, publish)

Modified: `src-tauri/tauri.conf.json` (`bundle.targets: ["nsis"]`, NSIS `installMode: "currentUser"`, WebView2 `downloadBootstrapper`), `package.json` (`"test:scripts": "node --test scripts/"`).

## 4. Configuration (replaces "types and signatures")

```yaml
# .github/workflows/release.yml (shape; pin every action to a full commit SHA with the tag in a comment, as in P1-3)
name: Release
on:
  push:
    tags: ['v[0-9]+.[0-9]+.[0-9]+-alpha.[0-9]+']
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  build-windows:
    runs-on: windows-latest
    timeout-minutes: 60
    steps:
      - checkout (fetch-depth: 0)
      - setup-node 22 with npm cache; npm ci
      - rust toolchain from rust-toolchain.toml
      - node scripts/check-version.mjs "${{ github.ref_name }}"   # skipped on workflow_dispatch
      - npm run tauri build -- --bundles nsis
      - installer smoke (pwsh): install /S /D=<temp>, run with AGENTDOCK_SMOKE_REPORT, assert ok, uninstall /S, assert dir removed
      - compute SHA256SUMS.txt (Get-FileHash -Algorithm SHA256, lowercase)
      - upload-artifact: installer + SHA256SUMS.txt (retention 14 days)
  draft-release:
    if: startsWith(github.ref, 'refs/tags/')
    needs: build-windows
    runs-on: ubuntu-latest
    permissions:
      contents: write          # only this job
    steps:
      - download-artifact
      - gh release create "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --draft --prerelease --verify-tag
          --title "AgentDock $GITHUB_REF_NAME" --notes-file docs/release/v0.1.0-alpha.md <files>
        (env GH_TOKEN: ${{ github.token }})
```

```js
// scripts/check-version.mjs
// Usage: node scripts/check-version.mjs [tag]
// Exit 0 when package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json agree (and equal tag without the leading "v");
// otherwise print which file differs and exit 1. No dependencies beyond node:fs/node:path.
export function readVersions(rootDir) /* -> { packageJson, cargoToml, tauriConf } */;
export function checkVersions(versions, tag /* optional */) /* -> { ok: boolean, problems: string[] } */;
```

## 5. Implementation steps

1. Write `check-version.test.mjs` first (§6), then the script. Parse `Cargo.toml` with a small regex limited to the `[package]` table (no TOML dependency).
2. Set the version to `0.1.0-alpha.1` in the three files only when the owner decides to cut the release; this packet's PR keeps `0.1.0` and the tests use fixtures.
3. `tauri.conf.json`: NSIS only; `installMode: "currentUser"` (no admin prompt); WebView2 `downloadBootstrapper` (the installer fetches WebView2 if missing; document that offline machines need the runtime preinstalled). Verify the keys against the current Tauri 2 docs (https://v2.tauri.app/distribute/windows-installer/) before editing.
4. Workflow per §4. The smoke step reuses P1-3's report check. Never print secrets; the only token is `github.token` in the release job.
5. `docs/release/v0.1.0-alpha.md` template sections: Summary · Built from commit `<sha>` (tag) · What works (link to #51 gates with their status) · Requirements (Windows 10/11 x64, WebView2, Git ≥ 2.36, GitHub CLI for PR features, Node 22 for `claude-agent-acp`, Codex CLI for `codex-acp`) · Install / uninstall · Data location (`%APPDATA%\<identifier>`; uninstall keeps it; how to delete it) · Verify the checksum (`Get-FileHash .\AgentDock_*_x64-setup.exe -Algorithm SHA256`) · Known limitations (link) · Reporting issues.
6. `docs/release/known-limitations.md` must state at least: unsigned installer (SmartScreen "Windows protected your PC" → "More info" → "Run anyway"); no merge, no force push, no branch/worktree deletion from the app; no remote execution, no CI cache, not a fully autonomous agent (#51 wording); agent bypass/full-access modes are not policy-enforced and the "Policy not enforced" indicator is not implemented yet (#26); no reattach of external sessions; checks run only user-configured commands; repositories without CI cannot complete through the PR path; no subscription quota display by design; WSL agents unsupported (WT-11).
7. `docs/dev/release-process.md`: owner-only steps (bump, PR, merge, `git tag -a v0.1.0-alpha.1 <sha>`, push tag, wait for the draft, download and verify checksum, install on a clean user account, publish). Pushing tags and publishing are owner actions.

## 6. Tests to write first

`scripts/check-version.test.mjs` (`node --test`, temp directories with fixture files):

| Test | Expected |
| --- | --- |
| `all_equal_ok` | three files `0.1.0-alpha.1`, tag `v0.1.0-alpha.1` → ok |
| `tag_mismatch` | tag `v0.1.0-alpha.2` → problem names the tag |
| `cargo_differs` | Cargo `0.1.0` → problem names `src-tauri/Cargo.toml` |
| `workspace_version_ignored` | a `[workspace.package] version` elsewhere does not confuse the `[package]` parse |
| `missing_file` | no `tauri.conf.json` → not ok, clear message |
| `no_tag_argument` | files equal, no tag → ok |

Workflow checks (run on the PR without creating a release):

- `actionlint` is not required; instead the PR runs `workflow_dispatch` on the branch (owner triggers it, or the implementer if allowed) and links the run: the artifact contains the installer and `SHA256SUMS.txt`, and the smoke step passed.

## 7. Acceptance commands and expected results

```bash
node --test scripts/                       # 6 pass
node scripts/check-version.mjs             # exit 0 on the current tree
npm run typecheck && npm test && npm run build
```

Windows-only (CI): a `workflow_dispatch` run of `Release` on the PR branch is green and its artifact has `AgentDock_<version>_x64-setup.exe` and `SHA256SUMS.txt` whose hash matches the file. Read it with:

```bash
gh run list --repo ChiJiun/agentdock --workflow Release --branch <branch> --limit 1
gh run view <run id> --repo ChiJiun/agentdock
gh run download <run id> --repo ChiJiun/agentdock -D /tmp/agentdock-release && (cd /tmp/agentdock-release/* && sha256sum -c SHA256SUMS.txt)
```

## 8. Spec references and porting sources

- Issue #51 Release Gate items 1 (installable, start/close/reopen, reproducible build, smoke CI) and 9 (traceable commit, release notes, known limits, installer checksum; no claims of remote execution, CI cache or full autonomy).
- ADR-0002 line 175 X-2 (Windows debug and release smoke), line 100 (dependency audit from M1).
- ADR-0002 decision 4 (adapters are installed by the user, not bundled).
- `docs/tasks/P1-2-tauri-shell-ipc.md` (smoke mode and report file), `docs/tasks/P1-3-windows-ci.md` (pinned actions, smoke step).
- Tauri 2 Windows installer documentation: https://v2.tauri.app/distribute/windows-installer/ (NSIS options, WebView2 install modes; MSI/WiX requires a numeric-only pre-release version, which is why NSIS is used).
- No porting source.

## 9. Dependencies

None new (Node standard library only for the script).

## 10. Model tier

Standard model.

## 11. Common mistakes and pitfalls

- Giving the whole workflow `contents: write`: only the draft-release job needs it.
- Publishing the release automatically: the owner publishes after checking the draft.
- Using MSI with a `-alpha.1` version: WiX rejects non-numeric pre-release identifiers.
- Running the smoke test on the build output instead of the installed app: installation problems (missing WebView2, wrong paths) only show up after install.
- Claiming reproducible builds bit-for-bit: Tauri/NSIS outputs are not byte-reproducible; the claim is "rebuildable from the tagged commit with pinned toolchain and lockfiles".
- Bundling `claude-agent-acp` or Node: not allowed (ADR-0002 decision 4).
- Forgetting that uninstall keeps `%APPDATA%` data: document it.

## 12. Reviewer checklist

- [ ] Is the workflow triggered only by alpha tags and manual dispatch, with `contents: write` limited to the release job?
- [ ] Are all third-party actions pinned to full commit SHAs?
- [ ] Does the smoke run against the installed app and verify uninstall?
- [ ] Is the release created as a draft pre-release only?
- [ ] Does `known-limitations.md` cover every limit listed in §5 step 6 without overstating features?
- [ ] Does `check-version.mjs` fail on any mismatch, including the tag?
