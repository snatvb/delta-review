//! Timing instrumentation for the diff/blob hot path — the suspect list when
//! image previews feel slow is long (snapshot rebuild under the cache mutex,
//! watcher invalidation storms, per-request byte reads), and these one-line
//! stderr stamps say which one is actually eating the time. Off by default so
//! production stderr stays quiet; set `DELTA_PERF_LOG=1` before launching to
//! enable.
use std::sync::OnceLock;
use std::time::Instant;

pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("DELTA_PERF_LOG").is_ok_and(|v| v != "0"))
}

/// `[perf] <stage> <detail> <elapsed>ms` — `detail` is pre-formatted by the
/// caller because each site has its own useful fields.
pub fn log(stage: &str, detail: &str, start: Instant) {
    if enabled() {
        eprintln!("[perf] {stage} {detail} {:.1}ms", start.elapsed().as_secs_f64() * 1e3);
    }
}
