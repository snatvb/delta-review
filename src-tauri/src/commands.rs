use crate::export::export_markdown;
use crate::git::branches::{self, BranchList};
use crate::git::cache::DiffCache;
use crate::git::diff::{BinaryFileDiff, DiffSummary, FileDiff};
use crate::git::log::CommitPage;
use crate::git::model::{DiffMode, Target};
use crate::launch::{
    cli_status as launch_cli_status, install_cli as launch_install_cli, open_target_window,
    repo_display_name, repo_entry_id, rewatch_target, CliStatus, InstallOutcome,
};
use crate::registry::model::{BaseStrategy, Registry, RepoEntry, ReviewEntry, WorktreeEntry};
use crate::review::model::{review_id, Review, Snapshot};
use crate::review::reconcile::{
    adopt_persisted_viewed_hashes, reconcile, restore_persisted_comments, stamp_viewed_baselines,
    ReviewSession,
};
use crate::settings::Settings;
use crate::storage::{JsonRegistryStore, JsonStorage, RegistryStore, Storage};
use crate::vcs::{Repo, VcsKind};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, MutexGuard};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// True unless telemetry is disabled by build or environment. This reports only
/// what the frontend cannot see (the debug/release flag and process env); the
/// user's Settings toggle is a separate, frontend-only check. Debug builds have
/// no analytics plugin registered, so this is always false there.
/// SLEEPING TELEMETRY: dormant in this fork — nothing calls this at runtime
/// while TELEMETRY_DORMANT is set in src/analytics.ts. Kept for revival.
#[tauri::command]
pub fn telemetry_allowed() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    telemetry_allowed_from_env(
        std::env::var("DO_NOT_TRACK").ok().as_deref(),
        std::env::var("DELTA_TELEMETRY").ok().as_deref(),
    )
}

/// Pure decision: `DO_NOT_TRACK=1|true` (Console Do Not Track standard) or
/// `DELTA_TELEMETRY=0|false` disables; anything else is allowed.
pub(crate) fn telemetry_allowed_from_env(
    do_not_track: Option<&str>,
    delta_telemetry: Option<&str>,
) -> bool {
    let dnt = do_not_track
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if dnt {
        return false;
    }
    let disabled = delta_telemetry
        .map(|v| v == "0" || v.eq_ignore_ascii_case("false"))
        .unwrap_or(false);
    !disabled
}

pub fn list_commits_impl(target: Target, skip: usize, limit: usize) -> Result<CommitPage, String> {
    Repo::open(&target.repo_path)?.list_commits(&target, skip, limit)
}

/// Fill a Target's implicit base from a repo's saved strategy. An explicit base
/// always wins; a pinned strategy is injected so every command below (diff,
/// commit walk, reconcile) agrees on one base — the DiffCache is keyed by the
/// Target, so a partially-filled base would re-run whole-repo diffs per file.
/// Auto stays `None` and is resolved per-call by the fork-point heuristic in
/// `git::resolve_base`.
pub fn fill_base_from_strategy(target: Target, strategy: Option<&BaseStrategy>) -> Target {
    match (&target.base, strategy) {
        (Some(_), _) | (None, None | Some(BaseStrategy::Auto)) => target,
        (None, Some(BaseStrategy::Branch { name })) => Target {
            base: Some(name.clone()),
            ..target
        },
    }
}

/// The repo-wide base strategy for any worktree path of a repo (git only).
/// Resolved by the registry's commondir-keyed repo id, so it works from the
/// main worktree and linked worktrees alike.
fn repo_base_strategy(app: &tauri::AppHandle, repo_path: &str) -> Option<BaseStrategy> {
    let repo = crate::git::open_repo(repo_path).ok()?;
    let id = repo_entry_id(&repo);
    registry_of(app)
        .ok()?
        .repos
        .iter()
        .find(|r| r.id == id)
        .and_then(|r| r.base_strategy.clone())
}

/// `fill_base_from_strategy` with the strategy loaded from this app's registry.
fn with_base_strategy(app: &tauri::AppHandle, target: Target) -> Target {
    let strategy = repo_base_strategy(app, &target.repo_path);
    fill_base_from_strategy(target, strategy.as_ref())
}

fn reviews_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("reviews"))
}

pub fn open_review_impl(
    cache: &DiffCache,
    storage: &dyn Storage,
    input: Target,
) -> Result<ReviewSession, String> {
    let repo = Repo::open(&input.repo_path)?;
    let worktree = repo.worktree_label()?;
    let mut target = input;
    // A mode this backend can't compute (stale persisted review, deep link)
    // degrades to its working-copy diff instead of erroring the open.
    target.mode = repo.coerce_mode(target.mode);
    target.worktree = Some(worktree.clone());
    let id = review_id(&target.repo_path, &worktree);

    let review = match storage.load(&id)? {
        // Trust the freshly-resolved target (mode / repo / worktree); only the
        // user's comments + viewed state carry over. A persisted review must
        // never silently override the requested mode with a stale one.
        Some(mut r) => {
            r.target = target;
            r
        }
        None => Review::new(
            id,
            target,
            Snapshot {
                base_oid: String::new(),
                head_oid: None,
                head_commit: None,
                captured_at: String::new(),
            },
            chrono::Utc::now().to_rfc3339(),
        ),
    };
    let session = reconcile(cache, review)?;
    storage.save(&session.review)?;
    Ok(session)
}

pub fn refresh_review_impl(
    cache: &DiffCache,
    storage: &dyn Storage,
    mut review: Review,
) -> Result<ReviewSession, String> {
    // A refresh means "recompute against the current state", so drop any memoized
    // diff snapshot for this worktree. Covers a manual Refresh and one racing the
    // fs watcher's debounce. The served copies survive — the viewed-baseline stamp
    // below reads them.
    cache.invalidate(&review.target.repo_path);
    // The FE's in-memory viewed entries may still carry empty hashes from a
    // just-made toggle; save_review already stamped the real baselines to disk.
    // Adopt them so a file changed since it was viewed is correctly un-viewed here.
    if let Ok(Some(persisted)) = storage.load(&review.id) {
        adopt_persisted_viewed_hashes(&mut review, &persisted);
        restore_persisted_comments(&mut review, &persisted);
    }
    // A toggle whose save lost the race to this refresh (fs-change fires it
    // concurrently) still carries an empty hash with nothing on disk to adopt.
    // Stamp it from the served snapshot — the version on screen — before
    // reconcile, or its lazy stamp would baseline current disk and keep the
    // mark alive on a file that changed under the toggle.
    stamp_viewed_baselines(cache, &mut review);
    let session = reconcile(cache, review)?;
    storage.save(&session.review)?;
    Ok(session)
}

