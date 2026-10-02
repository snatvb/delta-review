// Dev-only HTTP eval bridge for smoke-testing the real webview from outside the app.
//
//   curl -s --data 'return document.title' http://127.0.0.1:7787/eval
//   curl -s --data 'return [...document.querySelectorAll("[data-index]")].length' .../eval
//   curl -s http://127.0.0.1:7787/lights   (macOS traffic-light frames, for calibration)
//
// POST /eval — body is a JS function body that `return`s a JSON-serializable value.
// We run it in a webview via `eval()`; the webview posts the result back to /result
// with `fetch` (the app's CSP is null in dev, so cross-port fetch is allowed). Add
// `?w=<label>` to target a specific window. Single-flight — intended for sequential
// curl calls. Debug builds only; never compiled into release.
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const ADDR: &str = "127.0.0.1:7787";
static RESULT_TX: Mutex<Option<Sender<String>>> = Mutex::new(None);

// GET /lights — traffic-light calibration: reports the real AppKit frames of
// the standard window buttons so the TRAFFIC_LIGHT_* math in launch/mod.rs can
// be verified against what actually renders (macOS only, debug only).
#[cfg(target_os = "macos")]
mod lights {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

    pub fn report(ns_window: *mut std::ffi::c_void) -> serde_json::Value {
        let win: &NSWindow = unsafe { &*(ns_window as *const NSWindow) };
        let win_h = win.frame().size.height;
        let mut buttons = serde_json::Map::new();
        let mut container: Option<serde_json::Value> = None;
        for (tag, name) in [
            (NSWindowButton::CloseButton, "close"),
            (NSWindowButton::MiniaturizeButton, "miniaturize"),
            (NSWindowButton::ZoomButton, "zoom"),
        ] {
            let Some(btn) = win.standardWindowButton(tag) else {
                continue;
            };
            if container.is_none() {
                // close.superview().superview() is the titlebar container wry resizes.
                let sv2 = unsafe { btn.superview() }.and_then(|v| unsafe { v.superview() });
                if let Some(sv2) = sv2 {
                    let c = sv2.convertRect_toView(sv2.bounds(), None);
                    container = Some(serde_json::json!({
                        "x": c.origin.x,
                        "top": win_h - (c.origin.y + c.size.height),
                        "w": c.size.width,
                        "h": c.size.height,
                    }));
                }
            }
            // NSButton is an NSView subclass; cast up to reach its geometry API.
            let view = unsafe { objc2::rc::Retained::cast_unchecked::<NSView>(btn) };
            // Window coords (AppKit y-up): flip to "top from window top".
            let r = view.convertRect_toView(view.bounds(), None);
            buttons.insert(
                name.into(),
                serde_json::json!({
                    "x": r.origin.x,
                    "top": win_h - (r.origin.y + r.size.height),
                    "w": r.size.width,
                    "h": r.size.height,
                }),
            );
        }
        serde_json::json!({
            "window": { "h": win_h },
            "constants": { "x": crate::launch::TRAFFIC_LIGHT_X, "y": crate::launch::TRAFFIC_LIGHT_Y },
            "container": container,
            "buttons": buttons,
        })
    }
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || match TcpListener::bind(ADDR) {
        Ok(listener) => {
            eprintln!("[devbridge] eval bridge up — curl -s --data 'return document.title' http://{ADDR}/eval");
            for stream in listener.incoming().flatten() {
                // One thread per connection: an /eval blocks waiting for the webview's
                // /result callback, so the two must be served concurrently.
                let app = app.clone();
                std::thread::spawn(move || handle(&app, stream));
            }
        }
        Err(e) => eprintln!("[devbridge] could not bind {ADDR}: {e}"),
    });
}

fn handle(app: &AppHandle, mut stream: TcpStream) {
    let Some((path, body)) = read_request(&mut stream) else {
        return;
    };

    if path.starts_with("/result") {
        if let Some(tx) = RESULT_TX.lock().unwrap().take() {
            let _ = tx.send(body);
        }
        respond(&mut stream, "ok");
        return;
    }

    if path.starts_with("/lights") {
        let mut windows = serde_json::Map::new();
        for (label, w) in app.webview_windows() {
            #[cfg(target_os = "macos")]
            if let Ok(ns) = w.ns_window() {
                windows.insert(label, lights::report(ns));
            }
        }
        let body = serde_json::Value::Object(windows).to_string();
        respond(&mut stream, &body);
        return;
    }

    if path.starts_with("/eval") {
        // ?w=<label> targets a specific window; otherwise the first webview.
        let want = path
            .split("w=")
            .nth(1)
            .map(|s| s.split('&').next().unwrap_or(s).to_string());
        let webview = app
            .webview_windows()
            .into_iter()
            .find_map(|(label, w)| match &want {
                Some(l) => (&label == l).then_some(w),
                None => Some(w),
            });
        let Some(webview) = webview else {
            respond(&mut stream, "{\"__error\":\"no matching webview\"}");
            return;
        };
        let (tx, rx) = channel();
        *RESULT_TX.lock().unwrap() = Some(tx);
        let js = format!(
            "(async()=>{{let r;try{{r=JSON.stringify(await(async()=>{{{body}}})())}}catch(e){{r=JSON.stringify({{__error:String((e&&e.stack)||e)}})}}try{{await fetch('http://{ADDR}/result',{{method:'POST',body:r}})}}catch(_){{}}}})()"
        );
        let _ = webview.eval(&js);
        let result = rx
            .recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|_| "{\"__error\":\"timeout\"}".into());
        respond(&mut stream, &result);
        return;
    }

    respond(&mut stream, "{\"__error\":\"unknown path\"}");
}

/// Minimal HTTP/1.1 reader: returns (path, body), honoring Content-Length.
fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    let mut content_length = 0usize;
    let mut header_end: Option<usize> = None;
    loop {
        let n = stream.read(&mut tmp).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        if header_end.is_none() {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
                let head = String::from_utf8_lossy(&buf[..pos]);
                for line in head.lines() {
                    let l = line.to_ascii_lowercase();
                    if let Some(v) = l.strip_prefix("content-length:") {
                        content_length = v.trim().parse().unwrap_or(0);
                    }
                }
            }
        }
        if let Some(he) = header_end {
            if buf.len() >= he + content_length {
                break;
            }
        }
    }
    let he = header_end?;
    let request_line = String::from_utf8_lossy(&buf).lines().next()?.to_string();
    let path = request_line.split_whitespace().nth(1)?.to_string();
    let end = (he + content_length).min(buf.len());
    let body = String::from_utf8_lossy(&buf[he..end]).to_string();
    Some((path, body))
}

fn respond(stream: &mut TcpStream, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.flush();
}
