use crate::git::model::DiffMode;
use crate::git::{common_git_dir, main_worktree_dir, resolve_worktree};
use crate::registry::model::{repo_name_from_path, RepoEntry, WorktreeEntry};
use crate::review::model::review_id;
use crate::vcs::{Repo, VcsKind};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Tells a reused review window to reopen its review, since its worktree may have
/// moved to another branch since the window opened.
const REOPEN_EVENT: &str = "review:reopen";

/// CLI shim name — short for delta-review. The debug build installs as `dr-dev`
/// so it never clobbers the installed release's `dr`; the two coexist on PATH
/// and never hijack each other. Must differ from `mainBinaryName` in
/// tauri.conf.json — the shim is a symlink and Linux resolves /proc/self/exe,
/// so equal names break CLI routing there. (`delta-review`/`delta-review-dev`
/// are the pre-rename legacy names, cleaned up by `remove_legacy_shims`.)
#[cfg(debug_assertions)]
pub const CLI_NAME: &str = "dr-dev";
#[cfg(not(debug_assertions))]
pub const CLI_NAME: &str = "dr";

/// Window title — suffixed in dev builds so the debug app is visually distinct from
/// the installed release in the title bar and window switcher.
#[cfg(debug_assertions)]
const WINDOW_TITLE: &str = "Delta Review (dev)";
#[cfg(not(debug_assertions))]
const WINDOW_TITLE: &str = "Delta Review";

/// Traffic-light placement, shared by every window's overlay titlebar (macOS).
/// x lands the close button's left edge flush with the sidebar content inset
/// (FilesPanel's pl-1.5 + px-2 = 14px, where the search box and the viewed
/// counter sit). wry derives the titlebar height as `button_height + y` and the
/// buttons ride near its bottom, so the visual top is roughly `y - button_h/2`:
/// with macOS 26's 14pt buttons, y=26 puts the top at 17, dead-center in the
/// 48px toolbar. Verify against devbridge's /lights; recalibrate when a macOS
/// update changes the system button metrics.
#[cfg(target_os = "macos")]
pub(crate) const TRAFFIC_LIGHT_X: f64 = 14.0;
#[cfg(target_os = "macos")]
pub(crate) const TRAFFIC_LIGHT_Y: f64 = 26.0;

/// wry's traffic-light inset, applied verbatim: stretch the titlebar container
/// to `button_height + y` (top-anchored) and move the buttons to x. The
/// builder-time application is undone by the first AppKit titlebar relayout,
/// and wry only re-applies on webview redraws — which a fully-covered view
/// never gets — so windows must re-run this themselves (see keep_traffic_lights).
/// Must run on the main thread; AppKit mutations off-thread throw.
#[cfg(target_os = "macos")]
fn apply_traffic_lights(w: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};
    let Ok(ptr) = w.ns_window() else { return };
    let win: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let Some(close) = win.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = win.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let zoom = win.standardWindowButton(NSWindowButton::ZoomButton);
    let close_v = unsafe { objc2::rc::Retained::cast_unchecked::<NSView>(close) };
    let min_v = unsafe { objc2::rc::Retained::cast_unchecked::<NSView>(miniaturize) };
    let Some(container) = unsafe { close_v.superview() }.and_then(|v| unsafe { v.superview() })
    else {
        return;
    };
    let container_v = unsafe { objc2::rc::Retained::cast_unchecked::<NSView>(container) };

    let close_rect = close_v.frame();
    let bar_h = close_rect.size.height + TRAFFIC_LIGHT_Y;
    let win_h = win.frame().size.height;
    let mut crect = container_v.frame();
    crect.size.height = bar_h;
    crect.origin.y = win_h - bar_h;
    container_v.setFrame(crect);

    let space = min_v.frame().origin.x - close_rect.origin.x;
    let mut views = vec![close_v, min_v];
    if let Some(z) = zoom {
        views.push(unsafe { objc2::rc::Retained::cast_unchecked::<NSView>(z) });
    }
    for (i, v) in views.iter().enumerate() {
        let mut r = v.frame();
        r.origin.x = TRAFFIC_LIGHT_X + i as f64 * space;
        v.setFrameOrigin(r.origin);
    }
}