pub fn save_review_impl(
    cache: &DiffCache,
    storage: &dyn Storage,
    mut review: Review,
) -> Result<(), String> {
    // Stamp a content baseline onto freshly-toggled viewed entries now, while the
    // files are still at the version the user saw — see stamp_viewed_baselines.
    // Served from the diff cache (a map read), not a fresh whole-repo diff per entry.
    stamp_viewed_baselines(cache, &mut review);
    storage.save(&review)
}

fn registry_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("registry.json"))
}

fn reg_store(app: &tauri::AppHandle) -> Result<JsonRegistryStore, String> {
    Ok(JsonRegistryStore::new(
        registry_path(app)?,
        reviews_dir(app)?,
    ))
}

/// Upsert repo + review entry with a fresh file_count (open/refresh path). Non-fatal.
fn sync_registry_after_open(reg_store: &dyn RegistryStore, review: &Review, file_count: u32) {
    let result = (|| -> Result<(), String> {
        let mut reg = reg_store.load()?;
        if let Ok(entry) = Repo::open(&review.target.repo_path).and_then(|r| r.repo_entry()) {
            reg.upsert_repo(entry);
        }
        let name = repo_display_name(&review.target.repo_path);
        reg.upsert_review(ReviewEntry::from_review(review, file_count, name));
        reg_store.save(&reg).and_then(|_| sync_vcs_overrides(&reg))
    })();
    if let Err(e) = result {
        eprintln!("[delta] registry sync (open) failed: {e}");
    }
}

/// Refresh the detection-override table from the registry (startup and every
/// registry save). Overrides are keyed by canonical repo root, matching how
/// `vcs::Repo::open` probes them; a root that no longer exists never matches.
/// The registry, for startup wiring (VCS override loading).
pub fn registry_of(app: &tauri::AppHandle) -> Result<Registry, String> {
    reg_store(app)?.load()
}

pub fn sync_vcs_overrides(reg: &Registry) -> Result<(), String> {
    let overrides: HashMap<PathBuf, VcsKind> = reg
        .repos
        .iter()
        .filter_map(|r| {
            r.vcs_override.map(|kind| {
                let root =
                    std::fs::canonicalize(&r.root).unwrap_or_else(|_| PathBuf::from(&r.root));
                (root, kind)
            })
        })
        .collect();
    crate::vcs::set_overrides(overrides);
    Ok(())
}

/// Update counts, preserving the prior file_count (autosave path). Non-fatal.
fn sync_registry_after_save(reg_store: &dyn RegistryStore, review: &Review) {
    let result = (|| -> Result<(), String> {
        let mut reg = reg_store.load()?;
        let prior_file_count = reg
            .reviews
            .iter()
            .find(|e| e.id == review.id)
            .map(|e| e.file_count)
            .unwrap_or(0);
        let name = repo_display_name(&review.target.repo_path);
        reg.upsert_review(ReviewEntry::from_review(review, prior_file_count, name));
        reg_store.save(&reg)
    })();
    if let Err(e) = result {
        eprintln!("[delta] registry sync (save) failed: {e}");
    }
}

#[cfg(test)]
pub fn open_review_impl_with_registry(
    cache: &DiffCache,
    storage: &dyn Storage,
    reg_store: &dyn RegistryStore,
    input: Target,
) -> Result<ReviewSession, String> {
    let session = with_repo_name(open_review_impl(cache, storage, input)?);
    sync_registry_after_open(reg_store, &session.review, session.reviewable_file_count());
    Ok(session)
}

fn with_repo_name(mut session: ReviewSession) -> ReviewSession {
    session.repo_name = repo_display_name(&session.review.target.repo_path);
    session
}

struct RegistrySyncJob {
    reg_store: JsonRegistryStore,
    review: Review,
    file_count: u32,
}

#[derive(Default)]
struct RegistrySyncQueue {
    pending: HashMap<String, RegistrySyncJob>,
    running: bool,
}

static REGISTRY_SYNC: LazyLock<Mutex<RegistrySyncQueue>> = LazyLock::new(Default::default);

fn registry_sync_queue() -> MutexGuard<'static, RegistrySyncQueue> {
    REGISTRY_SYNC.lock().unwrap_or_else(|e| e.into_inner())
}

/// The registry sync rescans every worktree's status — seconds on a huge repo — and
/// the review doesn't depend on it, so it runs after the session is handed back.
/// One worker drains the queue; bursts of refreshes collapse to the latest job per review.
fn sync_registry_in_background(reg_store: JsonRegistryStore, session: &ReviewSession) {
    let job = RegistrySyncJob {
        reg_store,
        review: session.review.clone(),
        file_count: session.reviewable_file_count(),
    };
    let mut queue = registry_sync_queue();
    queue.pending.insert(job.review.id.clone(), job);
    if queue.running {
        return;
    }
    queue.running = true;
    drop(queue);
    tauri::async_runtime::spawn_blocking(drain_registry_sync_queue);
}

fn drain_registry_sync_queue() {
    loop {
        let jobs: Vec<RegistrySyncJob> = {
            let mut queue = registry_sync_queue();
            if queue.pending.is_empty() {
                queue.running = false;
                return;
            }
            queue.pending.drain().map(|(_, job)| job).collect()
        };
        for job in jobs {
            sync_registry_after_open(&job.reg_store, &job.review, job.file_count);
        }
    }
}

pub fn save_review_impl_with_registry(
    cache: &DiffCache,
    storage: &dyn Storage,
    reg_store: &dyn RegistryStore,
    review: Review,
) -> Result<(), String> {
    save_review_impl(cache, storage, review.clone())?;
    sync_registry_after_save(reg_store, &review);
    Ok(())
}

pub fn delete_review_impl(
    storage: &dyn Storage,
    reg_store: &dyn RegistryStore,
    id: &str,
) -> Result<(), String> {
    storage.delete(id)?;
    let mut reg = reg_store.load()?;
    reg.remove_review(id);
    reg_store.save(&reg)
}

#[tauri::command]
pub async fn compute_diff(
    app: tauri::AppHandle,
    target: Target,
    cache: tauri::State<'_, DiffCache>,
) -> Result<DiffSummary, String> {
    let target = with_base_strategy(&app, target);
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.summary(&target))
        .await
        .map_err(|e| format!("compute_diff task: {e}"))?
}

