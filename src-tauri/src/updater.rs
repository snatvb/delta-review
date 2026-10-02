//! Process-owned self-update orchestration. The check and the download live
//! HERE, not in any window's JS: a download started from the launcher must
//! survive the launcher closing (the home window is closed when a review
//! opens), and every window — home and reviews alike — must see the same
//! update state. Windows pull the current snapshot via `updater_status` on
//! mount and follow the `updater:state` broadcasts thereafter. This replaces
//! the old per-window leader election (#updater-race): there is exactly one
//! owner now, the process itself, so there is nothing to elect.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Broadcast channel: every phase/progress transition is emitted app-wide.
pub const STATE_EVENT: &str = "updater:state";

/// Progress broadcasts are throttled to at most one per interval.
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdaterStatus {
    #[default]
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Error,
}

/// The snapshot every window renders (banner + Settings → About).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterSnapshot {
    pub status: UpdaterStatus,
    pub version: Option<String>,
    /// 0..1 while downloading; None = indeterminate / not downloading.
    pub progress: Option<f64>,
    /// Unix ms of the last completed check (found or not); None before any.
    pub last_checked_at: Option<i64>,
}

struct UpdaterInner {
    snapshot: UpdaterSnapshot,
    /// The found update awaiting `updater_download`; taken by the download task.
    update: Option<Update>,
    /// Whether any check already ran this process. The mount-time auto check
    /// (manual=false) runs at most once; manual checks always re-run.
    checked_this_process: bool,
}

impl Default for UpdaterInner {
    fn default() -> Self {
        Self {
            snapshot: UpdaterSnapshot::default(),
            update: None,
            checked_this_process: false,
        }
    }
}

/// Managed state. Cloned into the download task so the download outlives any
/// window (the task owns its `Update` handle — it is NOT tied to a webview's
/// resource table, which is what died with the launcher before).
#[derive(Default, Clone)]
pub struct UpdaterShared(Arc<Mutex<UpdaterInner>>);

fn lock(shared: &UpdaterShared) -> MutexGuard<'_, UpdaterInner> {
    shared.0.lock().unwrap_or_else(|e| e.into_inner())
}

/// Pure decision for `updater_check`: should this call actually hit the
/// network, given the current status and whether any check already ran?
/// - A check already in flight, a pending update, or a download/ready update
///   makes it a no-op (the snapshot is returned untouched).
/// - The mount-time auto check (manual=false) runs at most once per process;
///   manual checks (the Settings button, the periodic timer) always re-run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckDecision {
    Run,
    Skip,
}