/// Keep the traffic lights where TRAFFIC_LIGHT_* puts them. AppKit discards the
/// inset on every titlebar relayout (creation, window-state restore, show,
/// resizes, fullscreen), so: apply now plus a hidden size wiggle that forces
/// the creation-time relayout (and its correction) before first paint, and
/// re-apply on every later Resized/Moved/Focused. Idempotent and cheap.
#[cfg(target_os = "macos")]
fn keep_traffic_lights(w: &tauri::WebviewWindow) {
    let w_apply = w.clone();
    let _ = w.run_on_main_thread(move || {
        apply_traffic_lights(&w_apply);
        if let Ok(size) = w_apply.outer_size() {
            let _ = w_apply.set_size(tauri::PhysicalSize::new(size.width + 1, size.height));
            let _ = w_apply.set_size(size);
        }
    });
    let w_events = w.clone();
    w.on_window_event(move |e| {
        if matches!(
            e,
            tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Focused(_)
        ) {
            apply_traffic_lights(&w_events);
        }
    });
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// The repo/worktree path to open. A bare invocation (no path arg) resolves to
    /// the cwd; whether that opens a review or falls back to Home is a downstream
    /// repo-validity check (see `route_launch`).
    pub repo_path: PathBuf,
    /// `None` when no mode flag was passed; `Some(_)` for an explicit `--all` /
    /// `--uncommitted` / `--last-commit` / `--branch`.
    pub mode: Option<DiffMode>,
}

/// Pure CLI parsing. `args` excludes the binary name. No filesystem access.
pub fn parse_launch(args: &[String], cwd: &Path) -> Launch {
    let mut mode: Option<DiffMode> = None;
    let mut path_token: Option<&str> = None;
    for arg in args {
        if let Some(m) = DiffMode::from_flag(arg) {
            mode = Some(m);
        } else if !arg.starts_with("--") && path_token.is_none() {
            // A non-flag token is the path. Unknown `--flags` are ignored here
            // (the CLI rejects them up front; the app stays lenient). (#help)
            path_token = Some(arg.as_str());
        }
    }
    // A bare invocation (no path arg) or "." resolves to the cwd, so `delta` inside
    // a repo opens that worktree; a non-repo path falls back to Home downstream. (#9)
    let repo_path = match path_token {
        None | Some(".") => cwd.to_path_buf(),
        Some(p) if Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) => cwd.join(p),
    };
    Launch { repo_path, mode }
}

/// True when a CLI launch points at a path that isn't inside a repository — the
/// case a terminal invocation should reject (warn + do nothing) instead of
/// falling back to the launcher. `Repo::open` discovers upward, so a subdir of
/// a repo still counts as valid.
#[cfg(any(unix, test))] // the CLI shim is the only caller; it does not exist on Windows
pub fn launch_targets_non_repo(launch: &Launch) -> bool {
    Repo::open(&launch.repo_path.to_string_lossy()).is_err()
}

/// HEAD commit time (RFC3339) + dirty flag for an open worktree repo handle.
/// Both are best-effort — failures degrade to (None, false) rather than erroring
/// the whole listing.
fn worktree_meta(repo: &git2::Repository) -> (Option<String>, bool) {
    let last_commit_at = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .and_then(|c| chrono::DateTime::from_timestamp(c.time().seconds(), 0))
        .map(|dt| dt.to_rfc3339());
    // The dirty flag needs a full `git status` scan (working-tree walk incl. untracked)
    // per worktree — the dominant cost when a repo has dozens of worktrees. Dropped
    // from the hot path; the picker shows worktrees without an uncommitted marker.
    (last_commit_at, false)
}

/// Open a linked worktree and read its display metadata. Each call uses its own
/// `Repository` handle, so this is safe to run on a worker thread.
fn linked_worktree_entry(path: &Path) -> Option<WorktreeEntry> {
    let wt_repo = git2::Repository::open(path).ok()?;
    let branch = resolve_worktree(&wt_repo).unwrap_or_else(|_| "(detached)".into());
    let (last_commit_at, dirty) = worktree_meta(&wt_repo);
    Some(WorktreeEntry {
        path: path.display().to_string(),
        branch,
        is_main: false,
        last_commit_at,
        dirty,
    })
}

