//! One-shot migration of app data from the fork's first releases (<= 0.17.0,
//! identifier `com.darioielardi.delta`) to this fork's own identifier
//! `com.snatvb.delta-review` (0.18.0+). Release builds only — the dev app has
//! its own `.dev` directory and must never absorb the user's real data.
//!
//! Runs at the top of `lib.rs::run()`, before the Tauri builder, so plugins
//! that read the app-data dir at init (window-state, storage) see the migrated
//! tree on the very first launch under the new identifier.

use std::fs;
use std::path::Path;

/// Identifier used by this fork's releases up to and including 0.17.0.
const LEGACY_IDENTIFIER: &str = "com.darioielardi.delta";

/// Compiled in all profiles (so the tests run in debug `cargo test`) but only
/// called from release builds — the dev app must never touch release data.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn migrate_legacy_data_dir() {
    // Read the current identifier from the bundled conf (same trick as the
    // mainBinaryName guard in cli.rs tests) so this can't drift from tauri.conf.json.
    let Some(identifier) = conf_identifier() else {
        return;
    };
    let Some(base) = dirs::data_dir() else {
        return;
    };
    let legacy = base.join(LEGACY_IDENTIFIER);
    let current = base.join(&identifier);
    if !legacy.is_dir() || current.exists() {
        return;
    }
    match copy_tree(&legacy, &current) {
        Ok(count) => {
            eprintln!(
                "migrated {count} entries from {} to {}",
                legacy.display(),
                current.display()
            );
        }
        Err(err) => {
            eprintln!(
                "warning: could not migrate app data from {}: {err}",
                legacy.display()
            );
        }
    }
}

fn conf_identifier() -> Option<String> {
    let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).ok()?;
    conf.get("identifier")?.as_str().map(str::to_owned)
}

/// Recursive copy that skips the live CLI socket (and its lockfile) — sockets
/// can't be copied, and a still-running old install owns them anyway.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<usize> {
    fs::create_dir_all(dst)?;
    let mut copied = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_string_lossy().ends_with(".sock") || name.to_string_lossy().ends_with(".sock.lock") {
            continue;
        }
        let target = dst.join(&name);
        if entry.file_type()?.is_dir() {
            copied += copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
            copied += 1;
        }
    }
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn touch(path: &Path, contents: &str) {
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn copies_tree_but_skips_sockets() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("legacy");
        let dst = dir.path().join("current");
        fs::create_dir_all(src.join("reviews/abc")).unwrap();
        touch(&src.join("registry.json"), "{}");
        touch(&src.join("reviews/abc/comments.json"), "[]");
        touch(&src.join("cli.sock"), "");
        touch(&src.join("cli.sock.lock"), "");

        let copied = copy_tree(&src, &dst).unwrap();

        assert_eq!(copied, 2);
        assert_eq!(fs::read_to_string(dst.join("registry.json")).unwrap(), "{}");
        assert_eq!(fs::read_to_string(dst.join("reviews/abc/comments.json")).unwrap(), "[]");
        assert!(!dst.join("cli.sock").exists());
        assert!(!dst.join("cli.sock.lock").exists());
    }

    #[test]
    fn conf_identifier_reads_the_bundle_conf() {
        assert_eq!(conf_identifier().as_deref(), Some("com.snatvb.delta-review"));
    }
}
