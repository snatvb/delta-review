# Changelog

## 0.21.0 — 2026-10-02

**Choose what a review diffs against.** A review window opened without an explicit base used to fall back to fork-point detection with no say in the matter. The new base picker lists every branch — local and remote — with ahead/behind counts against HEAD, tip subject and recency, so "what would I review if I based on this" reads off the row; the fork-point suggestion is pinned at the top when detection has an answer. Picking a branch sets a repo-wide strategy (all worktrees) persisted in the registry: `auto` keeps fork-point detection, `branch` always compares against the chosen branch. The strategy is applied at every entry point — `compute_diff`, open/refresh review, the commits list — so nothing reads a base the picker didn't choose. `dev:mock` fixtures cover the picker for browser development.

**Self-updates that survive the launcher closing.** The update check and download now live in the backend (`updater.rs`) instead of the window that happened to win the old leader-election gate: a download keeps transferring no matter which window closes, and every window sees the same state through `updater:state` events (`updater_status` / `updater_check` / `updater_download` replace `updater_try_acquire`). Settings gains an auto-download preference, and the About page shows live update state. The mount-time automatic check runs at most once per process; manual checks (the Settings button, the periodic timer) re-run freely.

**Unviewed-only +/− totals, folder rollups, compacted counts.** The file panel header's +/− counter can now count only files not yet marked viewed (Settings → General → "Unviewed-only totals", off by default) — files stay listed and per-file numbers are untouched, only the top-line sum shrinks, with a tooltip naming what was excluded. The counter itself is the toggle: clicking it switches modes (same pref as Settings), and a badge marks unviewed-only counting. Folders roll up the +/− of their reviewable descendants — exact numbers in the tooltip, viewed files skipped in unviewed-only mode, same reading as the header; the rollup rides the existing dirViewed tree walk and costs nothing. Counts ≥10,000 compact to "17k" everywhere (header, rows, folders) with full precision kept in tooltips, the viewed chip truncates first, and the header no longer overflows on narrow panels. Also fixed: folders were losing their checkbox and rollup entirely when ignored files shared their path — the Ignored group's replay of folder paths overwrote the real subtree aggregates in the rollup map.

**The Rust toolchain is now fully green.** `cargo clippy --all-targets` sits at zero warnings and the whole `src-tauri` crate is rustfmt-formatted, so both work as gates from here on. One clippy suggestion was deliberately not taken verbatim: the PATH-block `fold` → `.any()` rewrite would have short-circuited past rc files after the first hit, so it became an explicit loop instead.

## 0.20.0 — 2026-10-01

**The app is now "Delta Review".** The spaced name shows everywhere the user looks: the macOS bundle name (menu bar, About, ⌘-Tab), window titles, the launcher wordmark, the Settings About page, and the Windows installer strings; DMG/installer artifacts are named accordingly. Identifiers are deliberately unchanged — bundle id `com.snatvb.delta-review`, the `DeltaReview` binary, the `dr` CLI — so settings, reviews, and recents carry over as-is. Moving from ≤0.19.0: the in-app updater replaces the app in place, so an updated install keeps its old `delta-review.app` folder name while working identically; install fresh from the DMG if you want the new name in Finder, and re-point the `dr` symlink if you installed the CLI (it lives inside the app bundle, whose path changed). Release plumbing now survives spaces in artifact names — updater URLs in `latest.json` percent-encode them, and the build's artifact collector no longer word-splits glob patterns.

**Traffic lights finally sit where they were configured.** The overlay-titlebar buttons always looked off-center because the builder-time `traffic_light_position` was silently undone by the first AppKit titlebar relayout (window creation, window-state restore, `show()`), and wry only re-applies it on webview redraws — which a fully-covered webview never triggers; the buttons sat at system defaults, visibly above the toolbar's center. Every window now re-applies the inset itself (at creation plus a hidden size wiggle, and on every later resize/move/focus). The close button's left edge aligns with the file-tree content inset — flush with the search box and the viewed counter — and the 14pt macOS 26 buttons center exactly in the 48px toolbar, surviving resizes and fullscreen. A debug-only `GET /lights` endpoint on the devbridge reports the buttons' real AppKit frames, the calibration tool for future macOS metric changes.

