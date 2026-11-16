use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};

use super::*;

const PATIENCE: Duration = Duration::from_secs(20);

struct Probe {
    events: Receiver<TerminalEvent>,
    output: String,
}

impl Probe {
    fn channel() -> (Channel<TerminalEvent>, Probe) {
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(&json) {
                    let parsed = match event["kind"].as_str() {
                        Some("data") => TerminalEvent::Data { data: event["data"].as_str().unwrap_or_default().into() },
                        _ => TerminalEvent::Exit { code: event["code"].as_u64().map(|c| c as u32) },
                    };
                    let _ = tx.send(parsed);
                }
            }
            Ok(())
        });
        (channel, Probe { events: rx, output: String::new() })
    }

    fn wait_for(&mut self, mut found: impl FnMut(&str) -> Option<String>) -> String {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(hit) = found(&self.output) {
                return hit;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match self.events.recv_timeout(left) {
                Ok(TerminalEvent::Data { data }) => self.output.push_str(&data),
                Ok(TerminalEvent::Exit { .. }) => panic!("shell exited early; output:\n{}", self.output),
                Err(_) => panic!("timed out; output:\n{}", self.output),
            }
        }
    }

    fn wait_exit(&mut self) {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.events.recv_timeout(left) {
                Ok(TerminalEvent::Data { data }) => self.output.push_str(&data),
                Ok(TerminalEvent::Exit { .. }) => return,
                Err(_) => panic!("no exit event; output:\n{}", self.output),
            }
        }
    }
}

#[cfg(windows)]
fn test_shell() -> PathBuf {
    shell::resolve(Some("powershell")).unwrap()
}

#[cfg(unix)]
fn test_shell() -> PathBuf {
    PathBuf::from("/bin/sh")
}

#[cfg(windows)]
const SPAWN_GRANDCHILD: &str =
    "$p = Start-Process ping -ArgumentList '-n','120','127.0.0.1' -PassThru -WindowStyle Hidden; 'GRAND' + 'CHILD=' + $p.Id\r";

#[cfg(unix)]
const SPAWN_GRANDCHILD: &str = "sleep 120 & echo GRAND''CHILD=$!\r";

fn open(terminals: &Terminals, window: &str) -> (u32, Probe) {
    let (channel, mut probe) = Probe::channel();
    let cwd = std::env::temp_dir();
    let shell = test_shell();
    let id = terminals
        .open(
            OpenRequest { window, cwd: &cwd, shell: shell.to_str(), cols: 120, rows: 30 },
            channel,
        )
        .unwrap();
    #[cfg(windows)]
    answer_cursor_query(terminals, id, &mut probe);
    (id, probe)
}

#[cfg(windows)]
fn answer_cursor_query(terminals: &Terminals, id: u32, probe: &mut Probe) {
    const CURSOR_QUERY: &str = "\x1b[6n";
    const CURSOR_AT_ORIGIN: &str = "\x1b[1;1R";
    probe.wait_for(|out| out.contains(CURSOR_QUERY).then(String::new));
    terminals.write(id, CURSOR_AT_ORIGIN).unwrap();
}

fn grandchild_pid(output: &str) -> Option<String> {
    let at = output.find("GRANDCHILD=")? + "GRANDCHILD=".len();
    let digits: String = output[at..].chars().take_while(char::is_ascii_digit).collect();
    let complete = output[at + digits.len()..].starts_with(|c: char| !c.is_ascii_digit());
    (!digits.is_empty() && complete).then_some(digits)
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == STILL_ACTIVE as u32
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

fn eventually(mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    done()
}

#[test]
fn closing_a_session_kills_its_grandchildren() {
    let terminals = Terminals::default();
    let (id, mut probe) = open(&terminals, "w");
    terminals.write(id, SPAWN_GRANDCHILD).unwrap();
    let pid: u32 = probe.wait_for(grandchild_pid).parse().unwrap();
    assert!(alive(pid), "grandchild should be running before close");

    terminals.close(id);

    assert!(eventually(|| !alive(pid)), "grandchild {pid} survived the session");
    probe.wait_exit();
}

#[test]
fn closing_a_window_ends_only_its_sessions() {
    let terminals = Terminals::default();
    let (_a, mut probe_a) = open(&terminals, "review-a");
    let (b, _probe_b) = open(&terminals, "review-b");

    terminals.close_window("review-a");

    probe_a.wait_exit();
    assert_eq!(terminals.len(), 1);
    terminals.close(b);
}

#[test]
fn shell_exit_removes_the_session_and_its_children() {
    let terminals = Terminals::default();
    let (id, mut probe) = open(&terminals, "w");
    terminals.write(id, SPAWN_GRANDCHILD).unwrap();
    let pid: u32 = probe.wait_for(grandchild_pid).parse().unwrap();

    terminals.write(id, "exit\r").unwrap();

    probe.wait_exit();
    assert!(eventually(|| terminals.len() == 0), "session should be gone after the shell exits");
    assert!(eventually(|| !alive(pid)), "grandchild {pid} outlived its shell");
}

#[test]
fn close_all_waits_for_trees_to_die() {
    let terminals = Terminals::default();
    let (id, mut probe) = open(&terminals, "w");
    terminals.write(id, SPAWN_GRANDCHILD).unwrap();
    let pid: u32 = probe.wait_for(grandchild_pid).parse().unwrap();

    terminals.close_all();

    assert!(eventually(|| !alive(pid)), "grandchild {pid} survived app exit");
}

#[test]
fn input_round_trips_through_the_pty() {
    let terminals = Terminals::default();
    let (id, mut probe) = open(&terminals, "w");
    terminals.write(id, "echo delta-''ok\r").unwrap();
    probe.wait_for(|out| out.contains("delta-ok").then(String::new));
    terminals.resize(id, 80, 24).unwrap();
    terminals.close(id);
    probe.wait_exit();
}

#[test]
fn missing_cwd_is_rejected_before_spawning() {
    let terminals = Terminals::default();
    let (channel, _probe) = Probe::channel();
    let cwd = PathBuf::from("/definitely/not/here");
    let err = terminals
        .open(OpenRequest { window: "w", cwd: &cwd, shell: None, cols: 80, rows: 24 }, channel)
        .unwrap_err();
    assert!(err.contains("not a directory"), "{err}");
    assert_eq!(terminals.len(), 0);
}

#[test]
fn shell_prompt_appears_quickly() {
    let terminals = Terminals::default();
    let (id, mut probe) = open(&terminals, "w");
    let started = Instant::now();
    terminals.write(id, "echo ready-''now\r").unwrap();
    probe.wait_for(|out| out.contains("ready-now").then(String::new));
    assert!(started.elapsed() < Duration::from_millis(1500), "shell took {:?} to answer", started.elapsed());
    terminals.close(id);
}
