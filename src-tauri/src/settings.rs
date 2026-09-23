//! App-wide preferences the backend itself must honor (e.g. window routing for a
//! CLI launch that happens before any webview exists). Frontend-only prefs stay in
//! localStorage.
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub window_per_branch: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { window_per_branch: true }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?;
    Ok(base.join("settings.json"))
}

fn load_from(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_to(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("create settings dir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| format!("serialize settings: {e}"))?;
    fs::write(path, text).map_err(|e| format!("write settings: {e}"))
}

pub fn load(app: &tauri::AppHandle) -> Settings {
    settings_path(app).map(|p| load_from(&p)).unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    save_to(&settings_path(app)?, settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_partial_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert_eq!(load_from(&path), Settings::default());
        fs::write(&path, "{}").unwrap();
        assert_eq!(load_from(&path), Settings::default());
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        let s = Settings { window_per_branch: false };
        save_to(&path, &s).unwrap();
        assert_eq!(load_from(&path), s);
    }
}
