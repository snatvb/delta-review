# Changelog

## 0.21.0 — 2026-10-02

### 🚀 New Features

- **Base-branch picker** — choose what a review diffs against. Every local and remote branch is listed with ahead/behind counts against HEAD, tip subject and recency, and the fork-point suggestion stays pinned at the top when detection has an answer. The choice becomes a repo-wide strategy (all worktrees), persisted in the registry: `auto` keeps fork-point detection, `branch` always compares against the picked branch.
- **Backend-owned self-updater** — the update check and download now live in the backend, so a download keeps transferring no matter which window closes, and every window sees the same live state. Settings gains an auto-download preference, and the About page shows update status. The automatic check runs at most once per app run; manual checks re-run freely.

### 🔧 Changes

- **Unviewed-only +/− totals** — the file panel header's counter can count only files not yet marked viewed (Settings → General → "Unviewed-only totals", off by default). Clicking the counter toggles the mode; a tooltip names what was excluded.
- **Folder +/− rollups** — folders sum the +/− of their reviewable descendants, with exact numbers in the tooltip; viewed files are skipped in unviewed-only mode.
- **Compacted counts** — counts ≥10,000 render as "17k" everywhere (header, rows, folders), with full precision kept in tooltips; the header no longer overflows on narrow panels.
- The Rust toolchain is fully green: `cargo clippy --all-targets` at zero warnings and the whole `src-tauri` crate rustfmt-formatted — both are gates from here on.

### 🐛 Fixes

- Folders lost their checkbox and +/− rollup entirely when ignored files shared their path — the Ignored group's replay of folder paths overwrote the real subtree aggregates.

## 0.20.0 — 2026-10-01

### 🚀 New Features

- **Full-window image lightbox** — click an image preview (or its expand button) in a binary compare to open a full-window viewer with no second fetch: cursor-anchored wheel/pinch zoom, fit/100% on double click, drag pan, `+`/`-`/`0`/`1` keys, Esc/back/stage-click to close. Two-sided changes get compare modes — 2-up on a shared scale, swipe divider, onion-skin opacity, pixel-difference blend — plus checker/dark/light backdrops and captions with natural dimensions and byte sizes.

### 🔧 Changes

- **The app is now "Delta Review"** — the spaced name shows everywhere the user looks: the macOS bundle name (menu bar, About, ⌘-Tab), window titles, the launcher wordmark, the Settings About page, and the Windows installer strings; DMG/installer artifacts are named accordingly. Identifiers are deliberately unchanged (bundle id `com.snatvb.delta-review`, the `DeltaReview` binary, the `dr` CLI), so settings, reviews, and recents carry over as-is.
- **Moving from ≤0.19.0:** the in-app updater replaces the app in place, so an updated install keeps its old `delta-review.app` folder name while working identically — install fresh from the DMG for the new name in Finder, and re-point the `dr` symlink if you installed the CLI (its path changed with the bundle).
- Release plumbing survives spaces in artifact names: updater URLs in `latest.json` percent-encode them, and the build's artifact collector no longer word-splits glob patterns.

### 🐛 Fixes

- **Traffic lights sit where they were configured** — the macOS window buttons were silently reset to system defaults by the first AppKit titlebar relayout, leaving them visibly off-center above the toolbar. Every window now re-applies the inset itself: the 14pt buttons center exactly in the 48px toolbar, and the close button's left edge aligns with the file-tree content inset, surviving resizes and fullscreen.

## 0.19.0 — 2026-09-30

### 🚀 New Features