/// All checked-out worktrees of the repo: the main workdir + any linked worktrees.
/// The per-worktree metadata (HEAD time + dirty status) is the slow part — a
/// `git status` scan each — so linked worktrees are opened and scanned in parallel
/// batches. A repo with dozens of worktrees would otherwise take hundreds of ms.
pub fn list_git_worktrees(repo: &git2::Repository) -> Result<Vec<WorktreeEntry>, String> {
    let mut out = Vec::new();
    if let Some(wd) = repo.workdir() {
        let (last_commit_at, dirty) = worktree_meta(repo);
        out.push(WorktreeEntry {
            path: wd.display().to_string(),
            branch: resolve_worktree(repo)?,
            is_main: true,
            last_commit_at,
            dirty,
        });
    }
    // Resolve linked-worktree paths up front (cheap), then scan them concurrently.
    let names = repo
        .worktrees()
        .map_err(|e| format!("list worktrees: {e}"))?;
    let paths: Vec<PathBuf> = names
        .iter()
        .flatten()
        .filter_map(|name| {
            repo.find_worktree(name)
                .ok()
                .map(|wt| wt.path().to_path_buf())
        })
        .collect();
    // Bounded fan-out: up to 16 worktrees scanned at once per batch.
    for chunk in paths.chunks(16) {
        let batch: Vec<WorktreeEntry> = std::thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|p| s.spawn(|| linked_worktree_entry(p)))
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().ok().flatten())
                .collect()
        });
        out.extend(batch);
    }
    Ok(out)
}

/// Canonical repo display name — the main worktree's directory name (e.g. "delta"),
/// regardless of which (possibly linked) worktree path was opened.
pub fn repo_display_name(repo_path: &str) -> String {
    Repo::open(repo_path)
        .map(|repo| repo.display_name())
        .unwrap_or_else(|_| repo_name_from_path(repo_path))
}

/// Stable registry id for a repo: SHA256(common git dir)[..8]. Shared by every
/// worktree of the repo, so per-repo settings (e.g. the base strategy) group
/// under one entry no matter which worktree path was opened.
pub fn repo_entry_id(repo: &git2::Repository) -> String {
    let commondir = common_git_dir(repo).display().to_string();
    let mut h = Sha256::new();
    h.update(commondir.as_bytes());
    h.finalize()[..8]
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

/// Registry repo entry for a git repo: keyed by the git commondir so linked
/// worktrees group together. `root`/`name` describe the main worktree, not
/// whichever worktree path was opened.
pub fn git_repo_entry(repo: &git2::Repository) -> Result<RepoEntry, String> {
    let id = repo_entry_id(repo);
    let root = main_worktree_dir(repo)
        .map(|p| p.display().to_string())
        .or_else(|| repo.workdir().map(|p| p.display().to_string()))
        .unwrap_or_else(|| repo.path().display().to_string());
    let name = repo_name_from_path(&root);
    let default_branch = crate::git::default_branch(repo).map(|(label, _)| label);
    let worktrees = list_git_worktrees(repo)?;
    Ok(RepoEntry {
        id,
        root,
        name,
        default_branch,
        base_strategy: None,
        worktrees,
        vcs: VcsKind::Git,
        vcs_override: None,
    })
}

/// Minimal percent-encoder for URL query values (RFC 3986 unreserved set preserved).
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Outcome of `open_target_window`: whether an existing window was focused or a
/// new one created. The payload is the `review-{id}` window label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    Focused(String),
    Created(String),
}

