use super::{parse_status_xml, run_bytes, run_text, SvnStatusEntry};
use crate::vcs::VcsError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime};

const SLOW_FULL_STATUS: Duration = Duration::from_millis(1500);
const MAX_TARGETED_PATHS: usize = 2000;
const MAX_INLINE_TARGETS: usize = 32;
const MAX_BASE_CACHE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone)]
struct Baseline {
    entries: Vec<SvnStatusEntry>,
    wc_db: Option<SystemTime>,
    watch_epoch: Option<u64>,
    verified: bool,
    generation: u64,
}

#[derive(Default)]
struct RootState {
    watchers: usize,
    watch_epoch: u64,
    dirty: HashSet<String>,
    baseline: Option<Baseline>,
    served: Option<Vec<SvnStatusEntry>>,
    full_status_time: Option<Duration>,
    verifying: bool,
    generation: u64,
    full_runs: usize,
}

impl RootState {
    fn tracks(&self, baseline: &Baseline, wc_db: Option<SystemTime>) -> bool {
        baseline.verified
            && baseline.wc_db == wc_db
            && self.watchers > 0
            && baseline.watch_epoch == Some(self.watch_epoch)
    }

    fn lose_tracking(&mut self) {
        self.watch_epoch += 1;
        self.dirty.clear();
    }