#[tauri::command]
pub async fn get_file_diff(
    app: tauri::AppHandle,
    target: Target,
    path: String,
    cache: tauri::State<'_, DiffCache>,
) -> Result<FileDiff, String> {
    // Served from the memoized snapshot — the whole-repo diff runs once per snapshot,
    // not once per file (the large-review perf fix). (#perf)
    let target = with_base_strategy(&app, target);
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.file(&target, &path))
        .await
        .map_err(|e| format!("get_file_diff task: {e}"))?
}

/// Binary card data (#binary): exact byte sizes per side, resolved from the snapshot.
/// Image bytes are served separately by the `delta-blob` URI scheme.
#[tauri::command]
pub async fn get_binary_file_diff(
    app: tauri::AppHandle,
    target: Target,
    path: String,
    cache: tauri::State<'_, DiffCache>,
) -> Result<BinaryFileDiff, String> {
    let target = with_base_strategy(&app, target);
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        cache
            .with_sources(&target, &path, |repo, s| repo.binary_sizes(s))
            .and_then(|sizes| sizes)
    })
    .await
    .map_err(|e| format!("get_binary_file_diff task: {e}"))?
}

#[tauri::command]
pub async fn list_commits(
    app: tauri::AppHandle,
    target: Target,
    skip: usize,
    limit: usize,
) -> Result<CommitPage, String> {
    let target = with_base_strategy(&app, target);
    tauri::async_runtime::spawn_blocking(move || list_commits_impl(target, skip, limit))
        .await
        .map_err(|e| format!("list_commits task: {e}"))?
}

#[tauri::command]
pub async fn open_review(app: tauri::AppHandle, target: Target) -> Result<ReviewSession, String> {
    let target = with_base_strategy(&app, target);
    let reviews = reviews_dir(&app)?;
    let reg_path = registry_path(&app)?;
    let cache = app.state::<DiffCache>().inner().clone();
    cache.invalidate(&target.repo_path);
    tauri::async_runtime::spawn_blocking(move || {
        let storage = JsonStorage::new(reviews.clone());
        let session = with_repo_name(open_review_impl(&cache, &storage, target)?);
        sync_registry_in_background(JsonRegistryStore::new(reg_path, reviews), &session);
        Ok(session)
    })
    .await
    .map_err(|e| format!("open_review task: {e}"))?
}

#[tauri::command]
pub async fn refresh_review(
    app: tauri::AppHandle,
    mut review: Review,
    cache: tauri::State<'_, DiffCache>,
) -> Result<ReviewSession, String> {
    review.target = with_base_strategy(&app, review.target);
    let cache = cache.inner().clone();
    let reviews = reviews_dir(&app)?;
    let reg_path = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let storage = JsonStorage::new(reviews.clone());
        let session = with_repo_name(refresh_review_impl(&cache, &storage, review)?);
        sync_registry_in_background(JsonRegistryStore::new(reg_path, reviews), &session);
        Ok(session)
    })
    .await
    .map_err(|e| format!("refresh_review task: {e}"))?
}

#[tauri::command]
pub async fn save_review(
    app: tauri::AppHandle,
    review: Review,
    cache: tauri::State<'_, DiffCache>,
) -> Result<(), String> {
    // Async + spawn_blocking (like the diff commands) so persistence never runs on
    // the main thread — a sync command here froze the UI on every comment/viewed save.
    let cache = cache.inner().clone();
    let reviews = reviews_dir(&app)?;
    let reg_path = registry_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let storage = JsonStorage::new(reviews.clone());
        let reg = JsonRegistryStore::new(reg_path, reviews);
        save_review_impl_with_registry(&cache, &storage, &reg, review)
    })
    .await
    .map_err(|e| format!("save_review task: {e}"))?
}

#[tauri::command]
pub fn delete_review(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let storage = JsonStorage::new(reviews_dir(&app)?);
    delete_review_impl(&storage, &reg_store(&app)?, &id)?;
    if let Some(w) = app.get_webview_window(&format!("review-{id}")) {
        let _ = w.close();
    }
    Ok(())
}

#[tauri::command]
pub fn export_review(review: Review) -> Result<String, String> {
    Ok(export_markdown(&review))
}