**Full-window image lightbox for binary compares.** Image cards render at a fixed 340px, too small to judge a visual change; clicking a preview (or its expand button) now opens a full-window viewer that reuses the card's cached blob URLs — no second IPC fetch. Wheel/pinch zoom anchored at the cursor, fit/100% on double click, drag pan with clamping, `+`/`-`/`0`/`1` keys, Esc/back/stage-click close. Two-sided changes get compare modes: 2-up on a shared scale, a swipe divider (`[`/`]` nudge), onion-skin opacity, and pixel-difference blend; checker/dark/light backdrops for transparent images, and footer captions with natural dimensions and byte sizes. The overlay headers (lightbox and file editor) pad past the traffic lights so Back stays clickable.

## 0.19.0 — 2026-09-30

**SVN repositories are here (v1: uncommitted reviews).** A VCS abstraction layer now answers "which VCS is this directory" in one place, probing `.git` before `.svn` on the ancestor walk — git-svn working copies (both markers) open as git, the nearest marker wins, and an SVN checkout inside a git monorepo stays SVN; a hidden per-repo override covers rare misdetections. SVN support in this first version is the Uncommitted view only, fully offline: change lists via `svn status --xml` (`svn:ignore` honored for free), old sides via `svn cat -r BASE`, deleted directories expanded through `svn info`, replaced files reviewed as added (no pristine until commit), and binary BASE sides pinned into served snapshots — SVN's BASE moves on commit/update, unlike git blobs. Requires the `svn` CLI; when a GUI-launched app can't find it, the error now lists every PATH entry scanned plus the Homebrew/MacPorts defaults, so "works in my terminal" reports are one-glance answers. Detection rules and v1 limits: [docs/svn.md](docs/svn.md).

**Folder-level "viewed" checkboxes in the file tree.** Every folder row now carries the standard tri-state checkbox: filled check when all files beneath it (nested folders included) are viewed, a dash when only some are, empty when none are. Clicking an empty checkbox marks every file in the subtree viewed in one update; clicking a check or dash clears them all. Folders with nothing to mark (the Ignored group) show no checkbox, and the list view is unaffected.

**Settings grows into a wide sidebar dialog.** The 512px modal is now near-full-width (min(90vw, 1280px) × 85vh) with a platform-settings-style section sidebar: General (windows/editor/detection/updates), Appearance (theme, code fonts), Delta Ignore (roomy rule editors that load on tab open, not dialog open), and a new About page (version, repo links, credits). The chosen section persists across opens, and the app version is injected at build time from package.json — no more manual propagation.

**Image previews no longer queue behind the diff cache lock.** Every image request funneled through one global mutex, and the first request after a watcher invalidate rebuilt the whole-repo snapshot while holding that lock — on a 2540-file repo with 40 1MB images, ~2s per round against 1.2ms hot (~1450×). Snapshots now build off-lock (concurrent first-fetches join one build), byte sources are read from the last served snapshot (old side by immutable blob OID, new side live from the worktree), and an unchanged image keeps its URL across refresh cycles so it stays in the webview cache instead of re-fetching and re-decoding.

**Windows MSI repaired.** The 0.18.0 MSI aborted the install with `Could not open key: UNKNOWN\Software\delta-review` — wixl passes WiX's HKMU through as an invalid registry hive, and HKLM is the correct root for a per-machine install. Its shortcut also still pointed at the pre-rename `Delta.exe`.

The terminal CLI is now **`dr`** (short for delta-review; `dr-dev` for the debug build). Installing from the app also removes a legacy `delta-review` shim symlink when it points at this app, so the old long-form command doesn't linger. `dr --help` and `--version` print the new name.