- **SVN repositories (v1: uncommitted reviews)** — open an SVN checkout and review uncommitted changes, fully offline: change lists, old sides from BASE, deleted directories expanded, binary BASE sides pinned into served snapshots. Requires the `svn` CLI — when the app can't find it, the error lists every PATH entry scanned plus the Homebrew/MacPorts defaults. Detection prefers `.git` (git-svn checkouts open as git); rules and v1 limits in [docs/svn.md](docs/svn.md).
- **Folder-level "viewed" checkboxes** — every folder row carries the standard tri-state checkbox: all/some/none viewed at a glance, and one click marks or clears the whole subtree.
- **Delta Ignore grows two layers** — a global ruleset that applies to every repository (the home for common offenders like codegen output) and per-checkout local rules in `.git/info/deltaignore` (git's `info/exclude` slot), on top of project `.deltaignore`. A bad line is now skipped instead of disabling every rule.

### 🔧 Changes

- **Settings is now a wide sidebar dialog** — near-full-width, with sections: General, Appearance (theme, code fonts), Delta Ignore, and a new About page (version, repo links, credits). The chosen section persists across opens, and the app version is injected at build time.
- The terminal CLI is now **`dr`** (short for delta-review; `dr-dev` for the debug build); installing from the app also removes a legacy `delta-review` shim symlink when it pointed at this app.
- **Analytics are dormant** — nothing is collected or sent, and the Settings toggle is gone. The pipeline stays in the tree behind a fork-owned build-time key so it can be revived later.
- Attribution: Andrei Avsenin is credited as fork co-author alongside upstream author Dario Ielardi (LICENSE, README).

### 🐛 Fixes

- **Image previews no longer queue behind the diff cache lock** — the first request after a watcher invalidate rebuilt the whole-repo snapshot while holding one global mutex (~2s on a 2540-file repo vs ~1.2ms hot). Snapshots now build off-lock, and an unchanged image keeps its URL across refreshes so it stays cached.
- **Windows MSI repaired** — 0.18.0 aborted the install with `Could not open key: UNKNOWN\Software\delta-review` (wixl passed WiX's HKMU through as an invalid registry hive; HKLM is correct for a per-machine install). Its shortcut also still pointed at the pre-rename `Delta.exe`.
- **Linux: the CLI works end-to-end** — a cold start used to fail with `could not launch delta-review` (it shelled out to the macOS-only `open -b`); it now relaunches the app binary detached, AppImages included. The socket moved to the XDG data dir, and a second GUI instance no longer steals the first one's socket.

## 0.18.0 — 2026-09-30

The fork gets its own identity: the app is now **delta-review** (identifier `com.snatvb.delta-review`, binary `DeltaReview`, CLI command `delta-review`). Up to and including 0.17.0 it still carried the upstream name and bundle ID (`Delta` / `com.darioielardi.delta`).

**Moving from 0.17.0:** your data (reviews, recents, settings, window state) migrates automatically on first launch — the old directory is copied, not moved, so rolling back stays possible. Install this release fresh from the DMG/installer and remove the old `Delta` app; don't rely on the in-app updater across the rename (a differently-named bundle replaces the old one). The CLI command is now `delta-review` — reinstall the shim from the app and remove the old `delta` symlink if you had one. The updater, its signatures, and the release feed are unchanged.

### 🚀 New Features

- **Copy a comment for an agent** — location (`path:line-range`), anchored snippet, and body, no headers — from the inline thread and the comments panel.
- Files: file-type icons; status moves to letters in the counts cluster.

## 0.17.0 — 2026-09-30

First release from the [snatvb/delta-review](https://github.com/snatvb/delta-review) fork. Packages are built locally, without CI: an **unsigned** macOS DMG (Apple silicon), **Windows x64** NSIS and MSI installers, and **Linux x86_64** `.deb` / `.AppImage` packages. The in-app updater now tracks this fork's releases.

Installing unsigned builds: on **macOS** right-click the app and choose *Open* the first time; on **Windows** pass SmartScreen via *More info → Run anyway*; on **Linux** install the `.deb` (`sudo apt install ./Delta_0.17.0_amd64.deb`) or `chmod +x` the `.AppImage` and run it.

### 🚀 New Features

- **Windows support**: the app builds and runs on Windows, opens review windows without deadlocking, and shows correct shortcut-modifier glyphs.
- Inline editing: edit a single line inline or the whole file in an overlay editor.
- Review flow: opening a review on the uncommitted changes is now the default, with progress feedback while a diff-mode switch computes.
- Picker: delete a recent review straight from its row; a repository that can't be opened now says why.
- Settings: toggle change detection (auto-refresh) and per-branch review windows; added an update-check toggle and a clearer per-branch setting description.
- `.deltaignore`: exclude generated files from reviews (like `.gitignore` syntax).
- Reviews: comments left on working-tree files are handed off to the commits that land those files.
- Diff: syntax highlighting for **GDScript** and **RON**; GDScript call sites are colored like Rust's invoke rule.
- Diff: render binary files with sizes and GitHub-style image compares; image previews stream over a URI scheme instead of base64 and are capped at 16 MiB.
- Diff: the `+` button now supports drag ranges, and a line never gets duplicate comments; selected text highlights its same-file occurrences.

### 🔧 Changes

- Diff: binaries and giant diffs are ordered after readable files.
- Workspace: a manual refresh is always offered, and the Refresh spinner spins through the whole reload.
- Performance: much faster review open on large repos; files of 2 MB or more are hidden.
- Performance: the commit list is paged instead of loading the whole branch.
- Performance: image previews load only near the viewport.

### 🐛 Fixes

- CRLF working-tree normalization and untracked-file line counts (Windows).
- Viewed marks are baselined against the snapshot the user actually saw.
- Acting on comments from the index works again; stale threads stay read-only.
- Binary cards are served from the cached snapshot.
- The window header is inset for traffic lights only on macOS.
- UI: wheel scroll no longer sticks on clipped elements; controls show a pointer cursor and visible hover/press states.
- Theme: dark-mode strings have their own color; the `propertyName` token is themed so RON files read as highlighted; loading spinners keep running under `prefers-reduced-motion`.

## 0.16.6 and earlier

See the [upstream releases](https://github.com/darioielardi/delta/releases) of [darioielardi/delta](https://github.com/darioielardi/delta).