#[tauri::command]
pub fn list_registry(app: tauri::AppHandle) -> Result<Registry, String> {
    let mut reg = reg_store(&app)?.load()?;
    // Supplied on read only (never persisted) so the UI can render ~-paths.
    reg.home = std::env::var("HOME").ok();
    Ok(reg)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerWorktree {
    #[serde(flatten)]
    pub worktree: WorktreeEntry,
    pub repo_name: String,
    pub repo_id: String,
    /// The stored review that opening this folder resumes — joined by
    /// (path, live branch), so it is exactly the review the user will land in.
    /// Absent when none exists for the currently checked-out branch; reviews
    /// left on branches that have since been switched away from are never
    /// listed (the picker offers folders, not remembered branches).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerData {
    /// Every live worktree of every known repo — the main copy (`is_main`)
    /// plus linked worktrees. The frontend splits them into its two groups.
    pub worktrees: Vec<PickerWorktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
}

/// The live, currently-checked-out worktrees of every known repo, each joined
/// with the review that opening it would resume. A review only matches when its
/// stored branch label equals the worktree's branch *right now* — the review id
/// is (path, branch), so a folder on a different branch opens a different
/// review and the joined one would be a lie. Folders that no longer exist (or
/// whose repo moved) drop out naturally via the live enumeration.
pub fn list_picker_impl(
    reg_store: &dyn RegistryStore,
    home: Option<String>,
) -> Result<PickerData, String> {
    let reg = reg_store.load()?;
    let mut worktrees = Vec::new();
    for repo in &reg.repos {
        // Best-effort: a repo whose worktrees can't be listed (moved/deleted) is skipped.
        let wts = Repo::open(&repo.root)
            .and_then(|r| r.list_worktrees())
            .unwrap_or_default();
        for w in wts {
            let review = reg
                .reviews
                .iter()
                .find(|r| {
                    r.target.repo_path == w.path
                        && r.target.worktree.as_deref() == Some(w.branch.as_str())
                })
                .cloned();
            worktrees.push(PickerWorktree {
                worktree: w,
                repo_name: repo.name.clone(),
                repo_id: repo.id.clone(),
                review,
            });
        }
    }
    Ok(PickerData { worktrees, home })
}

// Async so Tauri runs the git enumeration OFF the main thread. A synchronous command
// blocks the main thread for the whole scan, freezing the UI on every open — which is
// the picker's open latency, paid per call regardless of the frontend cache.
#[tauri::command]
pub async fn list_picker(app: tauri::AppHandle) -> Result<PickerData, String> {
    let home = std::env::var("HOME").ok();
    let store = reg_store(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_picker_impl(&store, home))
        .await
        .map_err(|e| format!("list_picker task failed: {e}"))?
}

#[tauri::command]
pub fn list_worktrees(repo_path: String) -> Result<Vec<WorktreeEntry>, String> {
    Repo::open(&repo_path)?.list_worktrees()
}

/// Every branch (local + remote) with picker metadata — recency, ahead/behind,
/// default/current marks — plus the fork-point suggestion for HEAD. Feeds the
/// base picker in the review toolbar. (#base)
#[tauri::command]
pub async fn list_branches(repo_path: String) -> Result<BranchList, String> {
    tauri::async_runtime::spawn_blocking(move || branches::list_branches(&repo_path))
        .await
        .map_err(|e| format!("list_branches task: {e}"))?
}

#[tauri::command]
pub fn get_base_strategy(
    app: tauri::AppHandle,
    repo_path: String,
) -> Result<Option<BaseStrategy>, String> {
    Ok(repo_base_strategy(&app, &repo_path))
}

/// Set (or clear, with `None`) the repo-wide base strategy. Git only — the
/// caller is the base picker, which never renders for other VCSes. (#base)
#[tauri::command]
pub fn set_base_strategy(
    app: tauri::AppHandle,
    repo_path: String,
    strategy: Option<BaseStrategy>,
) -> Result<(), String> {
    let repo = crate::git::open_repo(&repo_path)
        .map_err(|e| format!("{repo_path} is not a git repository: {e}"))?;
    let id = repo_entry_id(&repo);
    let store = reg_store(&app)?;
    let mut reg = store.load()?;
    let entry = reg
        .repos
        .iter_mut()
        .find(|r| r.id == id)
        .ok_or_else(|| "open this repository in a review window first".to_string())?;
    entry.base_strategy = strategy;
    store.save(&reg)
}

#[tauri::command]
pub async fn import_repo(app: tauri::AppHandle) -> Result<Option<RepoEntry>, String> {
    // The native folder dialog blocks on a sync channel and must run OFF the main
    // thread — calling it from a synchronous command (which runs on the main thread)
    // freezes the event loop (the app beachballs). Run it on the blocking pool so the
    // main thread stays free to drive the dialog.
    let dialog_app = app.clone();
    let folder = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("dialog task: {e}"))?;

    let Some(folder) = folder else {
        return Ok(None);
    };
    let repo_path = folder
        .into_path()
        .map_err(|e| format!("dialog path: {e}"))?
        .display()
        .to_string();
    // Reject a non-repo selection with a clean, user-facing message (the UI shows it in
    // a modal) rather than the raw backend error repo_entry would surface. Detection
    // walks up, so picking a subdir of a repo still imports that repo.
    let entry = match Repo::open(&repo_path) {
        Ok(repo) => repo.repo_entry()?,
        Err(_) => return Err(format!("{repo_path} is not a git or svn working copy.")),
    };
    let store = reg_store(&app)?;
    let mut reg = store.load()?;
    reg.upsert_repo(entry.clone());
    store.save(&reg).and_then(|_| sync_vcs_overrides(&reg))?;
    Ok(Some(entry))
}

#[tauri::command]
// Async on purpose: Tauri runs a synchronous command on the main thread, and creating
// a window there deadlocks — the builder waits for an event loop that is busy running
// this very command, and every later IPC call queues behind it forever.
pub async fn open_target(
    app: tauri::AppHandle,
    repo_path: String,
    mode: DiffMode,
    base: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_target_window(&app, &repo_path, mode, base).map(|_| ())
    })
    .await
    .map_err(|e| format!("open target task: {e}"))?
}

/// Re-point the calling window's fs watcher at `repo_path`'s worktree — used when
/// a review window navigates in place ("replace current" picker mode). (#replace)
#[tauri::command]
pub fn rewatch_window(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    repo_path: String,
) -> Result<(), String> {
    rewatch_target(&app, window.label(), &repo_path)
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Settings {
    crate::settings::load(&app)
}

#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    crate::settings::save(&app, &settings)
}

/// Where the global Delta Ignore file lives (app data dir). Also wired into the
/// ignore engine at startup — see lib.rs setup.
pub fn global_deltaignore_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join(crate::git::deltaignore::GLOBAL_DELTAIGNORE_FILE))
}

/// Delta Ignore sources, editable from Settings: the global rules (every repo
/// on this machine) and this checkout's never-committed local rules (git:
/// `<git dir>/info/deltaignore`, like git's `info/exclude`; SVN: the app data
/// dir). Saving bumps the rules epoch, invalidates the affected diff
/// snapshots, and tells open review windows like an fs change so they offer
/// Refresh.

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "storage")]
pub enum LocalDeltaIgnore {
    GitInfo { rules: String },
    AppData { rules: String },
}

#[tauri::command]
pub fn get_global_delta_ignore() -> String {
    crate::git::deltaignore::DeltaIgnore::global_rules()
}