    fn store_baseline(
        &mut self,
        entries: Vec<SvnStatusEntry>,
        wc_db: Option<SystemTime>,
        watch_epoch: Option<u64>,
    ) {
        self.generation += 1;
        self.baseline = Some(Baseline {
            entries,
            wc_db,
            watch_epoch,
            verified: true,
            generation: self.generation,
        });
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    entries: Vec<SvnStatusEntry>,
    full_status_ms: u64,
}

type RootsGuard<'a> = MutexGuard<'a, HashMap<PathBuf, RootState>>;
type VerifiedChangeFn = Box<dyn Fn(&Path) + Send + Sync>;

static ROOTS: LazyLock<Mutex<HashMap<PathBuf, RootState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PERSIST_DIR: OnceLock<PathBuf> = OnceLock::new();
static VERIFIED_CHANGE: OnceLock<VerifiedChangeFn> = OnceLock::new();

fn roots() -> RootsGuard<'static> {
    ROOTS.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn set_persist_dir(dir: PathBuf) {
    let _ = PERSIST_DIR.set(dir);
}

pub fn on_verified_change(listener: impl Fn(&Path) + Send + Sync + 'static) {
    let _ = VERIFIED_CHANGE.set(Box::new(listener));
}

pub fn watch_started(root: &Path) {
    let mut roots = roots();
    let state = roots.entry(root.to_path_buf()).or_default();
    if state.watchers == 0 {
        state.lose_tracking();
    }
    state.watchers += 1;
}

pub fn watch_stopped(root: &Path) {
    let mut roots = roots();
    if let Some(state) = roots.get_mut(root) {
        state.watchers = state.watchers.saturating_sub(1);
        if state.watchers == 0 {
            state.dirty.clear();
        }
    }
}

pub fn record_changes(root: &Path, paths: impl IntoIterator<Item = String>, overflowed: bool) {
    let mut roots = roots();
    let Some(state) = roots.get_mut(root) else {
        return;
    };
    if state.watchers == 0 {
        return;
    }
    if overflowed {
        state.lose_tracking();
        return;
    }
    state.dirty.extend(paths);
    if state.dirty.len() > MAX_TARGETED_PATHS {
        state.lose_tracking();
    }
}

enum Step {
    Incremental {
        base: Baseline,
        dirty: HashSet<String>,
    },
    Provisional {
        entries: Vec<SvnStatusEntry>,
        dirty: HashSet<String>,
        start_verification: bool,
    },
    Full {
        watch_epoch: Option<u64>,
    },
}

pub(super) fn current_entries(root: &Path) -> Result<Vec<SvnStatusEntry>, VcsError> {
    let wc_db = wc_db_stamp(root);
    let step = {
        let mut roots = roots();
        let state = roots.entry(root.to_path_buf()).or_default();
        let tracked = state
            .baseline
            .as_ref()
            .is_some_and(|b| state.tracks(b, wc_db));
        if tracked {
            let base = state.baseline.clone().expect("tracked implies a baseline");
            Step::Incremental {
                base,
                dirty: std::mem::take(&mut state.dirty),
            }
        } else if let Some(entries) = provisional_entries(state, root) {
            let start_verification = !std::mem::replace(&mut state.verifying, true);
            Step::Provisional {
                entries,
                dirty: state.dirty.clone(),
                start_verification,
            }
        } else {
            state.dirty.clear();
            Step::Full {
                watch_epoch: (state.watchers > 0).then_some(state.watch_epoch),
            }
        }
    };

    let entries = match step {
        Step::Incremental { base, dirty } => incremental(root, base, dirty, wc_db)?,
        Step::Provisional {
            entries,
            dirty,
            start_verification,
        } => {
            if start_verification {
                spawn_verification(root.to_path_buf());
            }
            refresh_paths(root, &entries, &dirty).unwrap_or(entries)
        }
        Step::Full { watch_epoch } => full(root, wc_db, watch_epoch)?,
    };
    roots().entry(root.to_path_buf()).or_default().served = Some(entries.clone());
    Ok(entries)
}

fn provisional_entries(state: &RootState, root: &Path) -> Option<Vec<SvnStatusEntry>> {
    let persisted = || load_persisted(root);
    match (&state.baseline, state.full_status_time) {
        (Some(b), Some(took)) if took >= SLOW_FULL_STATUS => Some(b.entries.clone()),
        (Some(_), Some(_)) => None,
        _ => persisted()
            .filter(|p| Duration::from_millis(p.full_status_ms) >= SLOW_FULL_STATUS)
            .map(|p| p.entries),
    }
}

fn incremental(
    root: &Path,
    base: Baseline,
    dirty: HashSet<String>,
    wc_db: Option<SystemTime>,
) -> Result<Vec<SvnStatusEntry>, VcsError> {
    if dirty.is_empty() {
        return Ok(base.entries);
    }
    let entries = match refresh_paths(root, &base.entries, &dirty) {
        Ok(entries) => entries,
        Err(_) => {
            let watch_epoch = base.watch_epoch;
            return full(root, wc_db, watch_epoch);
        }
    };
    let stored = {
        let mut roots = roots();
        let state = roots.entry(root.to_path_buf()).or_default();
        if state.generation == base.generation {
            state.store_baseline(entries.clone(), base.wc_db, base.watch_epoch);
            true
        } else {
            state.dirty.extend(dirty);
            false
        }
    };
    if stored {
        persist(root, &entries, None);
    }
    Ok(entries)
}

fn full(
    root: &Path,
    wc_db: Option<SystemTime>,
    watch_epoch: Option<u64>,
) -> Result<Vec<SvnStatusEntry>, VcsError> {
    let started = Instant::now();
    let entries = full_status(root)?;
    let took = started.elapsed();
    {
        let mut roots = roots();
        let state = roots.entry(root.to_path_buf()).or_default();
        state.full_status_time = Some(took);
        state.full_runs += 1;
        state.store_baseline(entries.clone(), wc_db, watch_epoch);
    }
    persist(root, &entries, Some(took));
    Ok(entries)
}

fn spawn_verification(root: PathBuf) {
    std::thread::spawn(move || {
        let wc_db = wc_db_stamp(&root);
        let watch_epoch = {
            let mut roots = roots();
            let state = roots.entry(root.clone()).or_default();
            state.dirty.clear();
            (state.watchers > 0).then_some(state.watch_epoch)
        };
        let started = Instant::now();
        let result = full_status(&root);
        let took = started.elapsed();
        let changed = {
            let mut roots = roots();
            let state = roots.entry(root.clone()).or_default();
            state.verifying = false;
            match &result {
                Ok(entries) => {
                    state.full_status_time = Some(took);
                    state.full_runs += 1;
                    state.store_baseline(entries.clone(), wc_db, watch_epoch);
                    state.served.as_ref() != Some(entries)
                }
                Err(_) => false,
            }
        };
        if let Ok(entries) = &result {
            persist(&root, entries, Some(took));
        }
        if changed {
            if let Some(listener) = VERIFIED_CHANGE.get() {
                listener(&root);
            }
        }
    });
}

fn full_status(root: &Path) -> Result<Vec<SvnStatusEntry>, VcsError> {
    let xml = run_text(root, &["status", "--xml", "--ignore-externals"])?;
    Ok(normalized(parse_status_xml(&xml)))
}

fn refresh_paths(
    root: &Path,
    entries: &[SvnStatusEntry],
    dirty: &HashSet<String>,
) -> Result<Vec<SvnStatusEntry>, VcsError> {
    if dirty.is_empty() {
        return Ok(entries.to_vec());
    }
    let (queried, fresh) = targeted(root, dirty.iter().map(String::as_str))?;
    Ok(merge(entries, &queried, fresh, |rel| {
        std::fs::symlink_metadata(root.join(rel)).is_ok()
    }))
}

pub(super) fn targeted<'a>(
    root: &Path,
    paths: impl IntoIterator<Item = &'a str>,
) -> Result<(HashSet<String>, Vec<SvnStatusEntry>), VcsError> {
    let queried = with_ancestors(paths);
    let targets: Vec<String> = queried.iter().cloned().collect();
    let xml = run_with_targets(
        root,
        &["status", "--xml", "--depth", "empty", "--ignore-externals"],
        &targets,
    )?;
    let fresh = parse_status_xml(&xml)
        .into_iter()
        .filter(|e| e.item != "ignored")
        .collect();
    Ok((queried, fresh))
}

