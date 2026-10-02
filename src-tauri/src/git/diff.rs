use crate::git::deltaignore::DeltaIgnore;
use crate::git::model::Target;
use crate::git::{resolve_endpoints, Endpoints, GitError, RightSide};
use git2::{Diff, DiffDelta, DiffFindOptions, DiffOptions, Oid, Repository};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;

// The source-resolution model is VCS-shared and lives in `vcs`; re-exported
// here so existing imports keep resolving.
pub use crate::vcs::{BlobSide, FileHeader, FileSources, FullDiff, NewSide, OldSide};

/// Eager-extraction memory bounds for `compute_diff_full` (the cached path). A file
/// whose recorded size exceeds the per-file cap is left out of the map (served by a
/// one-off `get_file_diff` on demand); once the retained snapshot passes the total
/// cap we stop extracting so a huge review can't balloon backend memory. Well above
/// any hand-reviewable file, so normal diffs are fully cached. (#perf)
pub(crate) const MAX_CACHED_FILE_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) const MAX_CACHED_SNAPSHOT_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
    pub bytes: u64,
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub files: Vec<FileEntry>,
    pub base_label: String,
    pub head_label: String,
}

pub fn build_diff<'r>(repo: &'r Repository, ep: &Endpoints) -> Result<Diff<'r>, GitError> {
    let mut opts = DiffOptions::new();
    // Without show_untracked_content libgit2 reports an untracked file as a delta it
    // never diffs, so the file lands in the summary with no line stats at all.
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    // ep.from_tree and RightSide::Tree carry tree OIDs (not commit OIDs),
    // as produced by tree_of() in resolve_endpoints.
    let from_tree = match ep.from_tree {
        Some(oid) => Some(repo.find_tree(oid).map_err(|e| e.to_string())?),
        None => None,
    };

    let mut diff = match &ep.right {
        RightSide::WorkTree => repo
            .diff_tree_to_workdir_with_index(from_tree.as_ref(), Some(&mut opts))
            .map_err(|e| format!("diff workdir: {e}"))?,
        RightSide::Tree(oid) => {
            let to = repo.find_tree(*oid).map_err(|e| e.to_string())?;
            repo.diff_tree_to_tree(from_tree.as_ref(), Some(&to), Some(&mut opts))
                .map_err(|e| format!("diff trees: {e}"))?
        }
    };

    let mut find = DiffFindOptions::new();
    find.renames(true);
    diff.find_similar(Some(&mut find))
        .map_err(|e| format!("find renames: {e}"))?;

    Ok(diff)
}

fn map_status(s: git2::Delta) -> FileStatus {
    match s {
        git2::Delta::Added | git2::Delta::Untracked | git2::Delta::Copied => FileStatus::Added,
        git2::Delta::Deleted => FileStatus::Deleted,
        git2::Delta::Renamed => FileStatus::Renamed,
        _ => FileStatus::Modified,
    }
}

/// Build the summary entry for one delta: path, rename old_path, status, +/- line
/// stats, and the binary flag. Shared by `compute_diff` (summary only) and
/// `compute_diff_full` (summary + content) so the two can't drift. (#perf)
fn summary_entry(
    diff: &Diff,
    idx: usize,
    delta: &DiffDelta,
    bytes: u64,
    ignore: &DeltaIgnore,
) -> FileEntry {
    let new_path = delta
        .new_file()
        .path()
        .map(|p| p.to_string_lossy().into_owned());
    let old_path = delta
        .old_file()
        .path()
        .map(|p| p.to_string_lossy().into_owned());
    let path = new_path
        .clone()
        .or_else(|| old_path.clone())
        .unwrap_or_default();
    let ignored = ignore.is_ignored(&path);
    let (additions, deletions) = if ignored {
        (0, 0)
    } else {
        line_stats(diff, idx)
    };

    FileEntry {
        path,
        old_path: old_path.filter(|o| Some(o) != new_path.as_ref()),
        status: map_status(delta.status()),
        additions,
        deletions,
        binary: delta.new_file().is_binary() || delta.old_file().is_binary(),
        bytes,
        ignored,
    }
}

fn line_stats(diff: &Diff, idx: usize) -> (usize, usize) {
    match git2::Patch::from_diff(diff, idx) {
        Ok(Some(p)) => {
            let (_ctx, add, del) = p.line_stats().unwrap_or((0, 0, 0));
            (add, del)
        }
        _ => (0, 0),
    }
}

