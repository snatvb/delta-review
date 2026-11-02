//! Persistent app log: `<app log dir>/delta-review.log` (macOS:
//! `~/Library/Logs/<bundle id>/`). A release app launched from the dock has no
//! visible stderr, so failures that only show up as a blank UI (a diff that never
//! loaded, a snapshot rebuild storm from the fs watcher) used to leave no trace.
//! Low-volume, plain lines — `<time> <LEVEL> [<scope>] <message>` — size-capped
//! with one rotated copy (`delta-review.1.log`). Before `init` (unit tests, CLI
//! paths) a write only goes to stderr in debug builds.
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Rotate once the live file passes this — keeps the log + its one backup small.
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const FILE_NAME: &str = "delta-review.log";

struct Sink {
    path: PathBuf,
    file: File,
    size: u64,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

#[derive(Clone, Copy)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

fn open(path: &Path) -> std::io::Result<Sink> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(Sink {
        path: path.to_path_buf(),
        file,
        size,
    })
}

/// Swap the full log out to `delta-review.1.log` (replacing the previous backup)
/// and start a fresh one. Best-effort: on failure keep appending to the old file.
fn rotate(sink: &mut Sink) {
    let backup = sink.path.with_extension("1.log");
    if std::fs::rename(&sink.path, &backup).is_ok() {
        if let Ok(fresh) = open(&sink.path) {
            *sink = fresh;
        }
    }
}

/// Point the log at `dir` (created if missing). Called once from the Tauri setup
/// hook; logging is a no-op (bar debug stderr) until then.
pub fn init(dir: &Path, version: &str) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(mut sink) = open(&dir.join(FILE_NAME)) else {
        return;
    };
    if sink.size > MAX_BYTES {
        rotate(&mut sink);
    }
    *SINK.lock().unwrap_or_else(|e| e.into_inner()) = Some(sink);
    info("app", &format!("started v{version}"));
}

pub fn write(level: Level, scope: &str, msg: &str) {
    let line = format!(
        "{} {:5} [{scope}] {msg}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        level.as_str(),
    );
    if cfg!(debug_assertions) {
        eprint!("{line}");
    }
    let mut guard = SINK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(sink) = guard.as_mut() else {
        return;
    };
    if sink.file.write_all(line.as_bytes()).is_ok() {
        sink.size += line.len() as u64;
        if sink.size > MAX_BYTES {
            rotate(sink);
        }
    }
}

pub fn info(scope: &str, msg: &str) {
    write(Level::Info, scope, msg);
}

pub fn warn(scope: &str, msg: &str) {
    write(Level::Warn, scope, msg);
}

pub fn error(scope: &str, msg: &str) {
    write(Level::Error, scope, msg);
}
