//! The VCS layer — the single place "which version control system is this
//! directory?" is decided, and the enum every consumer works against after
//! that. Git has priority: each ancestor directory is probed for `.git`
//! before `.svn`, so a git-svn working copy (both markers present) opens as
//! git, and the nearest marker wins over a farther one (an SVN checkout
//! nested inside a git monorepo is still an SVN working copy).
//!
//! Consumers never branch on the kind themselves: they call `Repo` methods,
//! which dispatch internally. The frontend mirrors this with a capability
//! profile (`vcsProfile`) derived from the `vcs` field on `ReviewSession`.
//!
//! The source-resolution model shared by both backends lives here too:
//! `FileSources`/`FileHeader`/`FullDiff` describe *where a file's two sides
//! live* without saying how to read them — each backend fills in its own
//! side variants and `Repo::read_source`/`source_size` do the dispatch.
pub mod svn;

use crate::git;
use crate::git::diff::{BinaryFileDiff, DiffSummary, FileDiff, FileStatus};
use crate::git::log::CommitPage;
use crate::git::model::{DiffMode, Target};
use crate::registry::model::{RepoEntry, WorktreeEntry};
use crate::review::model::Snapshot;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, RwLock};

pub type VcsError = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VcsKind {
    #[default]
    Git,
    Svn,
}

pub enum Repo {
    Git(git2::Repository),
    Svn(svn::SvnRepo),
}

/// Manual per-repo kind overrides — the hidden `vcsOverride` field on a
/// registry `RepoEntry`, keyed by canonical repo root. Loaded from the
/// registry at startup (see lib.rs); edited by hand in registry.json, never
/// from the UI. `Registry::upsert_repo` preserves the field so metadata
/// refreshes don't wipe it.
static OVERRIDES: LazyLock<RwLock<HashMap<PathBuf, VcsKind>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// Replace the override table wholesale (startup path).
pub fn set_overrides(overrides: HashMap<PathBuf, VcsKind>) {
    *OVERRIDES.write().unwrap_or_else(|e| e.into_inner()) = overrides;
}

fn marker_exists(root: &Path, kind: VcsKind) -> bool {
    match kind {
        VcsKind::Git => root.join(".git").exists(),
        VcsKind::Svn => root.join(".svn").is_dir(),
    }
}

/// Walk up from `start`, probing `.git` before `.svn` at each level: git wins
/// at equal depth, the nearest marker wins overall. Pure metadata — no
/// process spawn, no network, and deliberately NOT memoized: an override
/// applied later must take effect on the next open, and the walk is only a
/// handful of stat()s anyway (the same cost class as git's own discover).
fn detect_markers(start: &Path) -> Option<(VcsKind, PathBuf)> {
    let mut dir = std::fs::canonicalize(start).ok()?;
    loop {
        if dir.join(".git").exists() {
            return Some((VcsKind::Git, dir));
        }
        if dir.join(".svn").is_dir() {
            return Some((VcsKind::Svn, dir));
        }
        dir = dir.parent()?.to_path_buf();
    }
}

/// An override only ever downgrades to a kind whose marker still exists at
/// the detected root — it forces the choice between two real repos, it
/// cannot conjure one.
fn apply_override(root: &Path, detected: VcsKind) -> VcsKind {
    OVERRIDES
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(root)
        .copied()
        .filter(|k| *k != detected && marker_exists(root, *k))
        .unwrap_or(detected)
}

impl Repo {
    /// Discover and open the repository containing `path` — the app's only
    /// entry point (the old single-VCS `git::open_repo`).
    pub fn open(path: &str) -> Result<Repo, VcsError> {
        let Some((kind, root)) = detect_markers(Path::new(path)) else {
            // No markers anywhere. Honor a GIT_DIR-style setup discover can
            // still resolve before rejecting the path outright.
            return git2::Repository::discover(path)
                .map(Repo::Git)
                .map_err(|_| format!("{path} is not a git or svn working copy"));
        };
        match apply_override(&root, kind) {
            VcsKind::Git => git2::Repository::discover(path)
                .map(Repo::Git)
                .map_err(|e| format!("open repo: {e}")),
            VcsKind::Svn => Ok(Repo::Svn(svn::SvnRepo::new(root))),
        }
    }

