---
name: release-version
description: >
  Use when cutting a new release of the delta desktop app fork — building
  macOS, Windows, and Linux artifacts locally (no CI) and publishing them
  (git tag, GitHub release with all platforms, updater manifest). Triggers:
  "release a patch/minor/major version", "publish a new version", "cut a
  release", "ship vX.Y.Z".
license: MIT
---

# Release a new version

Two scripts do everything. `scripts/build-release.sh` builds **all three
platforms locally** into `release/<version>/` and bumps `package.json`
(uncommitted). `scripts/publish-release.sh` commits the bump, tags, pushes,
creates the GitHub release on `snatvb/delta-review`, and attaches every
artifact plus a multi-platform `latest.json` for the in-app updater. Build
first, then publish.

## What gets built (no CI, all from this Mac)

| Platform | Artifact | How |
|---|---|---|
| macOS (aarch64) | `Delta_X.Y.Z_aarch64.dmg` + `Delta.app.tar.gz(.sig)` | native `tauri build` |
| Windows (x64) | `Delta_X.Y.Z_x64-setup.exe(.sig)` | cross-compiled via `mingw-w64` (`x86_64-pc-windows-gnu`) |
| Windows (x64) | `Delta_X.Y.Z_x64.msi` | hand-authored WiX file built with `wixl` in the `delta-review-msi-builder` Debian container (tauri-bundler makes MSIs only on Windows) |
| Linux (x86_64) | `Delta_X.Y.Z_amd64.deb` + `Delta_X.Y.Z_amd64.AppImage(.sig)` | Docker `ubuntu:22.04` amd64, emulated |

Builds are **unsigned** (no Apple certificates); the release notes tell users
how to open them anyway. Updater artifacts are signed with the fork key at
`~/.tauri/delta-review-updater.key` (lose it and auto-updates break).

## Preconditions

- **Main worktree, on `main`, clean**: `git checkout main && git pull --ff-only`.
  Uncommitted changes other than the version bump make `publish-release.sh` refuse.
- **Docker Desktop running with Rosetta on** (Settings → General → "Use Rosetta
  for x86_64/amd64 emulation"). Without it the Linux build dies: Node asserts
  under QEMU, and AppImage tools fail with `Exec format error`.
- On PATH: `cargo`, `pnpm`, `node`, `gh`, `shasum`, `x86_64-w64-mingw32-gcc`
  (brew `mingw-w64`), `makensis` (brew `makensis`).
- First run bakes the `delta-review-linux-builder` Docker image (~10 min);
  later runs reuse it and the named cargo/node volumes.

## Procedure

Each platform's build is long (Rust release compiles; Linux under emulation);
**run in the background** and read the log when done. Re-run per platform with
`--only mac|windows|linux` — completed platforms don't need rebuilding.

**1. Build** — pick one bump: `--patch` | `--minor` | `--major` | `--version X.Y.Z`

```bash
scripts/build-release.sh --minor            # or --version X.Y.Z
scripts/build-release.sh --only linux --skip-checks   # retry just one platform
```

Runs `tsc --noEmit`, `pnpm test`, `cargo test`, bumps `package.json`, builds
all platforms into `release/<version>/`, and writes `SHA256SUMS.txt`. The bump
stays **uncommitted** so artifacts can be tested first; a failed run reverts it.
On failure mid-way, fix and re-run — cargo caches make retries cheap.

**2. Publish**

```bash
scripts/publish-release.sh
```

Commits the bump as `chore(release): vX.Y.Z` (everything else must already be
committed), tags `vX.Y.Z`, pushes `HEAD` + tag to `origin`, and creates the
release with all artifacts, `SHA256SUMS.txt`, and `latest.json` assembled from
the `.sig` files. Release notes come from the `## X.Y.Z` section of
`CHANGELOG.md` — write that section **before** publishing.

## Verify when done

```bash
git status --porcelain && git log --oneline -1 && \
gh release view vX.Y.Z --repo snatvb/delta-review --json tagName,url,assets \
  --jq '{tag:.tagName, url:.url, assets:[.assets[].name]}'
```

Expect a clean tree and the release to carry: the DMG, `Delta.app.tar.gz` +
`.sig`, the Windows setup + `.sig` and the `.msi`, the `.deb`, the `.AppImage`
+ `.sig`, `SHA256SUMS.txt`, and `latest.json`.

## Common mistakes

| Mistake | Consequence / fix |
|---|---|
| Docker Rosetta off | Linux build: libuv assert / `Exec format error` in AppImage tools. Enable Rosetta, restart Docker. |
| Forgetting the CHANGELOG section | Release notes come up empty. Add `## X.Y.Z` first. |
| Editing files other than `package.json` before publish | `publish-release.sh` refuses ("only package.json may be changed"). Commit the rest first. |
| Foreground run hits the tool timeout | Builds can exceed 10 min. Run in the background and read the log. |
| Re-running publish after a mid-publish failure | The tag guard blocks it. Inspect/delete the partial tag before retrying. |
| Losing `~/.tauri/delta-review-updater.key` | Future releases can't sign updates; auto-update breaks. Back it up. |
