//! Delta Ignore: paths muted from review noise. Three layered sources, all
//! gitignore syntax, merged weakest → strongest (later lines win, like git):
//!
//! 1. global  — `<app data>/deltaignore`, every repo on this machine, edited
//!    in Settings (the home for common offenders: codegen, lockfiles, vendored
//!    SDKs);
//! 2. project — `<worktree>/.deltaignore`, committed and shared with the team;
//! 3. local   — `<git dir>/info/deltaignore`, this checkout only and never
//!    committed (Delta's `.git/info/exclude`): mute a huge vendored monorepo
//!    or local codegen without touching the project.
//!
//! Precedence is gitignore last-match-wins in that order (local strongest) at
//! equal path granularity; a file-granular pattern beats a directory-granular
//! one from any layer, since matching walks deepest-first.
//!
//! Compiled rulesets are memoized per worktree, keyed on each source's
//! mtime+len plus a process epoch (`notify_rules_changed`), so the per-build
//! `for_repo` call costs three stat()s on the steady path instead of
//! re-reading and re-compiling the files.
use git2::Repository;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::SystemTime;

pub const DELTAIGNORE_FILE: &str = ".deltaignore";
/// This checkout's never-committed rules, relative to the git common dir.
pub const LOCAL_DELTAIGNORE_FILE: &str = "info/deltaignore";
/// File name of the global rules inside the app data dir.
pub const GLOBAL_DELTAIGNORE_FILE: &str = "deltaignore";

/// Set once at app startup (lib.rs); absent in tests and before setup.
static GLOBAL_FILE: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn set_global_file(path: PathBuf) {
    *GLOBAL_FILE.write().unwrap_or_else(|e| e.into_inner()) = Some(path);
}