    pub fn kind(&self) -> VcsKind {
        match self {
            Repo::Git(_) => VcsKind::Git,
            Repo::Svn(_) => VcsKind::Svn,
        }
    }

    /// The directory the user edits: the git workdir / the SVN WC root.
    pub fn root(&self) -> PathBuf {
        match self {
            Repo::Git(repo) => repo
                .workdir()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| PathBuf::from(repo.path().display().to_string())),
            Repo::Svn(s) => s.root().to_path_buf(),
        }
    }

    /// The review-identity label: the checked-out branch for git, the last
    /// URL segment for SVN ("trunk", a branch name).
    pub fn worktree_label(&self) -> Result<String, VcsError> {
        match self {
            Repo::Git(repo) => git::resolve_worktree(repo),
            Repo::Svn(s) => Ok(s.worktree_label()),
        }
    }

    /// Diff modes this backend can compute. SVN's v1 pipeline is
    /// working-copy-only, so everything else coerces to Uncommitted.
    pub fn available_modes(&self) -> &'static [DiffMode] {
        match self {
            Repo::Git(_) => &[
                DiffMode::AllChanges,
                DiffMode::Uncommitted,
                DiffMode::LastCommit,
                DiffMode::BranchVsBase,
                DiffMode::Commit,
            ],
            Repo::Svn(_) => &[DiffMode::Uncommitted],
        }
    }

    /// Degrade a mode the backend can't compute instead of erroring — a
    /// stale deep link or persisted review must still open.
    pub fn coerce_mode(&self, mode: DiffMode) -> DiffMode {
        if self.available_modes().contains(&mode) {
            mode
        } else {
            DiffMode::Uncommitted
        }
    }

    /// Canonical display name: the main worktree's dir name for git, the WC
    /// root's dir name for SVN.
    pub fn display_name(&self) -> String {
        let fallback_root = match self {
            Repo::Git(repo) => repo
                .workdir()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            Repo::Svn(s) => s.root().display().to_string(),
        };
        let name_root = match self {
            Repo::Git(repo) => git::main_worktree_dir(repo)
                .map(|p| p.display().to_string())
                .unwrap_or(fallback_root),
            Repo::Svn(_) => fallback_root,
        };
        crate::registry::model::repo_name_from_path(&name_root)
    }

    /// The snapshot refresh: what "base" and "head" mean right now. Git
    /// resolves tree OIDs per mode; SVN has one working-copy anchor (BASE,
    /// the pristine revision the diff reads against).
    pub fn snapshot_of(&self, target: &Target) -> Result<Snapshot, VcsError> {
        let now = chrono::Utc::now().to_rfc3339();
        match self {
            Repo::Git(repo) => {
                let ep = git::resolve_endpoints(repo, target)?;
                let head_commit = repo
                    .head()
                    .ok()
                    .and_then(|h| h.peel_to_commit().ok())
                    .map(|c| c.id().to_string());
                Ok(Snapshot {
                    base_oid: ep.from_tree.map(|o| o.to_string()).unwrap_or_default(),
                    head_oid: match ep.right {
                        git::RightSide::Tree(o) => Some(o.to_string()),
                        git::RightSide::WorkTree => None,
                    },
                    head_commit,
                    captured_at: now,
                })
            }
            Repo::Svn(_) => Ok(Snapshot {
                base_oid: "BASE".into(),
                head_oid: None,
                head_commit: None,
                captured_at: now,
            }),
        }
    }

    pub fn list_commits(&self, target: &Target, skip: usize, limit: usize) -> Result<CommitPage, VcsError> {
        match self {
            Repo::Git(_) => crate::git::log::list_commits(target, skip, limit),
            // No history features in the SVN v1: the frontend hides the
            // commit stepper by capability, so an empty page is all it needs.
            Repo::Svn(_) => Ok(CommitPage { commits: Vec::new(), has_more: false }),
        }
    }

    pub fn list_worktrees(&self) -> Result<Vec<WorktreeEntry>, VcsError> {
        match self {
            Repo::Git(repo) => crate::launch::list_git_worktrees(repo),
            Repo::Svn(s) => Ok(s.list_worktrees()),
        }
    }

    pub fn repo_entry(&self) -> Result<RepoEntry, VcsError> {
        match self {
            Repo::Git(repo) => crate::launch::git_repo_entry(repo),
            Repo::Svn(s) => Ok(s.repo_entry()),
        }
    }

    pub fn compute_diff_full(&self, target: &Target) -> Result<FullDiff, VcsError> {
        match self {
            Repo::Git(repo) => git::diff::compute_diff_full(repo, target),
            Repo::Svn(s) => s.compute_diff_full(target),
        }
    }

    pub fn get_file_diff(&self, target: &Target, path: &str) -> Result<FileDiff, VcsError> {
        match self {
            Repo::Git(repo) => git::diff::get_file_diff(repo, target, path),
            Repo::Svn(s) => s.get_file_diff(target, path),
        }
    }

    fn fresh_sources(&self, target: &Target, path: &str) -> Result<FileSources, VcsError> {
        match self {
            Repo::Git(repo) => git::diff::fresh_sources(repo, target, path),
            Repo::Svn(s) => s.fresh_sources(target, path),
        }
    }

    /// Run `f` on `path`'s byte sources resolved by a one-off whole-repo
    /// diff — the fallback when no cached snapshot has them.
    pub fn with_fresh_sources<T>(
        target: &Target,
        path: &str,
        f: impl FnOnce(&Repo, &FileSources) -> T,
    ) -> Result<T, VcsError> {
        let t = std::time::Instant::now();
        let repo = Repo::open(&target.repo_path)?;
        let sources = repo.fresh_sources(target, path)?;
        crate::perf::log("fresh_sources", path, t);
        Ok(f(&repo, &sources))
    }

    // --- byte sources (shared by the blob scheme, binary sizes, extraction) ---
    //
    // Reads are `Result<Option<..>>`: `Err` is a real failure (svn CLI
    // missing, pristine unreadable) that callers must surface, `Ok(None)` is
    // "this side genuinely has no bytes" (an added file's old side).

    pub fn read_source(&self, sources: &FileSources, side: BlobSide) -> Result<Option<Vec<u8>>, VcsError> {
        let git_blob = |oid: git2::Oid| -> Option<Vec<u8>> {
            match self {
                Repo::Git(repo) => repo.find_blob(oid).ok().map(|b| b.content().to_vec()),
                Repo::Svn(_) => None,
            }
        };
        match side {
            BlobSide::Old => match &sources.old {
                OldSide::GitBlob(oid) => Ok(git_blob(*oid)),
                OldSide::SvnBase { root, rel, pinned } => match pinned {
                    Some(PinnedBase::Bytes(bytes)) => Ok(Some(bytes.as_ref().clone())),
                    Some(PinnedBase::Unavailable) => Ok(None),
                    None => svn::cat_base(root, rel).map(Some),
                },
                OldSide::Absent => Ok(None),
            },
            BlobSide::New => match &sources.new {
                NewSide::WorkTree(path) => Ok(std::fs::read(path).ok()),
                NewSide::Blob(oid) => Ok(git_blob(*oid)),
                NewSide::Absent => Ok(None),
            },
        }
    }

    pub fn source_size(&self, sources: &FileSources, side: BlobSide) -> Result<Option<u64>, VcsError> {
        let git_blob_size = |oid: git2::Oid| -> Option<u64> {
            match self {
                Repo::Git(repo) => {
                    repo.odb().ok()?.read_header(oid).ok().map(|(size, _)| size as u64)
                }
                Repo::Svn(_) => None,
            }
        };
        match side {
            BlobSide::Old => match &sources.old {
                OldSide::GitBlob(oid) => Ok(git_blob_size(*oid)),
                OldSide::SvnBase { root, rel, pinned } => match pinned {
                    Some(PinnedBase::Bytes(bytes)) => Ok(Some(bytes.len() as u64)),
                    Some(PinnedBase::Unavailable) => Ok(None),
                    None => svn::cat_base(root, rel).map(|b| Some(b.len() as u64)),
                },
                OldSide::Absent => Ok(None),
            },
            BlobSide::New => match &sources.new {
                NewSide::WorkTree(path) => Ok(std::fs::metadata(path).ok().map(|m| m.len())),
                NewSide::Blob(oid) => Ok(git_blob_size(*oid)),
                NewSide::Absent => Ok(None),
            },
        }
    }

    pub fn binary_sizes(&self, sources: &FileSources) -> Result<BinaryFileDiff, VcsError> {
        Ok(BinaryFileDiff {
            old_size: self.source_size(sources, BlobSide::Old)?,
            new_size: self.source_size(sources, BlobSide::New)?,
        })
    }

    /// Extract a `FileDiff` from a header + sources: reads both sides,
    /// applies CRLF normalization, flags binary, drops binary content.
    /// Shared shape for both backends — only the CRLF decision differs.
    pub fn extract_file_diff(&self, header: &FileHeader, sources: &FileSources) -> Result<FileDiff, VcsError> {
        let old_bytes = self.read_source(sources, BlobSide::Old)?;
        let new_raw = self.read_source(sources, BlobSide::New)?;
        Ok(self.file_diff_from_sides(header, old_bytes, new_raw))
    }

    /// The shared extraction tail: CRLF decision is backend-specific
    /// (git: `core.autocrlf`; svn: BASE pure-LF vs working CRLF), the rest —
    /// binary flagging, content drop, lossy UTF-8 — is common.
    pub(crate) fn file_diff_from_sides(
        &self,
        header: &FileHeader,
        old_bytes: Option<Vec<u8>>,
        new_bytes_raw: Option<Vec<u8>>,
    ) -> FileDiff {
        let normalize = match self {
            Repo::Git(repo) => git::diff::normalizes_crlf(repo),
            Repo::Svn(_) => svn::base_is_lf_working_is_crlf(
                old_bytes.as_deref(),
                new_bytes_raw.as_deref(),
            ),
        };
        let new_bytes = match new_bytes_raw {
            Some(b) if normalize => Some(strip_cr(b)),
            other => other,
        };
        file_diff_from_bytes(header, old_bytes, new_bytes)
    }
}