#[tauri::command]
pub fn set_global_delta_ignore(
    app: tauri::AppHandle,
    cache: tauri::State<'_, DiffCache>,
    rules: String,
) -> Result<(), String> {
    let path = global_deltaignore_path(&app)?;
    crate::git::deltaignore::DeltaIgnore::write_global_rules(&path, &rules)?;
    crate::git::deltaignore::notify_rules_changed();
    cache.invalidate_all();
    crate::watch::emit_ignore_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn get_local_delta_ignore(repo_path: String) -> Result<LocalDeltaIgnore, String> {
    use crate::git::deltaignore::DeltaIgnore;
    match Repo::open(&repo_path)? {
        Repo::Git(repo) => Ok(LocalDeltaIgnore::GitInfo {
            rules: DeltaIgnore::local_rules(&repo),
        }),
        Repo::Svn(svn) => Ok(LocalDeltaIgnore::AppData {
            rules: DeltaIgnore::svn_local_rules(svn.root()),
        }),
    }
}

#[tauri::command]
pub fn set_local_delta_ignore(
    app: tauri::AppHandle,
    cache: tauri::State<'_, DiffCache>,
    repo_path: String,
    rules: String,
) -> Result<(), String> {
    use crate::git::deltaignore::DeltaIgnore;
    match Repo::open(&repo_path)? {
        Repo::Git(repo) => DeltaIgnore::write_local_rules(&repo, &rules)?,
        Repo::Svn(svn) => DeltaIgnore::write_svn_local_rules(svn.root(), &rules)?,
    }
    crate::git::deltaignore::notify_rules_changed();
    cache.invalidate(&repo_path);
    crate::watch::emit_ignore_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn install_cli() -> Result<InstallOutcome, String> {
    launch_install_cli()
}

#[tauri::command]
pub fn cli_status() -> CliStatus {
    launch_cli_status()
}

// "Open in your editor" (#editor). Each curated editor maps to a CLI; where the
// CLI supports it, `line` jumps to that line. Pure so it's unit-testable.
fn editor_invocation(
    editor: &str,
    path: &str,
    line: Option<u32>,
) -> Result<(&'static str, Vec<String>), String> {
    let prog = match editor {
        "vscode" => "code",
        "cursor" => "cursor",
        "zed" => "zed",
        "sublime" => "subl",
        "intellij" => "idea",
        other => return Err(format!("Unknown editor: {other}")),
    };
    let args: Vec<String> = match (editor, line) {
        // VS Code / Cursor: `-g <path>:<line>` opens and goes to the line.
        ("vscode", Some(l)) | ("cursor", Some(l)) => vec!["-g".into(), format!("{path}:{l}")],
        // Zed / Sublime accept `<path>:<line>` directly.
        ("zed", Some(l)) | ("sublime", Some(l)) => vec![format!("{path}:{l}")],
        ("intellij", Some(l)) => vec!["--line".into(), l.to_string(), path.into()],
        _ => vec![path.into()],
    };
    Ok((prog, args))
}

/// Resolve an editor CLI to an absolute path. A GUI-launched macOS app inherits a
/// minimal PATH, so search the usual install dirs on top of $PATH.
fn resolve_program(prog: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(&home).join(".local/bin"));
        dirs.push(PathBuf::from(&home).join("bin"));
    }
    dirs.into_iter().map(|d| d.join(prog)).find(|c| c.is_file())
}

#[tauri::command]
pub fn open_in_editor(
    editor: String,
    repo_path: String,
    file: Option<String>,
    line: Option<u32>,
) -> Result<(), String> {
    // file omitted → open the repo/worktree root; otherwise join it onto the root.
    let target = match file {
        Some(f) => PathBuf::from(&repo_path).join(f),
        None => PathBuf::from(&repo_path),
    };
    let (prog, args) = editor_invocation(&editor, &target.to_string_lossy(), line)?;
    let resolved = resolve_program(prog).ok_or_else(|| {
        format!("Couldn't find the '{prog}' command on your PATH. Install {editor}'s shell command and try again.")
    })?;
    std::process::Command::new(resolved)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("launch {editor}: {e}"))
}

#[tauri::command]
pub fn edit_file_line(
    target: Target,
    path: String,
    line: u32,
    expected: String,
    replacement: String,
) -> Result<(), String> {
    crate::edit::edit_file_line(&target, &path, line, &expected, &replacement)
}

#[tauri::command]
pub fn read_file_text(target: Target, path: String) -> Result<crate::edit::FileText, String> {
    crate::edit::read_file_text(&target, &path)
}