fn global_file() -> Option<PathBuf> {
    GLOBAL_FILE.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// mtime+len of one source file; `None` when it is absent.
type Stamp = Option<(SystemTime, u64)>;

fn stamp(path: &Path) -> Stamp {
    std::fs::metadata(path)
        .ok()
        .map(|m| (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len()))
}

/// Bumped whenever the app itself rewrites rules (Settings saves), so the memo
/// cache can never serve pre-write rules on a filesystem coarse enough to miss
/// the change in mtime+len alone.
static RULES_EPOCH: AtomicU64 = AtomicU64::new(0);

pub fn notify_rules_changed() {
    RULES_EPOCH.fetch_add(1, Ordering::Relaxed);
}

type RulesCache = HashMap<PathBuf, (u64, [Stamp; 3], DeltaIgnore)>;

static CACHE: LazyLock<Mutex<RulesCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
pub struct DeltaIgnore(Arc<Gitignore>);

/// The repo's common dir — the main checkout's `.git`, shared by its linked
/// worktrees. git2 doesn't bind `git_repository_commondir`, so derive it from
/// the per-worktree path, where linked worktrees sit at
/// `<common>/worktrees/<name>`.
fn commondir(repo: &Repository) -> PathBuf {
    let path = repo.path();
    if let Some(worktrees) = path.parent() {
        if worktrees.file_name().is_some_and(|n| n == "worktrees") {
            if let Some(common) = worktrees.parent() {
                return common.to_path_buf();
            }
        }
    }
    path.to_path_buf()
}

impl DeltaIgnore {
    fn empty() -> Self {
        Self(Arc::new(Gitignore::empty()))
    }

    /// Merge the sources weakest→strongest into one ruleset. A line that fails
    /// to parse is skipped — the crate's file-level `add` would collect the
    /// error and `build` would then drop EVERY rule, so one typo must not mute
    /// the world — and a missing file simply contributes nothing.
    fn layered(root: &Path, sources: [Option<&Path>; 3]) -> Self {
        let mut builder = GitignoreBuilder::new(root);
        for path in sources.into_iter().flatten() {
            if let Ok(text) = std::fs::read_to_string(path) {
                for line in text.lines() {
                    let _ = builder.add_line(Some(path.to_path_buf()), line);
                }
            }
        }
        Self(Arc::new(builder.build().unwrap_or_else(|_| Gitignore::empty())))
    }

    /// All three layers for the repo's worktree, memoized (see module doc).
    pub fn for_repo(repo: &Repository) -> Self {
        let Some(root) = repo.workdir() else { return Self::empty() };
        Self::memoized(
            root,
            [
                global_file(),
                Some(root.join(DELTAIGNORE_FILE)),
                Some(commondir(repo).join(LOCAL_DELTAIGNORE_FILE)),
            ],
        )
    }

    /// Rules for a non-git working copy (SVN): global + project layers —
    /// there is no never-committed local slot outside git in v1, so callers
    /// pass `None`. Memoized like `for_repo`.
    pub fn for_worktree(root: &Path, local: Option<PathBuf>) -> Self {
        Self::memoized(root, [global_file(), Some(root.join(DELTAIGNORE_FILE)), local])
    }

    /// Build (or serve the memoized) ruleset for `root` from up to three
    /// layered sources, weakest first.
    fn memoized(root: &Path, sources: [Option<PathBuf>; 3]) -> Self {
        let stamps = sources.each_ref().map(|p| p.as_deref().and_then(stamp));
        let epoch = RULES_EPOCH.load(Ordering::Relaxed);
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_epoch, cached_stamps, cached)) = cache.get(root) {
            if *cached_epoch == epoch && *cached_stamps == stamps {
                return cached.clone();
            }
        }
        let ignore = Self::layered(root, sources.each_ref().map(|p| p.as_deref()));
        cache.insert(root.to_path_buf(), (epoch, stamps, ignore.clone()));
        ignore
    }

    pub fn is_ignored(&self, rel_path: &str) -> bool {
        self.0.matched_path_or_any_parents(rel_path, false).is_ignore()
    }

    /// This checkout's local rules, for the Settings editor.
    pub fn local_rules(repo: &Repository) -> String {
        read_rules(&commondir(repo).join(LOCAL_DELTAIGNORE_FILE))
    }

    pub fn write_local_rules(repo: &Repository, rules: &str) -> Result<(), String> {
        write_rules(&commondir(repo).join(LOCAL_DELTAIGNORE_FILE), rules)
    }

    /// The machine-wide rules, for the Settings editor.
    pub fn global_rules() -> String {
        global_file().map(|p| read_rules(&p)).unwrap_or_default()
    }

    pub fn write_global_rules(path: &Path, rules: &str) -> Result<(), String> {
        write_rules(path, rules)
    }
}