/// The single choke point for "open this target". Focus-or-create, ≤1 per target.
pub fn open_target_window(
    app: &AppHandle,
    repo_path: &str,
    mode: DiffMode,
    base: Option<String>,
) -> Result<Opened, String> {
    let repo = Repo::open(repo_path)?;
    let canonical = repo.root().display().to_string();
    let worktree = repo.worktree_label()?;
    // A mode the backend can't compute (e.g. a CLI flag on an SVN working
    // copy) degrades to its working-copy diff instead of failing the open.
    let mode = repo.coerce_mode(mode);
    let id = review_id(&canonical, &worktree);
    let label = format!("review-{id}");
    let one_window_per_worktree = !crate::settings::load(app).window_per_branch;
    let existing = app.get_webview_window(&label).or_else(|| {
        one_window_per_worktree
            .then(|| crate::watch::window_watching(app, Path::new(&canonical)))
            .flatten()
            .and_then(|l| app.get_webview_window(&l))
    });
    if let Some(w) = existing {
        let _ = w.show();
        let _ = w.set_focus();
        if one_window_per_worktree {
            let _ = w.emit(REOPEN_EVENT, ());
        }
        return Ok(Opened::Focused(w.label().to_string()));
    }
    let mut url = format!("index.html?repo={}&mode={}", enc(&canonical), mode.as_str());
    if let Some(b) = base.as_deref() {
        url.push_str(&format!("&base={}", enc(b)));
    }
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(WINDOW_TITLE)
        .visible(false) // shown via show()+setFocus() after first paint so the window orders front
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(
                TRAFFIC_LIGHT_X,
                TRAFFIC_LIGHT_Y,
            ));
    }
    let window = builder.build().map_err(|e| format!("create window: {e}"))?;
    #[cfg(target_os = "macos")]
    keep_traffic_lights(&window);
    // Auto-refresh: watch this worktree and notify the window on change. (#9)
    crate::watch::start(app, &label, Path::new(&canonical));
    Ok(Opened::Created(label))
}

/// Re-point an existing window's fs watcher at a different target's worktree.
/// Used by "replace current" picker mode: the review window navigates in place
/// (frontend) to a new review, so its watcher must follow the new repo for
/// auto-refresh to stay correct. `watch::start` replaces any watcher already
/// registered under this label, dropping the old one. (#replace)
pub fn rewatch_target(app: &AppHandle, label: &str, repo_path: &str) -> Result<(), String> {
    let canonical = Repo::open(repo_path)?.root().display().to_string();
    crate::watch::start(app, label, Path::new(&canonical));
    Ok(())
}

/// The cold-launch host window. The command palette (frontend) opens over it.
/// Focus-or-create the singleton `home` window.
pub fn open_home_window(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("home") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, "home", WebviewUrl::App("index.html".into()))
        .title(WINDOW_TITLE)
        .visible(false) // shown via show()+setFocus() after first paint so the window orders front
        .inner_size(1000.0, 680.0)
        .min_inner_size(800.0, 560.0)
        .center();
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(
                TRAFFIC_LIGHT_X,
                TRAFFIC_LIGHT_Y,
            ));
    }
    let window = builder
        .build()
        .map_err(|e| format!("create home window: {e}"))?;
    #[cfg(target_os = "macos")]
    keep_traffic_lights(&window);
    Ok(())
}