fn with_ancestors<'a>(paths: impl IntoIterator<Item = &'a str>) -> HashSet<String> {
    let mut out = HashSet::new();
    for path in paths {
        let mut current = path.trim_end_matches('/');
        while !current.is_empty() && out.insert(current.to_string()) {
            current = current.rfind('/').map_or("", |i| &current[..i]);
        }
    }
    out
}

fn merge(
    base: &[SvnStatusEntry],
    queried: &HashSet<String>,
    fresh: Vec<SvnStatusEntry>,
    exists: impl Fn(&str) -> bool,
) -> Vec<SvnStatusEntry> {
    let gone: Vec<String> = queried
        .iter()
        .filter(|p| !exists(p))
        .map(|p| format!("{p}/"))
        .collect();
    let mut merged: Vec<SvnStatusEntry> = base
        .iter()
        .filter(|e| {
            !queried.contains(&e.path) && !gone.iter().any(|g| e.path.starts_with(g.as_str()))
        })
        .cloned()
        .collect();
    merged.extend(fresh);
    normalized(merged)
}

fn normalized(mut entries: Vec<SvnStatusEntry>) -> Vec<SvnStatusEntry> {
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    entries.dedup_by(|a, b| a.path == b.path);
    entries
}

fn peg_safe(path: &str) -> String {
    if path.contains('@') {
        format!("{path}@")
    } else {
        path.to_string()
    }
}

