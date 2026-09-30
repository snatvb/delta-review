//! Cross-process IPC between the `dr` CLI shim and the running app.
//!
//! The app binds a unix-domain socket; a CLI invocation connects and forwards
//! one open-target request, then exits. Single-instance and detaching are
//! handled by macOS Launch Services (`open -b`) / the detached self-exec on
//! Linux, not a Tauri plugin.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use tauri::{AppHandle, Emitter, Manager};

use crate::git::model::DiffMode;

/// Bundle identifier this binary talks to. The debug build is a separate app so
/// `dr-dev` never forwards into an installed release. Mirrors `launch::CLI_NAME`
/// and the identifiers in the tauri conf files.
#[cfg(not(debug_assertions))]
pub const IDENTIFIER: &str = "com.snatvb.delta-review";
#[cfg(debug_assertions)]
pub const IDENTIFIER: &str = "com.snatvb.delta-review.dev";

/// The rendezvous socket: stable, per-user, per-identifier, next to the app's
/// own data dir. NOT `$TMPDIR` on macOS — launchd hands the app a different
/// `$TMPDIR` than the shell, so they'd never meet. On Linux it mirrors Tauri's
/// XDG data location (~/.local/share/<identifier>).
pub fn cli_socket_path(identifier: &str, home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    let base = home.join("Library/Application Support");
    #[cfg(not(target_os = "macos"))]
    let base = home.join(".local/share");
    base.join(identifier).join("cli.sock")
}

/// One open-target request forwarded from a CLI invocation. `mode` is `None`
/// when no mode flag was passed (focus only), `Some` for an explicit `--mode`.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct CliRequest {
    pub repo: String,
    pub mode: Option<DiffMode>,
}

/// Bind the CLI socket and serve forwarded open-target requests. Best-effort:
/// any failure (e.g. an over-long socket path) logs and disables forwarding —
/// cold `open -b` still works, only warm forwarding degrades.
pub fn start(app: &AppHandle) {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return,
    };
    let sock = cli_socket_path(IDENTIFIER, &home);
    // Another instance is already serving this socket? We're a redundant second
    // GUI launch (Linux has no Launch Services to prevent one) — leave its
    // socket alone instead of stealing it, and stay socket-less ourselves.
    if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
        return;
    }
    if let Some(parent) = sock.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::remove_file(&sock); // clear a stale socket from a prior crash
    // macOS caps sun_path at 104 bytes; bail cleanly rather than panic on bind.
    if sock.as_os_str().len() >= 104 {
        eprintln!("dr: cli socket path too long; CLI forwarding disabled");
        return;
    }
    let listener = match std::os::unix::net::UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("dr: bind cli socket: {e}");
            return;
        }
    };
    let handle = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = String::new();
            if std::io::Read::read_to_string(&mut stream, &mut buf).is_err() {
                continue;
            }
            let Ok(req) = serde_json::from_str::<CliRequest>(buf.trim()) else { continue };
            let h = handle.clone();
            // Window create/focus must happen on the main thread.
            let _ = handle.run_on_main_thread(move || handle_request(&h, req));
        }
    });
}

/// Open (or focus) the target window. If we focused an already-open window AND the
/// request carried an explicit mode, forward it as `cli:set-mode` so the frontend
/// switches in place instead of ignoring it.
fn handle_request(app: &AppHandle, req: CliRequest) {
    let explicit = req.mode;
    let mode = req.mode.unwrap_or(DiffMode::Uncommitted);
    if let Ok(crate::launch::Opened::Focused(label)) =
        crate::launch::open_target_window(app, &req.repo, mode, None)
    {
        if let Some(m) = explicit {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.emit("cli:set-mode", m);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};

    #[test]
    fn socket_path_is_under_app_data_for_identifier() {
        let p = cli_socket_path("com.snatvb.delta-review", Path::new("/Users/me"));
        #[cfg(target_os = "macos")]
        assert_eq!(
            p,
            PathBuf::from("/Users/me/Library/Application Support/com.snatvb.delta-review/cli.sock")
        );
        // Mirrors Tauri's XDG data dir on Linux.
        #[cfg(not(target_os = "macos"))]
        assert_eq!(p, PathBuf::from("/Users/me/.local/share/com.snatvb.delta-review/cli.sock"));
    }

    #[test]
    fn request_round_trips_with_kebab_mode() {
        let r = CliRequest { repo: "/r".into(), mode: Some(DiffMode::Uncommitted) };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains(r#""mode":"uncommitted""#), "got {s}");
        assert_eq!(serde_json::from_str::<CliRequest>(&s).unwrap(), r);
    }

    #[test]
    fn request_round_trips_with_no_mode() {
        let r = CliRequest { repo: "/r".into(), mode: None };
        let s = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<CliRequest>(&s).unwrap().mode, None);
    }

    #[test]
    fn unix_socket_carries_one_request() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("cli.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = String::new();
            s.read_to_string(&mut buf).unwrap();
            serde_json::from_str::<CliRequest>(buf.trim()).unwrap()
        });
        let mut c = UnixStream::connect(&sock).unwrap();
        let payload =
            serde_json::to_string(&CliRequest { repo: "/r".into(), mode: Some(DiffMode::BranchVsBase) }).unwrap();
        c.write_all(payload.as_bytes()).unwrap();
        c.flush().unwrap();
        drop(c); // EOF so the server's read_to_string returns
        let got = server.join().unwrap();
        assert_eq!(got, CliRequest { repo: "/r".into(), mode: Some(DiffMode::BranchVsBase) });
    }
}