/// Strip `\r` from `\r\n` pairs (CRLF → LF) without touching lone CRs, so an
/// image's stray `\r` bytes survive. Shared by the git and SVN normalization.
pub(crate) fn strip_cr(bytes: Vec<u8>) -> Vec<u8> {
    if !bytes.windows(2).any(|w| w == b"\r\n") {
        return bytes;
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut prev_cr = false;
    for b in bytes {
        if prev_cr && b != b'\n' {
            out.push(b'\r');
        }
        prev_cr = b == b'\r';
        if !prev_cr {
            out.push(b);
        }
    }
    if prev_cr {
        out.push(b'\r');
    }
    out
}

// ---------------------------------------------------------------------------
// Shared source-resolution model (constructed by each backend, read via Repo)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlobSide {
    Old,
    New,
}

/// How the SVN old side answers later reads. Git blobs are immutable, but a
/// SVN BASE moves the moment the user commits or updates — re-reading
/// `svn cat -r BASE` under a still-displayed snapshot could serve different
/// bytes than the window shows (wrong image previews especially). A snapshot
/// therefore PINS what it read: binary sides under the cache cap keep their
/// bytes in memory, over-cap sides are marked unavailable rather than lying.
/// `None` means "live read" for one-off (non-snapshot) resolutions, where
/// current BASE is exactly what's wanted.
#[derive(Debug, Clone)]
pub enum PinnedBase {
    Bytes(Arc<Vec<u8>>),
    Unavailable,
}