fn recorded_bytes(delta: &DiffDelta) -> u64 {
    delta.new_file().size().max(delta.old_file().size())
}

fn source_bytes(repo: &Repository, sources: &FileSources) -> u64 {
    let old = sources.size_git(repo, BlobSide::Old).unwrap_or(0);
    let new = sources.size_git(repo, BlobSide::New).unwrap_or(0);
    old.max(new)
}

#[cfg(test)]
pub fn compute_diff(target: &Target) -> Result<DiffSummary, GitError> {
    let repo = crate::git::open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;
    let ignore = DeltaIgnore::for_repo(&repo);

    let files = diff
        .deltas()
        .enumerate()
        .map(|(idx, delta)| summary_entry(&diff, idx, &delta, recorded_bytes(&delta), &ignore))
        .collect();

    Ok(DiffSummary {
        files,
        base_label: ep.base_label,
        head_label: ep.head_label,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old_file_name: Option<String>,
    pub old_content: Option<String>,
    pub new_file_name: Option<String>,
    pub new_content: Option<String>,
    pub status: FileStatus,
    pub binary: bool,
}

/// Git's binary heuristic: a NUL byte within the first 8000 bytes means binary.
/// git2's `is_binary()` flag isn't reliably set during delta iteration, so we
/// also inspect the content ourselves — otherwise PNGs etc. render as garbage.
pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

/// Whether git stores this repo's text files with LF while the working copy holds
/// CRLF (`core.autocrlf=true|input`, the Windows default). The diff libgit2 reports
/// is filtered, so the content we hand the UI has to be filtered the same way — a
/// raw CRLF working file against an LF blob renders every line as changed.
pub(crate) fn normalizes_crlf(repo: &Repository) -> bool {
    repo.config()
        .and_then(|c| c.get_string("core.autocrlf"))
        .map(|v| v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("input"))
        .unwrap_or(false)
}

/// Locate the delta for `path` (match new path, else old path) in an already-built
/// diff. Shared by `get_file_diff` and `get_binary_file_diff`.
fn delta_for_path<'d>(diff: &'d Diff<'d>, path: &str) -> Option<DiffDelta<'d>> {
    diff.deltas().find(|d| {
        d.new_file()
            .path()
            .map(|p| p.to_string_lossy() == path)
            .unwrap_or(false)
            || d.old_file()
                .path()
                .map(|p| p.to_string_lossy() == path)
                .unwrap_or(false)
    })
}

/// Where one delta's two sides live: old from the from-tree blob, new from the
/// working tree (worktree modes) or the new blob (tree modes). Resolved while the
/// diff is built, so reading the bytes later needs no second whole-repo diff.
fn delta_sources(
    repo: &Repository,
    ep: &Endpoints,
    delta: &DiffDelta,
) -> Result<FileSources, GitError> {
    let old = match (ep.from_tree, delta.old_file().path()) {
        (Some(tree_oid), Some(op)) => {
            let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
            tree.get_path(op)
                .ok()
                .map(|entry| OldSide::GitBlob(entry.id()))
        }
        _ => None,
    }
    .unwrap_or(OldSide::Absent);
    let new_blob = delta.new_file().id();
    let new = match (&ep.right, delta.new_file().path()) {
        (RightSide::WorkTree, Some(np)) => {
            let wd = repo.workdir().ok_or("no working directory")?;
            NewSide::WorkTree(wd.join(np))
        }
        (RightSide::Tree(_), Some(_)) if !new_blob.is_zero() => NewSide::Blob(new_blob),
        _ => NewSide::Absent,
    };
    Ok(FileSources::new(old, new))
}

impl FileSources {
    /// Git-side size access for the hot extraction loop; cross-backend reads
    /// go through `vcs::Repo::source_size`.
    pub(crate) fn size_git(&self, repo: &Repository, side: BlobSide) -> Option<u64> {
        let blob_size = |oid: Oid| {
            repo.odb()
                .ok()?
                .read_header(oid)
                .ok()
                .map(|(size, _)| size as u64)
        };
        match side {
            BlobSide::Old => match &self.old {
                OldSide::GitBlob(oid) => blob_size(*oid),
                _ => None,
            },
            BlobSide::New => match &self.new {
                NewSide::WorkTree(path) => fs::metadata(path).ok().map(|m| m.len()),
                NewSide::Blob(oid) => blob_size(*oid),
                NewSide::Absent => None,
            },
        }
    }

    /// Git-side byte access for the hot extraction loop; cross-backend reads
    /// go through `vcs::Repo::read_source`.
    pub(crate) fn read_git(&self, repo: &Repository, side: BlobSide) -> Option<Vec<u8>> {
        let blob = |oid: Oid| repo.find_blob(oid).ok().map(|b| b.content().to_vec());
        match side {
            BlobSide::Old => match &self.old {
                OldSide::GitBlob(oid) => blob(*oid),
                _ => None,
            },
            BlobSide::New => match &self.new {
                NewSide::WorkTree(path) => fs::read(path).ok(),
                NewSide::Blob(oid) => blob(*oid),
                NewSide::Absent => None,
            },
        }
    }
}

/// Detached from the `Diff` so a cached snapshot can extract one file without rebuilding it.
impl FileHeader {
    fn of(delta: &DiffDelta) -> Self {
        let path_of = |f: git2::DiffFile| f.path().map(|p| p.to_string_lossy().to_string());
        FileHeader {
            status: map_status(delta.status()),
            old_path: path_of(delta.old_file()),
            new_path: path_of(delta.new_file()),
            binary: delta.new_file().is_binary() || delta.old_file().is_binary(),
        }
    }
}

pub fn get_file_diff(repo: &Repository, target: &Target, path: &str) -> Result<FileDiff, GitError> {
    let ep = resolve_endpoints(repo, target)?;
    let diff = build_diff(repo, &ep)?;

    let delta = delta_for_path(&diff, path).ok_or_else(|| format!("file not in diff: {path}"))?;
    let sources = delta_sources(repo, &ep, &delta)?;

    let header = FileHeader::of(&delta);
    let old_bytes = sources.read_git(repo, BlobSide::Old);
    let new_raw = sources.read_git(repo, BlobSide::New);
    let new_bytes = match new_raw {
        Some(b) if normalizes_crlf(repo) => Some(crate::vcs::strip_cr(b)),
        other => other,
    };
    Ok(crate::vcs::file_diff_from_bytes(
        &header, old_bytes, new_bytes,
    ))
}

/// Exact byte sizes of one binary file's two sides for the UI's binary/image card.
/// The delta's recorded size can read 0 for working-tree files, so sizes come from
/// the blob header / file metadata. Image bytes themselves travel over the
/// `delta-blob` URI scheme, never through IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryFileDiff {
    pub old_size: Option<u64>,
    pub new_size: Option<u64>,
}

/// Resolve `path`'s byte sources with a one-off whole-repo diff — the fallback
/// when no cached snapshot has them.
pub fn fresh_sources(
    repo: &Repository,
    target: &Target,
    path: &str,
) -> Result<FileSources, GitError> {
    let ep = resolve_endpoints(repo, target)?;
    let diff = build_diff(repo, &ep)?;
    let delta = delta_for_path(&diff, path).ok_or_else(|| format!("file not in diff: {path}"))?;
    delta_sources(repo, &ep, &delta)
}

/// Build the whole diff ONCE and return the file-list summary, every file's
/// extracted content, and every file's byte sources in a single pass. This is the
/// cached path (see `git::cache`): it replaces N separate `get_file_diff` /
/// `get_binary_file_diff` calls — each of which re-ran the full repo diff + rename
/// detection — with one computation the cache serves per file.
/// Content is bounded (see the MAX_CACHED_* consts); over-cap and `.deltaignore`d
/// files are omitted and extracted on demand from their header + sources. (#perf)
pub fn compute_diff_full(repo: &Repository, target: &Target) -> Result<FullDiff, GitError> {
    let ep = resolve_endpoints(repo, target)?;
    let diff = build_diff(repo, &ep)?;
    let ignore = DeltaIgnore::for_repo(repo);
    let normalize = normalizes_crlf(repo);

    let mut files = Vec::new();
    let mut contents: HashMap<String, FileDiff> = HashMap::new();
    let mut all_sources: HashMap<String, FileSources> = HashMap::new();
    let mut headers: HashMap<String, FileHeader> = HashMap::new();
    let mut held_bytes: usize = 0;
    for (idx, delta) in diff.deltas().enumerate() {
        let sources = delta_sources(repo, &ep, &delta).ok();
        let bytes = sources
            .as_ref()
            .map_or_else(|| recorded_bytes(&delta), |s| source_bytes(repo, s));
        let entry = summary_entry(&diff, idx, &delta, bytes, &ignore);
        let path = entry.path.clone();
        let ignored = entry.ignored;
        files.push(entry);
        let Some(sources) = sources else {
            continue;
        };
        let header = FileHeader::of(&delta);

        // The post-read length check stays: CRLF normalization and lossy UTF-8 can
        // make the retained text differ from the on-disk size.
        if !ignored && bytes <= MAX_CACHED_FILE_BYTES && held_bytes < MAX_CACHED_SNAPSHOT_BYTES {
            let old_bytes = sources.read_git(repo, BlobSide::Old);
            let new_raw = sources.read_git(repo, BlobSide::New);
            let new_bytes = match new_raw {
                Some(b) if normalize => Some(crate::vcs::strip_cr(b)),
                other => other,
            };
            let fd = crate::vcs::file_diff_from_bytes(&header, old_bytes, new_bytes);
            let n = fd.old_content.as_deref().map_or(0, str::len)
                + fd.new_content.as_deref().map_or(0, str::len);
            if n as u64 <= MAX_CACHED_FILE_BYTES {
                held_bytes += n;
                contents.insert(path.clone(), fd);
            }
        }
        all_sources.insert(path.clone(), sources);
        headers.insert(path, header);
    }

    Ok(FullDiff {
        summary: DiffSummary {
            files,
            base_label: ep.base_label,
            head_label: ep.head_label,
        },
        files: contents,
        sources: all_sources,
        headers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;

    fn target(repo_path: &str, mode: DiffMode) -> Target {
        Target {
            repo_path: repo_path.into(),
            worktree: None,
            mode,
            base: None,
            commit: None,
        }
    }

    /// Test shim: open the repo the way `vcs::Repo::open` would, then diff one file.
    fn file_diff_at(t: &Target, path: &str) -> Result<FileDiff, GitError> {
        let repo = crate::git::open_repo(&t.repo_path)?;
        get_file_diff(&repo, t, path)
    }

    #[test]
    fn file_diff_returns_old_and_new_content() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let fd = file_diff_at(
            &Target {
                repo_path: dir.path().to_str().unwrap().into(),
                worktree: None,
                mode: DiffMode::Uncommitted,
                base: None,
                commit: None,
            },
            "file.txt",
        )
        .unwrap();
        assert_eq!(fd.old_content.as_deref(), Some("line1\nline2\n"));
        assert_eq!(fd.new_content.as_deref(), Some("line1\nCHANGED\nline2\n"));
    }

    #[test]
    fn crlf_working_copy_is_normalized_when_git_stores_lf() {
        let (dir, repo) = repo_with_commit();
        repo.config()
            .unwrap()
            .set_str("core.autocrlf", "true")
            .unwrap();
        write(dir.path(), "file.txt", "line1\r\nCHANGED\r\n");

        let fd = file_diff_at(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "file.txt",
        )
        .unwrap();

        assert_eq!(fd.old_content.as_deref(), Some("line1\nline2\n"));
        assert_eq!(fd.new_content.as_deref(), Some("line1\nCHANGED\n"));
    }

    #[test]
    fn crlf_working_copy_is_kept_when_git_stores_it_verbatim() {
        let (dir, repo) = repo_with_commit();
        repo.config()
            .unwrap()
            .set_str("core.autocrlf", "false")
            .unwrap();
        write(dir.path(), "file.txt", "line1\r\nCHANGED\r\n");

        let fd = file_diff_at(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "file.txt",
        )
        .unwrap();

        assert_eq!(fd.new_content.as_deref(), Some("line1\r\nCHANGED\r\n"));
    }

    #[test]
    fn compute_diff_full_returns_summary_and_per_file_content_in_one_pass() {
        let (dir, _repo) = repo_with_commit(); // file.txt = "line1\nline2\n"
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        write(dir.path(), "new.ts", "export const x = 1;\n");
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let repo = crate::git::open_repo(&t.repo_path).unwrap();
        let FullDiff { summary, files, .. } = compute_diff_full(&repo, &t).unwrap();

        // Summary matches compute_diff: both changed files present with line stats.
        assert_eq!(summary.files.len(), 2);
        let modified = summary.files.iter().find(|f| f.path == "file.txt").unwrap();
        assert_eq!(modified.additions, 1);
        assert_eq!(modified.deletions, 0);

        // The per-file map carries the SAME content get_file_diff would return —
        // extracted once, so callers never re-diff the repo per file.
        let fd = files.get("file.txt").expect("file.txt in map");
        assert_eq!(fd.old_content.as_deref(), Some("line1\nline2\n"));
        assert_eq!(fd.new_content.as_deref(), Some("line1\nCHANGED\nline2\n"));
        let added = files.get("new.ts").expect("new.ts in map");
        assert_eq!(added.old_content.as_deref(), None); // added → no old side
        assert_eq!(added.new_content.as_deref(), Some("export const x = 1;\n"));
    }

    #[test]
    fn compute_diff_full_reports_larger_side_size_in_bytes() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        write(dir.path(), "new.ts", "export const x = 1;\n");
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let repo = crate::git::open_repo(&t.repo_path).unwrap();
        let FullDiff { summary, .. } = compute_diff_full(&repo, &t).unwrap();

        let bytes_of = |path: &str| summary.files.iter().find(|f| f.path == path).unwrap().bytes;
        assert_eq!(bytes_of("file.txt"), "line1\nCHANGED\nline2\n".len() as u64);
        assert_eq!(bytes_of("new.ts"), "export const x = 1;\n".len() as u64);
    }

    #[test]
    fn binary_file_is_flagged_and_content_omitted() {
        let (dir, _repo) = repo_with_commit();
        // an untracked "png" with NUL bytes
        std::fs::write(
            dir.path().join("logo.png"),
            [0x89u8, b'P', b'N', b'G', 0x00, 0x01, 0x02, 0x00],
        )
        .unwrap();
        let fd = file_diff_at(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "logo.png",
        )
        .unwrap();
        assert!(fd.binary, "png with NUL bytes should be flagged binary");
        assert!(fd.new_content.is_none(), "binary content must be omitted");
    }

    fn get_binary_file_diff(t: &Target, path: &str) -> Result<BinaryFileDiff, GitError> {
        crate::vcs::Repo::with_fresh_sources(t, path, |repo, s| repo.binary_sizes(s))
            .and_then(|sizes| sizes)
    }

    fn read_side(t: &Target, path: &str, side: BlobSide) -> Option<Vec<u8>> {
        crate::vcs::Repo::with_fresh_sources(t, path, |repo, s| repo.read_source(s, side))
            .and_then(|bytes| bytes)
            .unwrap()
    }

    #[test]
    fn binary_file_diff_reports_an_added_files_new_side_only() {
        let (dir, _repo) = repo_with_commit();
        let png = [0x89u8, b'P', b'N', b'G', 0x00, 0x01, 0x02, 0x00];
        std::fs::write(dir.path().join("logo.png"), png).unwrap();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let bd = get_binary_file_diff(&t, "logo.png").unwrap();
        assert_eq!(bd.old_size, None, "added file: no old side");
        assert_eq!(bd.new_size, Some(png.len() as u64));
        assert_eq!(
            read_side(&t, "logo.png", BlobSide::New).as_deref(),
            Some(&png[..])
        );
        assert_eq!(read_side(&t, "logo.png", BlobSide::Old), None);
    }

    #[test]
    fn binary_file_diff_carries_both_sides_of_a_modified_image() {
        let (dir, repo) = repo_with_commit();
        let old_png = [0x89u8, b'O', b'L', b'D', 0x00, 0x01];
        std::fs::write(dir.path().join("logo.png"), old_png).unwrap();
        commit_all(&repo, "add binary logo");
        let new_png = [0x89u8, b'N', b'E', b'W', 0x00, 0x02, 0x03];
        std::fs::write(dir.path().join("logo.png"), new_png).unwrap();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let bd = get_binary_file_diff(&t, "logo.png").unwrap();

        assert_eq!(
            bd.old_size,
            Some(old_png.len() as u64),
            "old side read from HEAD's blob"
        );
        assert_eq!(bd.new_size, Some(new_png.len() as u64));
        assert_eq!(
            read_side(&t, "logo.png", BlobSide::Old).as_deref(),
            Some(&old_png[..])
        );
        assert_eq!(
            read_side(&t, "logo.png", BlobSide::New).as_deref(),
            Some(&new_png[..])
        );
    }

    #[test]
    fn binary_file_diff_reports_a_deleted_files_old_side_only() {
        let (dir, repo) = repo_with_commit();
        let png = [0x89u8, b'B', b'Y', b'E', 0x00];
        std::fs::write(dir.path().join("gone.png"), png).unwrap();
        commit_all(&repo, "add gone.png");
        std::fs::remove_file(dir.path().join("gone.png")).unwrap();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let bd = get_binary_file_diff(&t, "gone.png").unwrap();

        assert_eq!(bd.old_size, Some(png.len() as u64));
        assert_eq!(bd.new_size, None, "deleted: no new side");
        assert_eq!(
            read_side(&t, "gone.png", BlobSide::Old).as_deref(),
            Some(&png[..])
        );
        assert_eq!(read_side(&t, "gone.png", BlobSide::New), None);
    }

    #[test]
    fn binary_sides_read_from_trees_in_commit_mode() {
        let (dir, repo) = repo_with_commit();
        let png = [0x89u8, b'C', b'M', b'T', 0x00];
        std::fs::write(dir.path().join("logo.png"), png).unwrap();
        commit_all(&repo, "add logo");
        let t = target(dir.path().to_str().unwrap(), DiffMode::LastCommit);

        assert_eq!(
            get_binary_file_diff(&t, "logo.png").unwrap().new_size,
            Some(png.len() as u64)
        );
        assert_eq!(
            read_side(&t, "logo.png", BlobSide::New).as_deref(),
            Some(&png[..])
        );
    }

    #[test]
    fn uncommitted_lists_modified_file() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let summary =
            compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "file.txt");
        assert_eq!(summary.files[0].status, FileStatus::Modified);
    }

    #[test]
    fn uncommitted_lists_untracked_new_file() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "new.txt", "hello\n");
        let summary =
            compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        let new_file = summary.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(new_file.status, FileStatus::Added);
        assert_eq!((new_file.additions, new_file.deletions), (1, 0));
    }

    #[test]
    fn untracked_file_carries_its_line_stats() {
        let (dir, _repo) = repo_with_commit();
        write(
            dir.path(),
            "fresh.ts",
            "const a = 1\nconst b = 2\nconst c = 3\n",
        );

        let summary =
            compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted)).unwrap();

        let fresh = summary.files.iter().find(|f| f.path == "fresh.ts").unwrap();
        assert_eq!((fresh.additions, fresh.deletions), (3, 0));
    }

    #[test]
    fn clean_tree_all_changes_is_empty() {
        let (dir, _repo) = repo_with_commit();
        let summary =
            compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::AllChanges)).unwrap();
        assert_eq!(summary.files.len(), 0);
    }

    // Repro for the "uncommitted shows the whole file as new" report. The file is
    // new relative to main but committed on the feature branch, then has a couple
    // uncommitted edits. Uncommitted (HEAD→workdir) must show Modified, not Added.
    #[test]
    fn uncommitted_branch_new_file_shows_modified_not_added() {
        let (dir, repo) = repo_with_commit(); // main: file.txt
                                              // branch off and commit a brand-new file
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        write(dir.path(), "feature.txt", "a\nb\nc\n");
        commit_all(&repo, "add feature.txt on feature");
        // a couple uncommitted edits
        write(dir.path(), "feature.txt", "a\nCHANGED\nc\n");

        let summary =
            compute_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        let f = summary
            .files
            .iter()
            .find(|f| f.path == "feature.txt")
            .unwrap();
        assert_eq!(
            f.status,
            FileStatus::Modified,
            "expected Modified, got {:?}",
            f.status
        );

        let fd = file_diff_at(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "feature.txt",
        )
        .unwrap();
        assert_eq!(
            fd.old_content.as_deref(),
            Some("a\nb\nc\n"),
            "old content must be HEAD's"
        );
    }

    #[test]
    fn uncommitted_in_linked_worktree_shows_modified_not_added() {
        use git2::WorktreeAddOptions;
        let (_dir, repo) = repo_with_commit(); // main: file.txt
                                               // create a linked worktree on a new branch
        let wt_parent = tempfile::TempDir::new().unwrap();
        let wt_path = wt_parent.path().join("wt");
        let wt = repo
            .worktree("feat", &wt_path, Some(&WorktreeAddOptions::new()))
            .unwrap();
        let wt_repo = Repository::open_from_worktree(&wt).unwrap();
        // commit a brand-new file on the worktree's branch
        write(&wt_path, "feature.txt", "a\nb\nc\n");
        commit_all(&wt_repo, "add feature.txt in worktree");
        // a couple uncommitted edits in the worktree
        write(&wt_path, "feature.txt", "a\nCHANGED\nc\n");

        let summary =
            compute_diff(&target(wt_path.to_str().unwrap(), DiffMode::Uncommitted)).unwrap();
        let f = summary
            .files
            .iter()
            .find(|f| f.path == "feature.txt")
            .unwrap();
        assert_eq!(
            f.status,
            FileStatus::Modified,
            "expected Modified, got {:?}",
            f.status
        );
    }
}
