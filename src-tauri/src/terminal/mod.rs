mod shell;
mod tree;
mod utf8;

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;

use tree::ProcessTree;
use utf8::Utf8Stream;

const READ_CHUNK: usize = 16 * 1024;
const EXIT_CODE_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

pub struct OpenRequest<'a> {
    pub window: &'a str,
    pub cwd: &'a Path,
    pub shell: Option<&'a str>,
    pub cols: u16,
    pub rows: u16,
}

struct Session {
    window: String,
    tree: ProcessTree,
    input: Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
}

impl Session {
    fn shutdown(self) {
        let Session { tree, input, master, .. } = self;
        drop(tree);
        drop(input);
        drop(master);
    }
}

type Sessions = Arc<Mutex<HashMap<u32, Session>>>;

#[derive(Default)]
pub struct Terminals {
    next_id: AtomicU32,
    sessions: Sessions,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

fn lock(sessions: &Sessions) -> MutexGuard<'_, HashMap<u32, Session>> {
    sessions.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn shutdown_in_background(sessions: Vec<Session>) -> Vec<thread::JoinHandle<()>> {
    sessions
        .into_iter()
        .map(|s| thread::spawn(move || s.shutdown()))
        .collect()
}

impl Terminals {
    pub fn open(&self, req: OpenRequest<'_>, events: Channel<TerminalEvent>) -> Result<u32, String> {
        if !req.cwd.is_dir() {
            return Err(format!("terminal: not a directory: {}", req.cwd.display()));
        }
        #[cfg(windows)]
        pin_system_conpty();
        let shell = shell::resolve(req.shell)?;
        let pair = native_pty_system()
            .openpty(size(req.cols, req.rows))
            .map_err(|e| format!("terminal: open pty: {e}"))?;
        let mut child = pair
            .slave
            .spawn_command(shell::command(&shell, req.cwd))
            .map_err(|e| format!("terminal: start {}: {e}", shell.display()))?;
        drop(pair.slave);
        let tree = match ProcessTree::adopt(child.as_ref()) {
            Ok(tree) => tree,
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };
        let reader = pair.master.try_clone_reader().map_err(|e| format!("terminal: reader: {e}"))?;
        let writer = pair.master.take_writer().map_err(|e| format!("terminal: writer: {e}"))?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (input, input_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        lock(&self.sessions).insert(
            id,
            Session { window: req.window.to_string(), tree, input, master: pair.master },
        );

        thread::spawn(move || forward_input(writer, input_rx));
        thread::spawn(move || forward_output(reader, events, exit_rx));
        let sessions = Arc::clone(&self.sessions);
        thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            let _ = exit_tx.send(code);
            let ended = lock(&sessions).remove(&id);
            if let Some(session) = ended {
                session.shutdown();
            }
        });
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let sessions = lock(&self.sessions);
        let session = sessions.get(&id).ok_or("terminal: session is gone")?;
        session
            .input
            .send(data.as_bytes().to_vec())
            .map_err(|_| "terminal: session is gone".to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = lock(&self.sessions);
        let session = sessions.get(&id).ok_or("terminal: session is gone")?;
        session
            .master
            .resize(size(cols, rows))
            .map_err(|e| format!("terminal: resize: {e}"))
    }

    pub fn close(&self, id: u32) {
        let ended: Vec<Session> = lock(&self.sessions).remove(&id).into_iter().collect();
        shutdown_in_background(ended);
    }

    pub fn close_window(&self, window: &str) {
        let mut sessions = lock(&self.sessions);
        let ids: Vec<u32> = sessions
            .iter()
            .filter(|(_, s)| s.window == window)
            .map(|(id, _)| *id)
            .collect();
        let ended: Vec<Session> = ids.iter().filter_map(|id| sessions.remove(id)).collect();
        drop(sessions);
        shutdown_in_background(ended);
    }

    pub fn close_all(&self) {
        let ended: Vec<Session> = lock(&self.sessions).drain().map(|(_, s)| s).collect();
        for handle in shutdown_in_background(ended) {
            let _ = handle.join();
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        lock(&self.sessions).len()
    }
}

// portable-pty sideloads any conpty.dll found on PATH (e.g. WezTerm's), and that
// build stalls every shell start for 3s; keeping PATH out of DLL search pins the OS one.
#[cfg(windows)]
fn pin_system_conpty() {
    use windows_sys::Win32::System::LibraryLoader::{SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS};
    static PINNED: std::sync::Once = std::sync::Once::new();
    PINNED.call_once(|| unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    });
}

fn forward_input(mut writer: Box<dyn Write + Send>, input: Receiver<Vec<u8>>) {
    for bytes in input {
        if writer.write_all(&bytes).and_then(|_| writer.flush()).is_err() {
            return;
        }
    }
}

fn forward_output(mut reader: Box<dyn Read + Send>, events: Channel<TerminalEvent>, exit: Receiver<Option<u32>>) {
    let mut utf8 = Utf8Stream::default();
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let data = utf8.push(&buf[..n]);
        if !data.is_empty() {
            let _ = events.send(TerminalEvent::Data { data });
        }
    }
    let rest = utf8.finish();
    if !rest.is_empty() {
        let _ = events.send(TerminalEvent::Data { data: rest });
    }
    let code = exit.recv_timeout(EXIT_CODE_WAIT).ok().flatten();
    let _ = events.send(TerminalEvent::Exit { code });
}

#[cfg(test)]
mod tests;