/// First-launch + single-instance routing: open the target's review window when
/// launched inside a repo, otherwise the home window (which shows the palette).
pub fn route_launch(app: &AppHandle, args: &[String], cwd: &Path) {
    let launch = parse_launch(args, cwd);
    let path = launch.repo_path.to_string_lossy().to_string();
    let mode = launch.mode.unwrap_or(DiffMode::Uncommitted);
    let opened = Repo::open(&path).is_ok() && open_target_window(app, &path, mode, None).is_ok();
    if !opened {
        let _ = open_home_window(app);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallOutcome {
    /// Symlinked into a directory already on PATH — runnable in open and new terminals.
    Linked { path: String },
    /// Symlinked into ~/.local/bin and wired that dir into the user's shell configs.
    /// New terminals pick it up automatically; an already-open shell won't until it
    /// re-reads its config. `shells` lists the shells we updated.
    LinkedPathUpdated { path: String, shells: Vec<String> },
    /// Couldn't install automatically; surface a command for the user to run.
    ManualNeeded { command: String, reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// False where the shim can't exist at all (no unix socket, no `open -b`), so
    /// the UI drops every CLI affordance instead of offering an install that fails.
    pub supported: bool,
    pub installed: bool,
    pub path: Option<String>,
}

/// Pure: pick the install dir. Prefer /usr/local/bin, else the first writable PATH dir.
pub fn choose_install_dir(
    path_dirs: &[PathBuf],
    is_writable: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    path_dirs
        .iter()
        .find(|p| p.ends_with("usr/local/bin") && is_writable(p.as_path()))
        .or_else(|| path_dirs.iter().find(|p| is_writable(p.as_path())))
        .cloned()
}

fn dir_is_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(".delta-write-probe");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn link_into(dir: &Path, exe: &Path) -> Result<InstallOutcome, String> {
    let link = dir.join(CLI_NAME);
    if fs::symlink_metadata(&link).is_ok() {
        let _ = fs::remove_file(&link); // replace stale link/file
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(exe, &link).map_err(|e| format!("symlink: {e}"))?;
        Ok(InstallOutcome::Linked {
            path: link.display().to_string(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = (exe, link);
        Err("CLI install is only supported on Unix".into())
    }
}

/// Pre-rename shim names. A fresh install removes them when they point at this
/// exe, so the old long-form command doesn't linger next to `dr` as a second,
/// surprising entry point.
const LEGACY_SHIMS: [&str; 2] = ["delta-review", "delta-review-dev"];

/// Best-effort removal of legacy `delta-review` shim symlinks that resolve to
/// this binary, in the dirs an install (or a manual `ln -s`) would have used.
/// Only provably-ours links are touched; anything else stays.
fn remove_legacy_shims(exe: &Path, extra_dir: Option<&Path>) {
    let Some(real) = std::fs::canonicalize(exe).ok() else {
        return;
    };
    let mut dirs = preferred_bin_dirs();
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    if let Some(d) = extra_dir {
        dirs.push(d.to_path_buf());
    }
    for dir in dirs {
        for legacy in LEGACY_SHIMS {
            let link = dir.join(legacy);
            let is_our_symlink = fs::symlink_metadata(&link)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
                && fs::canonicalize(&link).map(|p| p == real).unwrap_or(false);
            if is_our_symlink {
                let _ = fs::remove_file(&link);
            }
        }
    }
}

/// Dirs conventionally on a terminal's PATH that a GUI-launched macOS app's own
/// PATH usually omits (launchd hands a minimal PATH). Linking here lets `delta`
/// resolve in already-open and new terminals without touching any shell config.
fn preferred_bin_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ]
}

pub fn install_cli() -> Result<InstallOutcome, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    let path_var = std::env::var("PATH").unwrap_or_default();
    let path_dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();

    // 1) Prefer a writable dir that's conventionally on the terminal PATH (covers
    //    Homebrew Macs with zero config edits), then any writable PATH dir.
    let mut candidates = preferred_bin_dirs();
    candidates.extend(path_dirs.iter().cloned());
    if let Some(dir) = choose_install_dir(&candidates, dir_is_writable) {
        let out = link_into(&dir, &exe)?;
        remove_legacy_shims(&exe, Some(&dir));
        return Ok(out);
    }

    // 2) Fall back to ~/.local/bin (create it). If it isn't already on PATH, wire it
    //    into the user's shell configs so new terminals pick it up — no manual step.
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        let local_bin = home.join(".local/bin");
        if fs::create_dir_all(&local_bin).is_ok() && dir_is_writable(&local_bin) {
            link_into(&local_bin, &exe)?; // the symlink itself succeeded
            remove_legacy_shims(&exe, Some(&local_bin));
            let path = local_bin.join(CLI_NAME).display().to_string();
            if path_dirs.iter().any(|d| d == &local_bin) {
                return Ok(InstallOutcome::Linked { path });
            }
            let shells = ensure_dir_on_path(&home, &local_bin);
            return Ok(InstallOutcome::LinkedPathUpdated { path, shells });
        }
    }

    Ok(InstallOutcome::ManualNeeded {
        command: format!(
            "sudo ln -sf '{}' /usr/local/bin/{}",
            exe.display(),
            CLI_NAME
        ),
        reason: "No writable directory found on your PATH.".into(),
    })
}

/// Best-effort check for an installed `delta` shim in the dirs we (or a manual
/// install) would use, so the UI can stop offering to install it.
#[cfg(unix)]
pub fn cli_status() -> CliStatus {
    let mut dirs = preferred_bin_dirs();
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    if let Ok(path_var) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path_var));
    }
    for dir in dirs {
        let link = dir.join(CLI_NAME);
        if fs::symlink_metadata(&link).is_ok() {
            return CliStatus {
                supported: true,
                installed: true,
                path: Some(link.display().to_string()),
            };
        }
    }
    CliStatus {
        supported: true,
        installed: false,
        path: None,
    }
}