/// Where one delta's old side lives: a git blob, or SVN's BASE pristine
/// (`svn cat -r BASE`).
#[derive(Debug, Clone)]
pub enum OldSide {
    GitBlob(git2::Oid),
    SvnBase { root: PathBuf, rel: String, pinned: Option<PinnedBase> },
    Absent,
}

#[derive(Debug, Clone)]
pub enum NewSide {
    WorkTree(PathBuf),
    Blob(git2::Oid),
    Absent,
}

/// Where one delta's two sides live. Resolved while the diff is built, so
/// reading the bytes later needs no second whole-repo diff.
#[derive(Debug, Clone)]
pub struct FileSources {
    pub(crate) old: OldSide,
    pub(crate) new: NewSide,
}

impl FileSources {
    pub(crate) fn new(old: OldSide, new: NewSide) -> Self {
        FileSources { old, new }
    }
}

/// Detached from a backend's delta walk so a cached snapshot can extract one
/// file without rebuilding it.
#[derive(Debug, Clone)]
pub struct FileHeader {
    pub(crate) status: FileStatus,
    pub(crate) old_path: Option<String>,
    pub(crate) new_path: Option<String>,
    pub(crate) binary: bool,
}

impl FileHeader {
    pub(crate) fn new(status: FileStatus, old_path: Option<String>, new_path: Option<String>, binary: bool) -> Self {
        FileHeader { status, old_path, new_path, binary }
    }
}