**Linux: the CLI now works end-to-end.** A cold start (app not running) used to fail with `could not launch delta-review` because it shelled out to the macOS-only `open -b`; it now re-execs the app binary detached (own process group, null stdio), preferring `$APPIMAGE` so AppImages relaunch correctly. Warm forwarding over the unix socket was already POSIX-fine; the socket now lives at `~/.local/share/<identifier>/cli.sock` (XDG, next to the app's data dir) instead of a `Library/Application Support` path, and a second GUI instance no longer steals the first one's socket. On macOS nothing changes (`open -b` cold start, same socket path).

In-app analytics are now **dormant**: nothing is collected or sent, the Settings toggle is gone, and the README no longer mentions telemetry. The whole pipeline (event taxonomy, gate, Aptabase plugin wiring) is kept in the tree, now keyed to a fork-owned `DELTA_REVIEW_TELEMETRY_KEY` build-time env var — upstream's `APTABASE_KEY` pathway is removed — so it can be revived later against an endpoint we own (checklist in `src/analytics.ts`). Attribution: Andrei Avsenin is credited as fork co-author alongside upstream author Dario Ielardi (LICENSE, README). Installs are now documented as releases-only (no Homebrew tap).

**Delta Ignore grows two more layers.** Settings now edits a **global** ruleset (app-data `deltaignore` file) that applies to every repository — the home for common offenders like codegen output — and each checkout gets **local** rules in `.git/info/deltaignore` (git's `info/exclude` slot): mute a huge vendored monorepo or local codegen without touching the project. Precedence: global < project `.deltaignore` < local, all gitignore syntax; a bad line is now skipped instead of disabling every rule. Saving from Settings invalidates diff snapshots and offers Refresh in open reviews, hand-edits to the local file are picked up by the watcher, and compiled rules are memoized per worktree (mtime-keyed), so the layered load costs three stat()s on the snapshot hot path.

## 0.18.0 — 2026-09-30

The fork gets its own identity: the app is now **delta-review** (identifier `com.snatvb.delta-review`, binary `DeltaReview`, CLI command `delta-review`). Up to and including 0.17.0 it still carried the upstream name and bundle ID (`Delta` / `com.darioielardi.delta`).

**Moving from 0.17.0:** your data (reviews, recents, settings, window state) migrates automatically on first launch — the old directory is copied, not moved, so rolling back stays possible. Install this release fresh from the DMG/installer and remove the old `Delta` app; don't rely on the in-app updater across the rename (a differently-named bundle replaces the old one). The CLI command is now `delta-review` — reinstall the shim from the app and remove the old `delta` symlink if you had one. The updater, its signatures, and the release feed are unchanged.

### Added

- Comments: copy a single comment for an agent — location (`path:line-range`), anchored snippet, and body, no headers — from the inline thread and the comments panel.
- Files: file-type icons; status moves to letters in the counts cluster.

## 0.17.0 — 2026-09-30

First release from the [snatvb/delta-review](https://github.com/snatvb/delta-review) fork. Packages are built locally, without CI: an **unsigned** macOS DMG (Apple silicon), **Windows x64** NSIS and MSI installers, and **Linux x86_64** `.deb` / `.AppImage` packages. The in-app updater now tracks this fork's releases.

Installing unsigned builds: on **macOS** right-click the app and choose *Open* the first time; on **Windows** pass SmartScreen via *More info → Run anyway*; on **Linux** install the `.deb` (`sudo apt install ./Delta_0.17.0_amd64.deb`) or `chmod +x` the `.AppImage` and run it.

### Added

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

### Changed

- Diff: binaries and giant diffs are ordered after readable files.
- Workspace: a manual refresh is always offered, and the Refresh spinner spins through the whole reload.

### Fixed

- CRLF working-tree normalization and untracked-file line counts (Windows).
- Viewed marks are baselined against the snapshot the user actually saw.
- Acting on comments from the index works again; stale threads stay read-only.
- Binary cards are served from the cached snapshot.
- The window header is inset for traffic lights only on macOS.
- UI: wheel scroll no longer sticks on clipped elements; controls show a pointer cursor and visible hover/press states.
- Theme: dark-mode strings have their own color; the `propertyName` token is themed so RON files read as highlighted; loading spinners keep running under `prefers-reduced-motion`.

### Performance

- Much faster review open on large repos; files of 2 MB or more are hidden.
- The commit list is paged instead of loading the whole branch.
- Image previews load only near the viewport.

## 0.16.6 and earlier

See the [upstream releases](https://github.com/darioielardi/delta/releases) of [darioielardi/delta](https://github.com/darioielardi/delta).