/// The shim rides a unix socket and `open -b`, so it can't exist on Windows.
#[cfg(not(unix))]
pub fn cli_status() -> CliStatus {
    CliStatus {
        supported: false,
        installed: false,
        path: None,
    }
}

/// Tags the block we append to a shell config so re-running install is idempotent.
const RC_MARKER: &str = "# Added by delta (delta CLI)";

/// POSIX (bash/zsh) snippet prepending `dir` to PATH.
fn posix_path_block(dir: &Path) -> String {
    format!("\n{RC_MARKER}\nexport PATH=\"{}:$PATH\"\n", dir.display())
}

/// fish snippet — fish manages PATH via its own builtin.
fn fish_path_block(dir: &Path) -> String {
    format!("\n{RC_MARKER}\nfish_add_path {}\n", dir.display())
}

/// Append `block` to `file` unless our marker is already there. Creates the file
/// (and parents) only when `create` is set — we don't want to materialize shell
/// configs the user doesn't use. Returns true if the file ends up wiring the dir.
fn append_block_if_missing(file: &Path, block: &str, create: bool) -> bool {
    match fs::read_to_string(file) {
        Ok(existing) => {
            if existing.contains(RC_MARKER) {
                return true; // already wired by a previous install
            }
            let mut contents = existing;
            contents.push_str(block);
            fs::write(file, contents).is_ok()
        }
        Err(_) if create => {
            if let Some(parent) = file.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::write(file, block.trim_start_matches('\n')).is_ok()
        }
        Err(_) => false,
    }
}