#[tauri::command]
pub fn write_file_text(
    target: Target,
    path: String,
    expected_hash: String,
    content: String,
) -> Result<crate::edit::FileText, String> {
    crate::edit::write_file_text(&target, &path, &expected_hash, &content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;
    use crate::review::model::{Comment, CommentScope};
    use crate::storage::{JsonRegistryStore, RegistryStore};

    fn stores(dir: &std::path::Path) -> (JsonStorage, JsonRegistryStore) {
        let reviews = dir.join("reviews");
        (
            JsonStorage::new(reviews.clone()),
            JsonRegistryStore::new(dir.join("registry.json"), reviews),
        )
    }

    #[test]
    fn fill_base_from_strategy_respects_the_cascade() {
        let t = |base: Option<&str>| Target {
            repo_path: "/r".into(),
            worktree: None,
            mode: DiffMode::BranchVsBase,
            base: base.map(str::to_string),
            commit: None,
        };
        // Explicit base wins over any strategy.
        let explicit = fill_base_from_strategy(
            t(Some("main")),
            Some(&BaseStrategy::Branch { name: "dev".into() }),
        );
        assert_eq!(explicit.base.as_deref(), Some("main"));
        // A pinned strategy fills an implicit base.
        let pinned =
            fill_base_from_strategy(t(None), Some(&BaseStrategy::Branch { name: "dev".into() }));
        assert_eq!(pinned.base.as_deref(), Some("dev"));
        // Auto (and no strategy) stays implicit — the fork heuristic resolves it.
        assert_eq!(
            fill_base_from_strategy(t(None), Some(&BaseStrategy::Auto)).base,
            None
        );
        assert_eq!(fill_base_from_strategy(t(None), None).base, None);
    }

    #[test]
    fn list_picker_lists_folders_once_with_the_review_that_would_open() {
        let (dir, repo) = repo_with_commit(); // main worktree on "main"
        add_worktree(&repo, dir.path(), "demo-feat", "feat/a"); // linked worktree "feat/a"
        let root = dir.path().to_str().unwrap().to_string();

        let store_dir = tempfile::TempDir::new().unwrap();
        let (_storage, reg_store) = stores(store_dir.path());
        let entry = Repo::open(&root).unwrap().repo_entry().unwrap();
        let repo_name = entry.name.clone();
        // The path as the app itself would persist it (canonical, from open_target_window).
        let main_path = entry
            .worktrees
            .iter()
            .find(|w| w.is_main)
            .unwrap()
            .path
            .clone();
        let mut reg = reg_store.load().unwrap();
        reg.upsert_repo(entry);
        let review = |id: &str, path: String, branch: &str| ReviewEntry {
            id: id.into(),
            repo_name: repo_name.clone(),
            target: Target {
                repo_path: path,
                worktree: Some(branch.into()),
                mode: DiffMode::AllChanges,
                base: None,
                commit: None,
            },
            last_opened_at: "t".into(),
            comment_count: 1,
            stale_count: 0,
            resolved_count: 0,
            viewed_count: 0,
            file_count: 1,
        };
        // The review that matches the folder's CURRENT branch — this one opens.
        reg.upsert_review(review("rev1", main_path.clone(), "main"));
        // Reviews left on branches this folder has since switched away from —
        // stale memory, must not surface as separate picker rows.
        reg.upsert_review(review("rev2", main_path, "feat/merged-long-ago"));
        reg_store.save(&reg).unwrap();

        let data = list_picker_impl(&reg_store, Some("/Users/me".into())).unwrap();
        // One row per folder — the main copy and the linked worktree — never one
        // per remembered branch.
        assert_eq!(data.worktrees.len(), 2);
        let main = data.worktrees.iter().find(|w| w.worktree.is_main).unwrap();
        assert_eq!(main.worktree.branch, "main");
        assert_eq!(main.review.as_ref().unwrap().id, "rev1");
        let linked = data.worktrees.iter().find(|w| !w.worktree.is_main).unwrap();
        assert_eq!(linked.worktree.branch, "feat/a");
        assert!(
            linked.review.is_none(),
            "no review exists for the linked worktree's current branch"
        );
        assert_eq!(data.worktrees[0].repo_name, repo_name);
        assert_eq!(data.home.as_deref(), Some("/Users/me"));
    }

    #[test]
    fn list_picker_joins_reviews_by_branch_across_worktrees() {
        // A review opened in a linked worktree joins that worktree's row, keyed by
        // (path, branch) — not by repo + branch, which would swallow unrelated rows.
        let (dir, repo) = repo_with_commit(); // main on "main"
        add_worktree(&repo, dir.path(), "demo-feat", "feat/a");
        let root = dir.path().to_str().unwrap().to_string();

        let store_dir = tempfile::TempDir::new().unwrap();
        let (_storage, reg_store) = stores(store_dir.path());
        let entry = Repo::open(&root).unwrap().repo_entry().unwrap();
        let repo_name = entry.name.clone();
        // The live worktree path as enumeration will report it.
        let wt_path = entry
            .worktrees
            .iter()
            .find(|w| !w.is_main)
            .unwrap()
            .path
            .clone();
        let mut reg = reg_store.load().unwrap();
        reg.upsert_repo(entry);
        reg.upsert_review(ReviewEntry {
            id: "rev-wt".into(),
            repo_name,
            target: Target {
                repo_path: wt_path,
                worktree: Some("feat/a".into()),
                mode: DiffMode::Uncommitted,
                base: None,
                commit: None,
            },
            last_opened_at: "t".into(),
            comment_count: 0,
            stale_count: 0,
            resolved_count: 0,
            viewed_count: 0,
            file_count: 1,
        });
        reg_store.save(&reg).unwrap();

        let data = list_picker_impl(&reg_store, None).unwrap();
        assert_eq!(data.worktrees.len(), 2);
        let linked = data.worktrees.iter().find(|w| !w.worktree.is_main).unwrap();
        assert_eq!(linked.review.as_ref().unwrap().id, "rev-wt");
        let main = data.worktrees.iter().find(|w| w.worktree.is_main).unwrap();
        assert!(
            main.review.is_none(),
            "the linked worktree's review must not join the main row"
        );
    }

    #[test]
    fn compute_diff_command_returns_summary() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "a\nb\n");
        // The command serves the summary from the DiffCache (same path the IPC uses).
        let summary = DiffCache::default()
            .summary(&Target {
                repo_path: dir.path().to_str().unwrap().into(),
                worktree: None,
                mode: DiffMode::Uncommitted,
                base: None,
                commit: None,
            })
            .unwrap();
        assert_eq!(summary.files.len(), 1);
    }

    #[test]
    fn open_review_impl_creates_persists_and_reanchors() {
        use crate::storage::{JsonStorage, Storage};

        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));

        let target = Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };
        let session = open_review_impl(&DiffCache::default(), &storage, target).unwrap();

        assert!(session.summary.files.iter().any(|f| f.path == "file.txt"));
        assert_eq!(session.review.target.worktree.as_deref(), Some("main"));
        // persisted under the deterministic id
        let loaded = storage.load(&session.review.id).unwrap();
        assert!(loaded.is_some());
    }

    #[test]
    fn save_review_impl_persists() {
        use crate::storage::{JsonStorage, Storage};

        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let now = chrono::Utc::now().to_rfc3339();

        let target = Target {
            repo_path: "/repo".into(),
            worktree: Some("main".into()),
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };
        let snapshot = Snapshot {
            base_oid: "abc123".into(),
            head_oid: None,
            head_commit: None,
            captured_at: now.clone(),
        };
        let review = Review::new("0123456789abcdef".into(), target, snapshot, now);

        save_review_impl(&DiffCache::default(), &storage, review.clone()).unwrap();
        let loaded = storage.load(&review.id).unwrap();
        assert!(loaded.is_some());
        assert_eq!(loaded.unwrap().id, "0123456789abcdef");
    }

    #[test]
    fn refresh_review_impl_reconciles_and_persists() {
        use crate::storage::{JsonStorage, Storage};

        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));

        let target = Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };
        let session = open_review_impl(&DiffCache::default(), &storage, target).unwrap();

        let refreshed =
            refresh_review_impl(&DiffCache::default(), &storage, session.review.clone()).unwrap();
        assert!(!refreshed.summary.files.is_empty());
        let persisted = storage.load(&session.review.id).unwrap();
        assert!(persisted.is_some());
    }

    #[test]
    fn refresh_drops_viewed_when_a_just_toggled_file_changed_under_it() {
        use crate::review::model::ViewedEntry;
        use crate::storage::JsonStorage;

        // The unsaved-toggle race: the user toggles viewed while looking at the
        // old diff, the agent's edit lands on disk, and the fs-change refresh
        // reaches storage before the toggle's own save does. Refreshing must not
        // lazily stamp the *new* content as the viewed baseline — the file changed
        // since it was viewed, so the mark must drop.
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nAAA\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };

        // The review the user has open. The diff pane fetched the file — the
        // served snapshot is AAA, the version on screen.
        let opened = open_review_impl(&DiffCache::default(), &storage, target).unwrap();
        let cache = DiffCache::default();
        cache.file(&opened.review.target, "file.txt").unwrap();

        // The user toggles viewed; the toggle's save is still in flight, so disk
        // has no viewed entry for refresh to adopt.
        let mut fe = opened.review.clone();
        fe.viewed.push(ViewedEntry {
            file: "file.txt".into(),
            diff_hash: String::new(),
        });

        // The agent's edit lands; the watcher's refresh wins the race with the save.
        write(dir.path(), "file.txt", "line1\nBBB\nline2\n");

        let refreshed = refresh_review_impl(&cache, &storage, fe).unwrap();
        assert_eq!(
            refreshed.review.viewed.len(), 0,
            "a file whose diff changed since it was viewed must lose its mark, even when the toggle's save hasn't landed",
        );
    }

    #[test]
    fn refresh_keeps_persisted_comments_when_frontend_copy_is_stale() {
        use crate::storage::{JsonStorage, Storage};

        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };

        let note = |id: &str, body: &str| Comment {
            id: id.into(),
            scope: CommentScope::General,
            anchor: None,
            body: body.into(),
            stale: false,
            resolved: false,
            commit: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        };
        let ids = |cs: &[Comment]| cs.iter().map(|c| c.id.clone()).collect::<Vec<_>>();

        // Two comments are created and persisted — the on-disk review is the source of truth.
        let mut review = open_review_impl(&DiffCache::default(), &storage, target)
            .unwrap()
            .review;
        review.comments = vec![note("c1", "first"), note("c2", "second")];
        save_review_impl(&DiffCache::default(), &storage, review.clone()).unwrap();

        // The frontend hands refresh a STALE copy missing the second comment — its
        // reviewRef lagged a just-added comment. A refresh (fired on any fs event)
        // must not persist this reduced set and drop the comment.
        let mut stale = review.clone();
        stale.comments = vec![note("c1", "first")];

        let refreshed = refresh_review_impl(&DiffCache::default(), &storage, stale).unwrap();

        assert_eq!(
            ids(&refreshed.review.comments),
            vec!["c1", "c2"],
            "refresh must not drop a persisted comment missing from a stale FE copy"
        );
        let persisted = storage.load(&review.id).unwrap().unwrap();
        assert_eq!(
            ids(&persisted.comments),
            vec!["c1", "c2"],
            "the on-disk review must still hold both comments after refresh"
        );
    }

    #[test]
    fn refresh_keeps_file_scoped_comments_and_marks_gone_ones_stale_not_dropped() {
        use crate::review::model::{Anchor, Side};
        use crate::storage::{JsonStorage, Storage};

        // file.txt is in the diff; other.txt is not touched, so it's absent from it.
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };

        // A file-scoped comment: an anchor with a file + side but no line/snippet.
        let file_note = |id: &str, file: &str| Comment {
            id: id.into(),
            scope: CommentScope::File,
            anchor: Some(Anchor {
                file: file.into(),
                side: Side::New,
                start_line: None,
                end_line: None,
                snippet: None,
            }),
            body: "note".into(),
            stale: false,
            resolved: false,
            commit: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        };
        let ids = |cs: &[Comment]| cs.iter().map(|c| c.id.clone()).collect::<Vec<_>>();

        let mut review = open_review_impl(&DiffCache::default(), &storage, target)
            .unwrap()
            .review;
        review.comments = vec![
            file_note("in-diff", "file.txt"),
            file_note("gone", "other.txt"),
        ];
        save_review_impl(&DiffCache::default(), &storage, review.clone()).unwrap();

        // Stale FE copy dropped both file-scoped comments.
        let mut stale = review.clone();
        stale.comments = vec![];

        let refreshed = refresh_review_impl(&DiffCache::default(), &storage, stale).unwrap();

        // Both survive on disk; the one whose file left the diff is flagged stale, not removed.
        assert_eq!(
            ids(&refreshed.review.comments),
            vec!["in-diff", "gone"],
            "file-scoped comments must not be dropped by a refresh"
        );
        let by_id = |id: &str| {
            refreshed
                .review
                .comments
                .iter()
                .find(|c| c.id == id)
                .unwrap()
        };
        assert!(
            !by_id("in-diff").stale,
            "a file-scoped comment on a file still in the diff stays fresh"
        );
        assert!(
            by_id("gone").stale,
            "a file-scoped comment whose file left the diff is marked stale — but kept"
        );
        assert_eq!(
            storage.load(&review.id).unwrap().unwrap().comments.len(),
            2,
            "both file-scoped comments persist"
        );
    }

    #[test]
    fn refresh_hands_untagged_comments_to_the_commit_that_took_their_file() {
        use crate::review::model::{Anchor, Comment, CommentScope, Side};
        use crate::storage::{JsonStorage, Storage};

        // The review-before-commit flow: open while the work is uncommitted,
        // comment on it, the agent commits, and the fs watcher fires a refresh.
        let (dir, repo) = repo_with_commit(); // main @ initial
        write(dir.path(), "file.txt", "line1\nADDED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };

        let mut review = open_review_impl(&DiffCache::default(), &storage, target)
            .unwrap()
            .review;
        review.comments.push(Comment {
            id: "c1".into(),
            scope: CommentScope::Line,
            anchor: Some(Anchor {
                file: "file.txt".into(),
                side: Side::New,
                start_line: Some(2),
                end_line: None,
                snippet: Some("ADDED".into()),
            }),
            body: "why?".into(),
            stale: false,
            resolved: false,
            commit: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        });
        save_review_impl(&DiffCache::default(), &storage, review.clone()).unwrap();

        // The agent commits the reviewed work.
        let oid = commit_all(&repo, "agent work");

        let refreshed = refresh_review_impl(&DiffCache::default(), &storage, review).unwrap();
        let c = &refreshed.review.comments[0];
        assert_eq!(
            c.commit.as_deref(),
            Some(oid.to_string().as_str()),
            "refresh hands the comment to the commit that took its file"
        );
        assert!(!c.stale, "the handed-off comment is fresh");
        assert_eq!(
            storage
                .load(&refreshed.review.id)
                .unwrap()
                .unwrap()
                .comments[0]
                .commit
                .as_deref(),
            Some(oid.to_string().as_str()),
            "the handoff persists",
        );
    }

    #[test]
    fn save_stamps_empty_viewed_baseline_before_persisting() {
        use crate::review::model::ViewedEntry;
        use crate::storage::{JsonStorage, Storage};

        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };
        let session = open_review_impl(&DiffCache::default(), &storage, target).unwrap();
        let mut review = session.review;

        // The diff pane fetches the file — that fetch is what the user is looking at.
        let cache = DiffCache::default();
        cache.file(&review.target, "file.txt").unwrap();

        // The FE toggles "viewed" with an empty hash (it doesn't compute the baseline).
        review.viewed.push(ViewedEntry {
            file: "file.txt".into(),
            diff_hash: String::new(),
        });
        save_review_impl(&cache, &storage, review.clone()).unwrap();

        // Save must have stamped the baseline from the served content.
        let persisted = storage.load(&review.id).unwrap().unwrap();
        assert!(
            !persisted.viewed[0].diff_hash.is_empty(),
            "save must stamp the baseline hash before persisting"
        );
    }

    #[test]
    fn refresh_unviews_a_file_that_changed_after_being_marked_viewed() {
        use crate::review::model::ViewedEntry;
        use crate::storage::JsonStorage;

        // file.txt is in the diff at V1 — the version the user reviews.
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nV1\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let storage = JsonStorage::new(store_dir.path().join("reviews"));
        let target = Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };
        let session = open_review_impl(&DiffCache::default(), &storage, target).unwrap();
        let mut review = session.review;

        // The diff pane fetched V1 — the served snapshot the user is looking at.
        let cache = DiffCache::default();
        cache.file(&review.target, "file.txt").unwrap();

        // User marks file.txt viewed. The FE persists an entry with an empty hash;
        // save runs immediately, while the file is still at V1.
        review.viewed.push(ViewedEntry {
            file: "file.txt".into(),
            diff_hash: String::new(),
        });
        save_review_impl(&cache, &storage, review.clone()).unwrap();

        // The file changes to V2 before the next refresh (e.g. an agent edits it).
        write(dir.path(), "file.txt", "line1\nV2\nline2\n");

        // Refresh reconciles the review the FE holds in memory — which still carries
        // the empty hash. It must still drop the viewed entry, because the file
        // changed since the user marked it viewed.
        let refreshed = refresh_review_impl(&cache, &storage, review).unwrap();
        assert_eq!(
            refreshed.review.viewed.len(),
            0,
            "a file changed after being viewed must be un-viewed on refresh"
        );
    }

    #[test]
    fn open_review_populates_registry_with_file_count() {
        let (repo_dir, _r) = repo_with_commit();
        write(repo_dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let (storage, reg_store) = stores(store_dir.path());
        let target = Target {
            repo_path: repo_dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };

        let session =
            open_review_impl_with_registry(&DiffCache::default(), &storage, &reg_store, target)
                .unwrap();

        let reg = reg_store.load().unwrap();
        let entry = reg
            .reviews
            .iter()
            .find(|e| e.id == session.review.id)
            .expect("review entry");
        assert_eq!(entry.file_count, session.summary.files.len() as u32);
        assert!(reg.repos.iter().any(|r| !r.worktrees.is_empty()));
    }

    #[test]
    fn save_review_preserves_file_count() {
        let (repo_dir, _r) = repo_with_commit();
        write(repo_dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let (storage, reg_store) = stores(store_dir.path());
        let target = Target {
            repo_path: repo_dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };
        let session =
            open_review_impl_with_registry(&DiffCache::default(), &storage, &reg_store, target)
                .unwrap();
        let original_file_count = session.summary.files.len() as u32;

        let mut review = session.review.clone();
        review.comments.push(Comment {
            id: "c1".into(),
            scope: CommentScope::Line,
            anchor: None,
            body: "hi".into(),
            stale: false,
            resolved: false,
            commit: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        });
        save_review_impl_with_registry(&DiffCache::default(), &storage, &reg_store, review)
            .unwrap();

        let reg = reg_store.load().unwrap();
        let entry = reg
            .reviews
            .iter()
            .find(|e| e.id == session.review.id)
            .unwrap();
        assert_eq!(
            entry.file_count, original_file_count,
            "file_count preserved across save"
        );
        assert_eq!(entry.comment_count, 1);
    }

    #[test]
    fn editor_invocation_builds_line_aware_args() {
        assert_eq!(
            editor_invocation("vscode", "/a/b.ts", Some(42)).unwrap(),
            ("code", vec!["-g".to_string(), "/a/b.ts:42".to_string()])
        );
        assert_eq!(
            editor_invocation("zed", "/a/b.ts", Some(7)).unwrap(),
            ("zed", vec!["/a/b.ts:7".to_string()])
        );
        assert_eq!(
            editor_invocation("intellij", "/a/b.ts", Some(3)).unwrap(),
            (
                "idea",
                vec!["--line".to_string(), "3".to_string(), "/a/b.ts".to_string()]
            )
        );
        // No line → just the path (e.g. opening the repo root).
        assert_eq!(
            editor_invocation("vscode", "/repo", None).unwrap(),
            ("code", vec!["/repo".to_string()])
        );
        assert!(editor_invocation("emacs", "/a", None).is_err());
    }

    #[test]
    fn delete_review_removes_file_and_entry() {
        let (repo_dir, _r) = repo_with_commit();
        write(repo_dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let store_dir = tempfile::TempDir::new().unwrap();
        let (storage, reg_store) = stores(store_dir.path());
        let target = Target {
            repo_path: repo_dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };
        let session =
            open_review_impl_with_registry(&DiffCache::default(), &storage, &reg_store, target)
                .unwrap();

        delete_review_impl(&storage, &reg_store, &session.review.id).unwrap();

        assert!(storage.load(&session.review.id).unwrap().is_none());
        assert!(reg_store
            .load()
            .unwrap()
            .reviews
            .iter()
            .all(|e| e.id != session.review.id));
    }
}

#[cfg(test)]
mod telemetry_tests {
    use super::telemetry_allowed_from_env;

    #[test]
    fn allowed_by_default() {
        assert!(telemetry_allowed_from_env(None, None));
    }

    #[test]
    fn do_not_track_disables() {
        assert!(!telemetry_allowed_from_env(Some("1"), None));
        assert!(!telemetry_allowed_from_env(Some("true"), None));
        assert!(!telemetry_allowed_from_env(Some("TRUE"), None));
    }

    #[test]
    fn do_not_track_zero_is_not_opt_out() {
        assert!(telemetry_allowed_from_env(Some("0"), None));
    }

    #[test]
    fn delta_telemetry_off_disables() {
        assert!(!telemetry_allowed_from_env(None, Some("0")));
        assert!(!telemetry_allowed_from_env(None, Some("false")));
    }

    #[test]
    fn delta_telemetry_on_stays_enabled() {
        assert!(telemetry_allowed_from_env(None, Some("1")));
    }
}