pub(super) fn run_with_targets(
    root: &Path,
    args: &[&str],
    paths: &[String],
) -> Result<String, VcsError> {
    let escaped: Vec<String> = paths.iter().map(|p| peg_safe(p)).collect();
    if escaped.len() <= MAX_INLINE_TARGETS {
        let mut full: Vec<&str> = args.to_vec();
        full.push("--");
        full.extend(escaped.iter().map(String::as_str));
        return run_text(root, &full);
    }
    static TARGETS_FILE_SEQ: AtomicU64 = AtomicU64::new(0);
    let file = std::env::temp_dir().join(format!(
        "delta-svn-targets-{}-{}.txt",
        std::process::id(),
        TARGETS_FILE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&file, escaped.join("\n"))
        .map_err(|e| format!("write svn targets file: {e}"))?;
    let file_arg = file.display().to_string();
    let mut full: Vec<&str> = args.to_vec();
    full.extend(["--targets", file_arg.as_str()]);
    let result = run_text(root, &full);
    let _ = std::fs::remove_file(&file);
    result
}

fn wc_db_stamp(root: &Path) -> Option<SystemTime> {
    std::fs::metadata(root.join(".svn/wc.db"))
        .and_then(|m| m.modified())
        .ok()
}

fn persisted_path(root: &Path) -> Option<PathBuf> {
    use sha2::{Digest, Sha256};
    let dir = PERSIST_DIR.get()?;
    let digest = Sha256::digest(root.display().to_string().as_bytes());
    let name: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    Some(dir.join(format!("{name}.json")))
}

fn load_persisted(root: &Path) -> Option<Persisted> {
    let bytes = std::fs::read(persisted_path(root)?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn persist(root: &Path, entries: &[SvnStatusEntry], full_status_time: Option<Duration>) {
    let Some(path) = persisted_path(root) else {
        return;
    };
    let full_status_ms = match full_status_time {
        Some(took) => took.as_millis() as u64,
        None => load_persisted(root).map_or(0, |p| p.full_status_ms),
    };
    let Ok(json) = serde_json::to_vec(&Persisted {
        entries: entries.to_vec(),
        full_status_ms,
    }) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, json);
}

#[derive(Default)]
struct BaseCache {
    wc_db: HashMap<PathBuf, Option<SystemTime>>,
    files: HashMap<(PathBuf, String), Arc<Vec<u8>>>,
    bytes: usize,
}

static BASE_CACHE: LazyLock<Mutex<BaseCache>> = LazyLock::new(|| Mutex::new(BaseCache::default()));

pub(super) fn base_bytes(root: &Path, rel: &str) -> Result<Vec<u8>, VcsError> {
    let wc_db = wc_db_stamp(root);
    let key = (root.to_path_buf(), rel.to_string());
    {
        let mut cache = BASE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if cache.wc_db.get(root) != Some(&wc_db) {
            cache.files.retain(|(r, _), _| r != root);
            cache.bytes = cache.files.values().map(|b| b.len()).sum();
            cache.wc_db.insert(root.to_path_buf(), wc_db);
        }
        if let Some(hit) = cache.files.get(&key) {
            return Ok(hit.as_ref().clone());
        }
    }
    let mut target = root.join(rel).display().to_string();
    if target.contains('@') {
        target.push('@');
    }
    let bytes = run_bytes(root, &["cat", "-r", "BASE", "--", &target])?;
    if bytes.len() <= crate::git::diff::MAX_CACHED_FILE_BYTES as usize {
        let mut cache = BASE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if cache.wc_db.get(root) == Some(&wc_db) {
            if cache.bytes + bytes.len() > MAX_BASE_CACHE_BYTES {
                cache.files.clear();
                cache.bytes = 0;
            }
            cache.bytes += bytes.len();
            cache.files.insert(key, Arc::new(bytes.clone()));
        }
    }
    Ok(bytes)
}

#[cfg(test)]
pub(super) fn full_runs(root: &Path) -> usize {
    roots().get(root).map_or(0, |s| s.full_runs)
}

#[cfg(test)]
pub(super) fn seed_slow_baseline(root: &Path, entries: Vec<SvnStatusEntry>) {
    let mut roots = roots();
    let state = roots.entry(root.to_path_buf()).or_default();
    state.full_status_time = Some(SLOW_FULL_STATUS);
    state.store_baseline(entries, None, None);
}

#[cfg(test)]
pub(super) fn is_verified_and_tracked(root: &Path) -> bool {
    let roots = roots();
    let Some(state) = roots.get(root) else {
        return false;
    };
    !state.verifying
        && state
            .baseline
            .as_ref()
            .is_some_and(|b| state.tracks(b, wc_db_stamp(root)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, item: &str) -> SvnStatusEntry {
        SvnStatusEntry {
            path: path.into(),
            item: item.into(),
        }
    }

    #[test]
    fn ancestors_are_queried_alongside_each_changed_path() {
        let queried = with_ancestors(["a/b/c.txt", "a/d.txt", "top.txt"]);
        let mut sorted: Vec<_> = queried.into_iter().collect();
        sorted.sort();
        assert_eq!(sorted, vec!["a", "a/b", "a/b/c.txt", "a/d.txt", "top.txt"]);
    }

    #[test]
    fn merge_replaces_queried_paths_and_keeps_the_rest() {
        let base = vec![
            entry("keep.txt", "modified"),
            entry("src/a.txt", "modified"),
            entry("src/b.txt", "added"),
        ];
        let queried = with_ancestors(["src/a.txt", "src/new.txt"]);
        let fresh = vec![entry("src/new.txt", "unversioned")];
        let merged = merge(&base, &queried, fresh, |_| true);
        let paths: Vec<_> = merged
            .iter()
            .map(|e| (e.path.as_str(), e.item.as_str()))
            .collect();
        assert_eq!(
            paths,
            vec![
                ("keep.txt", "modified"),
                ("src/b.txt", "added"),
                ("src/new.txt", "unversioned")
            ]
        );
    }

    #[test]
    fn merge_drops_everything_under_a_vanished_directory() {
        let base = vec![
            entry("gone", "unversioned"),
            entry("gone/x.txt", "modified"),
            entry("gone2.txt", "modified"),
        ];
        let queried = with_ancestors(["gone"]);
        let merged = merge(&base, &queried, Vec::new(), |p| p != "gone");
        let paths: Vec<_> = merged.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["gone2.txt"]);
    }

    #[test]
    fn merge_keeps_children_of_a_directory_that_still_exists() {
        let base = vec![entry("game/res/a.xml", "modified")];
        let queried = with_ancestors(["game"]);
        let merged = merge(&base, &queried, Vec::new(), |_| true);
        assert_eq!(merged.len(), 1);
    }

    #[test]
    fn overflow_and_oversized_dirty_sets_lose_tracking() {
        let root = PathBuf::from("/virtual/overflow-root");
        watch_started(&root);
        let epoch = roots().get(&root).unwrap().watch_epoch;
        record_changes(&root, ["a.txt".to_string()], false);
        assert!(roots().get(&root).unwrap().dirty.contains("a.txt"));
        record_changes(&root, Vec::new(), true);
        let state_epoch = roots().get(&root).unwrap().watch_epoch;
        assert_ne!(state_epoch, epoch);
        assert!(roots().get(&root).unwrap().dirty.is_empty());
        record_changes(
            &root,
            (0..=MAX_TARGETED_PATHS).map(|i| format!("f{i}")),
            false,
        );
        assert!(roots().get(&root).unwrap().dirty.is_empty());
        watch_stopped(&root);
    }
}