fn read_rules(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn write_rules(path: &Path, rules: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    std::fs::write(path, rules).map_err(|e| format!("write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    /// Project rules only — the original single-source behavior.
    fn with_rules(rules: &str) -> (tempfile::TempDir, DeltaIgnore) {
        let dir = tempfile::TempDir::new().unwrap();
        let project = dir.path().join(DELTAIGNORE_FILE);
        std::fs::write(&project, rules).unwrap();
        let ignore = DeltaIgnore::layered(dir.path(), [None, Some(&project), None]);
        (dir, ignore)
    }

    /// All three layers from plain dirs — `layered` takes explicit paths so
    /// tests stay hermetic (no process-global `set_global_file`).
    fn with_layers(global: &str, project: &str, local: &str) -> DeltaIgnore {
        let dir = tempfile::TempDir::new().unwrap();
        let gdir = tempfile::TempDir::new().unwrap();
        let global_path = gdir.path().join(GLOBAL_DELTAIGNORE_FILE);
        let project_path = dir.path().join(DELTAIGNORE_FILE);
        let local_path = dir.path().join(".git").join(LOCAL_DELTAIGNORE_FILE);
        std::fs::write(&global_path, global).unwrap();
        std::fs::write(&project_path, project).unwrap();
        std::fs::create_dir_all(local_path.parent().unwrap()).unwrap();
        std::fs::write(&local_path, local).unwrap();
        DeltaIgnore::layered(dir.path(), [Some(&global_path), Some(&project_path), Some(&local_path)])
    }

    #[test]
    fn matches_gitignore_patterns() {
        let (_dir, ig) = with_rules("generated/\n*.gen.ts\n/root-only.txt\n");
        assert!(ig.is_ignored("generated/api.ts"));
        assert!(ig.is_ignored("pkg/generated/deep/file.xml"));
        assert!(ig.is_ignored("src/client.gen.ts"));
        assert!(ig.is_ignored("root-only.txt"));
        assert!(!ig.is_ignored("src/root-only.txt"));
        assert!(!ig.is_ignored("src/client.ts"));
    }

    #[test]
    fn negation_re_includes_a_path() {
        let (_dir, ig) = with_rules("generated/**\n!generated/keep.ts\n");
        assert!(ig.is_ignored("generated/drop.ts"));
        assert!(!ig.is_ignored("generated/keep.ts"));
    }

    #[test]
    fn missing_file_ignores_nothing() {
        assert!(!with_layers("", "", "").is_ignored("anything.ts"));
    }

    #[test]
    fn layers_merge_with_local_strongest_and_global_weakest() {
        // Same-granularity ties go to the later layer (gitignore last-match-wins).
        let ig = with_layers("*.gen.ts\n", "", "");
        assert!(ig.is_ignored("pkg/schema.gen.ts"));

        // Project beats global…
        let ig = with_layers("*.gen.ts\n", "!src/api.gen.ts\n", "");
        assert!(!ig.is_ignored("src/api.gen.ts"));

        // …and local beats project. (A file-granular rule also beats a dir-level
        // one from ANY layer — `matched_path_or_any_parents` walks deepest-first —
        // so overriding a per-file re-include needs a per-file local rule.)
        let ig = with_layers("*.gen.ts\n", "!src/api.gen.ts\n", "src/api.gen.ts\n");
        assert!(ig.is_ignored("src/api.gen.ts"));

        // A dir-level mute + a local re-include for one file beneath it.
        let ig = with_layers("", "sealed/\n", "!sealed/keep.rs\n");
        assert!(ig.is_ignored("sealed/drop.rs"));
        assert!(!ig.is_ignored("sealed/keep.rs"));

        let ig = with_layers("", "", "vendor/\n");
        assert!(ig.is_ignored("vendor/huge-monorepo/x.ts"));
    }

    #[test]
    fn one_invalid_line_does_not_disable_the_rest() {
        let ig = with_layers("[unclosed\n", "*.ok.ts\n", "");
        assert!(ig.is_ignored("src/generated.ok.ts"));
    }

    #[test]
    fn for_repo_layers_the_local_file_and_reloads_on_change() {
        let (dir, repo) = repo_with_commit();
        write(dir.path(), ".git/info/deltaignore", "gen/\n");

        let ig = DeltaIgnore::for_repo(&repo);
        assert!(ig.is_ignored("gen/api.ts"));
        assert!(!ig.is_ignored("src/main.ts"));

        // The memo cache must notice the rewrite (mtime+len fingerprint) and
        // rebuild, not keep serving the first compile.
        write(dir.path(), ".git/info/deltaignore", "src/\n");
        let ig = DeltaIgnore::for_repo(&repo);
        assert!(!ig.is_ignored("gen/api.ts"));
        assert!(ig.is_ignored("src/main.ts"));
    }

    #[test]
    fn for_repo_still_honors_the_project_file() {
        let (dir, repo) = repo_with_commit();
        write(dir.path(), ".deltaignore", "generated/\n");
        assert!(DeltaIgnore::for_repo(&repo).is_ignored("generated/x.xml"));
    }

    #[test]
    fn local_rules_round_trip_through_the_git_dir() {
        let (dir, repo) = repo_with_commit();
        DeltaIgnore::write_local_rules(&repo, "vendor/\n").unwrap();
        assert_eq!(DeltaIgnore::local_rules(&repo), "vendor/\n");
        assert!(dir.path().join(".git/info/deltaignore").is_file());
        assert!(DeltaIgnore::for_repo(&repo).is_ignored("vendor/huge.ts"));
    }
}