pub fn should_check(
    status: UpdaterStatus,
    manual: bool,
    checked_this_process: bool,
) -> CheckDecision {
    match status {
        UpdaterStatus::Checking
        | UpdaterStatus::Available
        | UpdaterStatus::Downloading
        | UpdaterStatus::Ready => CheckDecision::Skip,
        UpdaterStatus::Idle | UpdaterStatus::Error => {
            if manual || !checked_this_process {
                CheckDecision::Run
            } else {
                CheckDecision::Skip
            }
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Mutate the snapshot under the lock, then broadcast it to every window.
fn publish(app: &AppHandle, shared: &UpdaterShared, mutate: impl FnOnce(&mut UpdaterSnapshot)) {
    let snapshot = {
        let mut inner = lock(shared);
        mutate(&mut inner.snapshot);
        inner.snapshot.clone()
    };
    let _ = app.emit(STATE_EVENT, &snapshot);
}

#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    shared: State<'_, UpdaterShared>,
    manual: bool,
) -> Result<UpdaterSnapshot, String> {
    // Decide under the lock; the network check runs outside it so a second
    // window's concurrent call sees `checking` and returns instead of racing.
    let checking = {
        let mut inner = lock(&shared);
        match should_check(inner.snapshot.status, manual, inner.checked_this_process) {
            CheckDecision::Skip => return Ok(inner.snapshot.clone()),
            CheckDecision::Run => {
                inner.snapshot.status = UpdaterStatus::Checking;
                inner.checked_this_process = true;
                inner.snapshot.clone()
            }
        }
    };
    let _ = app.emit(STATE_EVENT, &checking);

    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string());

    let snapshot = {
        let mut inner = lock(&shared);
        inner.snapshot.last_checked_at = Some(now_ms());
        match &found {
            Ok(Some(update)) => {
                inner.snapshot.status = UpdaterStatus::Available;
                inner.snapshot.version = Some(update.version.clone());
                inner.update = Some(update.clone());
            }
            Ok(None) => {
                inner.snapshot.status = UpdaterStatus::Idle;
                inner.snapshot.version = None;
                inner.snapshot.progress = None;
            }
            Err(e) => {
                eprintln!("[delta] updater check failed: {e}");
                inner.snapshot.status = UpdaterStatus::Error;
            }
        }
        inner.snapshot.clone()
    };
    let _ = app.emit(STATE_EVENT, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn updater_download(
    app: AppHandle,
    shared: State<'_, UpdaterShared>,
) -> Result<UpdaterSnapshot, String> {
    let (update, snapshot) = {
        let mut inner = lock(&shared);
        match inner.snapshot.status {
            // Another window's click is already driving the download.
            UpdaterStatus::Downloading | UpdaterStatus::Ready => return Ok(inner.snapshot.clone()),
            UpdaterStatus::Available => {}
            other => return Err(format!("no update to download (status {other:?})")),
        }
        let update = inner
            .update
            .take()
            .expect("Available status implies a stored update");
        inner.snapshot.status = UpdaterStatus::Downloading;
        inner.snapshot.progress = None;
        let snapshot = inner.snapshot.clone();
        (update, snapshot)
    };
    let _ = app.emit(STATE_EVENT, &snapshot);

    // The task owns the download: the command returns immediately (no window's
    // JS awaits megabytes), and the transfer keeps running even if every
    // window that knows about it closes.
    let task_shared = shared.inner().clone();
    tauri::async_runtime::spawn(async move {
        run_download(&app, &task_shared, update).await;
    });
    Ok(snapshot)
}

async fn run_download(app: &AppHandle, shared: &UpdaterShared, update: Update) {
    let result = {
        let app = app.clone();
        let shared = shared.clone();
        let mut downloaded: u64 = 0;
        let mut total: Option<u64> = None;
        let mut emitted_at: Option<Instant> = None;
        update
            .download_and_install(
                move |chunk_len, content_length| {
                    if let Some(t) = content_length {
                        total = Some(t);
                    }
                    downloaded += chunk_len as u64;
                    // The first chunk announces the transfer (and its size);
                    // after that, at most one broadcast per PROGRESS_EVERY.
                    let due = emitted_at.map_or(true, |t| t.elapsed() >= PROGRESS_EVERY);
                    if !due {
                        return;
                    }
                    emitted_at = Some(Instant::now());
                    let progress = total
                        .filter(|t| *t > 0)
                        .map(|t| (downloaded as f64 / t as f64).min(1.0));
                    publish(&app, &shared, |s| s.progress = progress);
                },
                || {},
            )
            .await
    };

    if let Err(e) = &result {
        eprintln!("[delta] updater download failed: {e}");
    }
    publish(app, shared, |s| match result {
        Ok(()) => {
            s.status = UpdaterStatus::Ready;
            s.progress = Some(1.0);
        }
        Err(_) => s.status = UpdaterStatus::Error,
    });
}

#[tauri::command]
pub fn updater_status(shared: State<'_, UpdaterShared>) -> UpdaterSnapshot {
    lock(&shared).snapshot.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_check_skips_in_flight_and_terminal_phases() {
        for status in [
            UpdaterStatus::Checking,
            UpdaterStatus::Available,
            UpdaterStatus::Downloading,
            UpdaterStatus::Ready,
        ] {
            assert_eq!(
                should_check(status, false, false),
                CheckDecision::Skip,
                "{status:?} auto"
            );
            assert_eq!(
                should_check(status, true, false),
                CheckDecision::Skip,
                "{status:?} manual"
            );
        }
    }

    #[test]
    fn auto_check_runs_once_per_process_and_manual_always_re_runs() {
        // First auto check of the process runs.
        assert_eq!(
            should_check(UpdaterStatus::Idle, false, false),
            CheckDecision::Run
        );
        // A second window's mount-time auto check is a no-op.
        assert_eq!(
            should_check(UpdaterStatus::Idle, false, true),
            CheckDecision::Skip
        );
        // Manual checks (Settings button, periodic timer) bypass the once guard.
        assert_eq!(
            should_check(UpdaterStatus::Idle, true, true),
            CheckDecision::Run
        );
        // An error from an auto check is not retried by another auto check…
        assert_eq!(
            should_check(UpdaterStatus::Error, false, true),
            CheckDecision::Skip
        );
        // …but a manual/periodic check retries it.
        assert_eq!(
            should_check(UpdaterStatus::Error, true, true),
            CheckDecision::Run
        );
    }

    #[test]
    fn snapshot_serializes_camel_case_for_the_frontend() {
        let snapshot = UpdaterSnapshot {
            status: UpdaterStatus::Downloading,
            version: Some("1.2.3".into()),
            progress: Some(0.5),
            last_checked_at: Some(1234),
        };
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "status": "downloading",
                "version": "1.2.3",
                "progress": 0.5,
                "lastCheckedAt": 1234,
            })
        );
        assert_eq!(
            serde_json::to_value(UpdaterStatus::Ready).unwrap(),
            serde_json::json!("ready")
        );
    }
}
