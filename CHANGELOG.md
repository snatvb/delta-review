# Changelog

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