/// Add `dir` to PATH across the user's shells by editing their rc files. zsh is the
/// macOS default so its config is created if absent; bash/fish are only touched when
/// the user already has them. Returns the shells we updated.
fn ensure_dir_on_path(home: &Path, dir: &Path) -> Vec<String> {
    let mut updated = Vec::new();
    if append_block_if_missing(&home.join(".zshrc"), &posix_path_block(dir), true) {
        updated.push("zsh".to_string());
    }
    // A plain loop with |=, not .any(): every matching rc file must get the
    // block, and .any() would short-circuit past the rest after the first hit.
    let mut bash_updated = false;
    for f in [".bashrc", ".bash_profile", ".profile"] {
        let p = home.join(f);
        if p.exists() {
            bash_updated |= append_block_if_missing(&p, &posix_path_block(dir), false);
        }
    }
    if bash_updated {
        updated.push("bash".to_string());
    }
    if home.join(".config/fish").is_dir()
        && append_block_if_missing(
            &home.join(".config/fish/config.fish"),
            &fish_path_block(dir),
            true,
        )
    {
        updated.push("fish".to_string());
    }
    updated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn enc_percent_encodes_path_separators_and_spaces() {
        assert_eq!(enc("/Users/me/my proj"), "%2FUsers%2Fme%2Fmy%20proj");
        assert_eq!(enc("feat/auth"), "feat%2Fauth");
        assert_eq!(enc("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn list_worktrees_returns_main_only_for_simple_repo() {
        let (dir, repo) = repo_with_commit();
        let wts = list_git_worktrees(&repo).unwrap();
        let _ = &dir;
        assert_eq!(wts.len(), 1);
        assert!(wts[0].is_main);
        assert_eq!(wts[0].branch, "main");
    }

    #[test]
    fn list_worktrees_includes_linked_worktrees() {
        let (dir, repo) = repo_with_commit();
        add_worktree(&repo, dir.path(), "delta-feat", "feat/auth");
        let mut wts = list_git_worktrees(&repo).unwrap();
        wts.sort_by(|a, b| a.branch.cmp(&b.branch));
        let branches: Vec<&str> = wts.iter().map(|w| w.branch.as_str()).collect();
        assert!(branches.contains(&"main"));
        assert!(branches.contains(&"feat/auth"));
        assert_eq!(wts.iter().filter(|w| w.is_main).count(), 1);
    }

    #[test]
    fn list_worktrees_sees_worktree_added_by_git_cli_after_first_enumeration() {
        // Reproduces the real path: a worktree created via the git CLI AFTER the app
        // already enumerated once must appear on the next enumeration. Each call opens
        // a fresh handle, so this asserts the enumeration is genuinely live (not cached).
        let (dir, repo) = repo_with_commit();
        let root = dir.path().to_str().unwrap();
        assert_eq!(
            list_git_worktrees(&repo).unwrap().len(),
            1,
            "main only before add"
        );

        let wt_path = dir.path().parent().unwrap().join(format!(
            "{}--cli",
            dir.path().file_name().unwrap().to_string_lossy()
        ));
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(["worktree", "add", "-b", "feat/cli"])
            .arg(&wt_path)
            .output()
            .expect("run git worktree add");
        assert!(
            out.status.success(),
            "git worktree add: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        let second = list_git_worktrees(&git2::Repository::open(root).unwrap()).unwrap();
        let branches: Vec<&str> = second.iter().map(|w| w.branch.as_str()).collect();
        let _ = std::fs::remove_dir_all(&wt_path);
        assert_eq!(
            second.len(),
            2,
            "new CLI worktree must appear; got {branches:?}"
        );
        assert!(branches.contains(&"feat/cli"), "got {branches:?}");
    }

    #[test]
    fn repo_entry_has_name_default_branch_and_worktrees() {
        let (_dir, repo) = repo_with_commit();
        let entry = git_repo_entry(&repo).unwrap();
        assert_eq!(entry.default_branch.as_deref(), Some("main"));
        assert!(!entry.id.is_empty());
        assert!(!entry.worktrees.is_empty());
    }

    #[test]
    fn parse_launch_no_args_targets_cwd() {
        // Bare `delta` resolves to the cwd, so launching inside a repo opens that
        // worktree; the home fallback is a downstream repo-validity check.
        let l = parse_launch(&[], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj"));
        assert_eq!(l.mode, None);
    }

    #[test]
    fn parse_launch_no_mode_flag_is_none_not_all_changes() {
        // `None` is what lets the socket handler tell "no --mode given" (focus only)
        // from an explicit `--all` (switch the open window to all-changes).
        assert_eq!(
            parse_launch(&["/abs/repo".into()], Path::new("/c")).mode,
            None
        );
        assert_eq!(
            parse_launch(&["--all".into()], Path::new("/c")).mode,
            Some(DiffMode::AllChanges)
        );
    }

    #[test]
    fn parse_launch_dot_is_cwd() {
        let l = parse_launch(&[".".to_string()], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj"));
    }

    #[test]
    fn parse_launch_absolute_path_wins() {
        let l = parse_launch(&["/abs/repo".to_string()], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/abs/repo"));
    }

    #[test]
    fn parse_launch_relative_path_joins_cwd() {
        let l = parse_launch(&["sub/dir".to_string()], Path::new("/home/me/proj"));
        assert_eq!(l.repo_path, PathBuf::from("/home/me/proj/sub/dir"));
    }

    #[test]
    fn parse_launch_mode_flags() {
        assert_eq!(
            parse_launch(&["--all".into()], Path::new("/c")).mode,
            Some(DiffMode::AllChanges)
        );
        assert_eq!(
            parse_launch(&["--uncommitted".into()], Path::new("/c")).mode,
            Some(DiffMode::Uncommitted)
        );
        assert_eq!(
            parse_launch(&["--last-commit".into()], Path::new("/c")).mode,
            Some(DiffMode::LastCommit)
        );
        assert_eq!(
            parse_launch(&["--branch".into()], Path::new("/c")).mode,
            Some(DiffMode::BranchVsBase)
        );
    }

    #[test]
    fn parse_launch_flag_then_path() {
        let l = parse_launch(
            &["--uncommitted".into(), "/abs/repo".into()],
            Path::new("/c"),
        );
        assert_eq!(l.repo_path, PathBuf::from("/abs/repo"));
        assert_eq!(l.mode, Some(DiffMode::Uncommitted));
    }

    #[test]
    fn launch_targets_non_repo_distinguishes_repo_from_plain_dir() {
        // Inside a repo (discover walks up) → valid, not rejected.
        let (repo_dir, _repo) = repo_with_commit();
        assert!(!launch_targets_non_repo(&parse_launch(
            &[],
            repo_dir.path()
        )));
        // A plain directory with no git anywhere above → rejected.
        let plain = tempfile::TempDir::new().unwrap();
        assert!(launch_targets_non_repo(&parse_launch(&[], plain.path())));
    }

    #[test]
    fn choose_prefers_usr_local_bin_when_writable() {
        let dirs = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ];
        assert_eq!(
            choose_install_dir(&dirs, |_| true),
            Some(PathBuf::from("/usr/local/bin"))
        );
    }

    #[test]
    fn choose_falls_back_to_first_writable() {
        let dirs = vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ];
        let chosen = choose_install_dir(&dirs, |p: &Path| p.ends_with("homebrew/bin"));
        assert_eq!(chosen, Some(PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn choose_none_when_nothing_writable() {
        let dirs = vec![PathBuf::from("/usr/local/bin")];
        assert_eq!(choose_install_dir(&dirs, |_| false), None);
    }

    #[test]
    fn path_blocks_carry_marker_and_dir() {
        let dir = Path::new("/Users/me/.local/bin");
        let posix = posix_path_block(dir);
        assert!(posix.contains(RC_MARKER));
        assert!(posix.contains("export PATH=\"/Users/me/.local/bin:$PATH\""));
        let fish = fish_path_block(dir);
        assert!(fish.contains(RC_MARKER));
        assert!(fish.contains("fish_add_path /Users/me/.local/bin"));
    }

    #[test]
    fn append_block_is_idempotent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let rc = tmp.path().join(".zshrc");
        let block = posix_path_block(Path::new("/x/bin"));
        // First run creates the file and writes the block once.
        assert!(append_block_if_missing(&rc, &block, true));
        // Second run is a no-op (marker already present) — no duplication.
        assert!(append_block_if_missing(&rc, &block, true));
        let contents = fs::read_to_string(&rc).unwrap();
        assert_eq!(contents.matches(RC_MARKER).count(), 1);
    }

    #[test]
    fn append_block_skips_creating_when_not_requested() {
        let tmp = tempfile::TempDir::new().unwrap();
        let rc = tmp.path().join(".bashrc");
        assert!(!append_block_if_missing(&rc, "x", false));
        assert!(!rc.exists());
    }

    #[test]
    fn ensure_dir_on_path_creates_zsh_and_touches_existing_only() {
        let home = tempfile::TempDir::new().unwrap();
        let home = home.path();
        // Pre-existing bash + fish configs; no zshrc yet.
        fs::write(home.join(".bashrc"), "# mine\n").unwrap();
        fs::create_dir_all(home.join(".config/fish")).unwrap();

        let updated = ensure_dir_on_path(home, &home.join(".local/bin"));
        assert!(updated.contains(&"zsh".to_string()));
        assert!(updated.contains(&"bash".to_string()));
        assert!(updated.contains(&"fish".to_string()));

        // zshrc was created; bash kept its original content + our block; fish wired.
        assert!(home.join(".zshrc").exists());
        assert!(fs::read_to_string(home.join(".bashrc"))
            .unwrap()
            .contains("# mine"));
        assert!(fs::read_to_string(home.join(".bashrc"))
            .unwrap()
            .contains(RC_MARKER));
        assert!(fs::read_to_string(home.join(".config/fish/config.fish"))
            .unwrap()
            .contains("fish_add_path"));
        // We never created a bash_profile the user didn't have.
        assert!(!home.join(".bash_profile").exists());
    }

    #[test]
    fn ensure_dir_on_path_without_fish_skips_fish() {
        let home = tempfile::TempDir::new().unwrap();
        let updated = ensure_dir_on_path(home.path(), &home.path().join(".local/bin"));
        assert_eq!(updated, vec!["zsh".to_string()]);
    }
}