/// One whole-repo diff computation: the file-list summary, every file's
/// extracted content (bounded — see `git::diff`'s caps), and every file's
/// byte sources + headers for on-demand extraction.
pub struct FullDiff {
    pub summary: DiffSummary,
    pub files: HashMap<String, FileDiff>,
    pub sources: HashMap<String, FileSources>,
    pub headers: HashMap<String, FileHeader>,
}

/// FileEntry with stats, shared by both backends' summary builders.
pub(crate) fn file_entry(
    path: String,
    status: FileStatus,
    additions: usize,
    deletions: usize,
    binary: bool,
    bytes: u64,
    ignored: bool,
) -> crate::git::diff::FileEntry {
    crate::git::diff::FileEntry {
        path,
        old_path: None,
        status,
        additions,
        deletions,
        binary,
        bytes,
        ignored,
    }
}

/// The extraction tail shared by both backends: binary flag from the header
/// plus content sniff, CRLF already applied by the caller, binary content
/// dropped (the UI shows an "Unsupported file" placeholder).
pub(crate) fn file_diff_from_bytes(
    header: &FileHeader,
    old_bytes: Option<Vec<u8>>,
    new_bytes: Option<Vec<u8>>,
) -> FileDiff {
    let binary = header.binary
        || old_bytes.as_deref().map(git::diff::looks_binary).unwrap_or(false)
        || new_bytes.as_deref().map(git::diff::looks_binary).unwrap_or(false);
    let old_content =
        if binary { None } else { old_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()) };
    let new_content =
        if binary { None } else { new_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()) };
    FileDiff {
        old_file_name: header.old_path.clone(),
        new_file_name: header.new_path.clone(),
        old_content,
        new_content,
        status: header.status,
        binary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create `dir/name`'s parent dirs and an empty file (a `.git` marker
    /// with internals, or any plain sentinel).
    fn touch(dir: &Path, name: &str) {
        let p = dir.join(name);
        std::fs::create_dir_all(p.parent().unwrap_or(dir)).unwrap();
        std::fs::write(&p, b"").unwrap();
    }

    /// A `.svn` marker is a directory.
    fn touch_svn(dir: &Path) {
        std::fs::create_dir_all(dir.join(".svn")).unwrap();
    }

    #[test]
    fn detect_prefers_git_when_both_markers_present() {
        let dir = tempfile::TempDir::new().unwrap();
        touch(dir.path(), ".git/HEAD");
        touch_svn(dir.path());
        let (kind, root) = detect_markers(dir.path()).unwrap();
        assert_eq!(kind, VcsKind::Git);
        assert_eq!(root, std::fs::canonicalize(dir.path()).unwrap());
    }

    #[test]
    fn detect_finds_svn_when_only_svn_present() {
        let dir = tempfile::TempDir::new().unwrap();
        touch_svn(dir.path());
        let (kind, _) = detect_markers(dir.path()).unwrap();
        assert_eq!(kind, VcsKind::Svn);
    }

    #[test]
    fn detect_walks_up_and_nearest_marker_wins() {
        let outer = tempfile::TempDir::new().unwrap();
        // A git monorepo…
        touch(outer.path(), ".git/HEAD");
        // …with an SVN working copy nested inside it.
        let inner = outer.path().join("vendor-svn");
        touch_svn(&inner);
        let (kind, root) = detect_markers(&inner).unwrap();
        assert_eq!(kind, VcsKind::Svn, "the nearest marker must win over the outer .git");
        assert_eq!(root, std::fs::canonicalize(&inner).unwrap());

        // And a plain subdir of the git repo (no own markers) still resolves
        // to the outer git root.
        let sub = outer.path().join("src/pkg");
        touch(&sub, "mod.rs");
        let (kind, root) = detect_markers(&sub).unwrap();
        assert_eq!(kind, VcsKind::Git);
        assert_eq!(root, std::fs::canonicalize(outer.path()).unwrap());
    }

    #[test]
    fn detect_from_subdir_of_svn_wc_finds_wc_root() {
        let dir = tempfile::TempDir::new().unwrap();
        touch_svn(dir.path());
        let sub = dir.path().join("deep/nested");
        touch(&sub, "a.txt");
        let (kind, root) = detect_markers(&sub).unwrap();
        assert_eq!(kind, VcsKind::Svn);
        assert_eq!(root, std::fs::canonicalize(dir.path()).unwrap());
    }

    #[test]
    fn detect_rejects_plain_directory() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(detect_markers(dir.path()).is_none());
    }

    #[test]
    fn override_only_applies_to_real_markers() {
        let dir = tempfile::TempDir::new().unwrap();
        touch(dir.path(), ".git/HEAD");
        touch_svn(dir.path());
        let root = std::fs::canonicalize(dir.path()).unwrap();

        // Forcing SVN on a git-svn dir: .svn exists → honored.
        OVERRIDES.write().unwrap().insert(root.clone(), VcsKind::Svn);
        assert_eq!(apply_override(&root, VcsKind::Git), VcsKind::Svn);

        // Forcing SVN where there is no .svn: ignored, detected kind stands.
        let git_only = tempfile::TempDir::new().unwrap();
        touch(git_only.path(), ".git/HEAD");
        let git_root = std::fs::canonicalize(git_only.path()).unwrap();
        OVERRIDES.write().unwrap().insert(git_root.clone(), VcsKind::Svn);
        assert_eq!(apply_override(&git_root, VcsKind::Git), VcsKind::Git);

        OVERRIDES.write().unwrap().clear();
    }

    #[test]
    fn strip_cr_removes_only_crlf_pairs() {
        assert_eq!(strip_cr(b"a\r\nb\r\nc".to_vec()), b"a\nb\nc".to_vec());
        assert_eq!(strip_cr(b"\rX".to_vec()), b"\rX".to_vec());
        assert_eq!(strip_cr(b"no eol".to_vec()), b"no eol".to_vec());
    }

    #[test]
    fn open_rejects_plain_dir_with_friendly_message() {
        let dir = tempfile::TempDir::new().unwrap();
        let err = match Repo::open(dir.path().to_str().unwrap()) {
            Err(e) => e,
            Ok(_) => panic!("a plain directory must not open as a repo"),
        };
        assert!(err.contains("not a git or svn working copy"), "got: {err}");
    }
}
