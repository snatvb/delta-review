use crate::git::model::Target;
use crate::git::{open_repo, resolve_endpoints, Endpoints, GitError, RightSide};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use git2::{Diff, DiffDelta, DiffFindOptions, DiffOptions, Oid, Repository};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Eager-extraction memory bounds for `compute_diff_full` (the cached path). A file
/// whose recorded size exceeds the per-file cap is left out of the map (served by a
/// one-off `get_file_diff` on demand); once the retained snapshot passes the total
/// cap we stop extracting so a huge review can't balloon backend memory. Well above
/// any hand-reviewable file, so normal diffs are fully cached. (#perf)
pub(crate) const MAX_CACHED_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_CACHED_SNAPSHOT_BYTES: usize = 128 * 1024 * 1024;

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
    opts.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);

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
fn summary_entry(diff: &Diff, idx: usize, delta: &DiffDelta) -> FileEntry {
    let new_path = delta.new_file().path().map(|p| p.to_string_lossy().into_owned());
    let old_path = delta.old_file().path().map(|p| p.to_string_lossy().into_owned());
    let path = new_path.clone().or_else(|| old_path.clone()).unwrap_or_default();

    let (additions, deletions) = match git2::Patch::from_diff(diff, idx) {
        Ok(Some(p)) => {
            let (_ctx, add, del) = p.line_stats().unwrap_or((0, 0, 0));
            (add, del)
        }
        _ => (0, 0),
    };

    FileEntry {
        path,
        old_path: old_path.filter(|o| Some(o) != new_path.as_ref()),
        status: map_status(delta.status()),
        additions,
        deletions,
        binary: delta.new_file().is_binary() || delta.old_file().is_binary(),
    }
}

pub fn compute_diff(target: &Target) -> Result<DiffSummary, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;

    let files = diff
        .deltas()
        .enumerate()
        .map(|(idx, delta)| summary_entry(&diff, idx, &delta))
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
fn normalizes_crlf(repo: &Repository) -> bool {
    repo.config()
        .and_then(|c| c.get_string("core.autocrlf"))
        .map(|v| v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("input"))
        .unwrap_or(false)
}

fn strip_cr(bytes: Vec<u8>) -> Vec<u8> {
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
#[derive(Debug, Clone)]
pub struct FileSources {
    old: Option<Oid>,
    new: NewSide,
}

#[derive(Debug, Clone)]
enum NewSide {
    WorkTree(PathBuf),
    Blob(Oid),
    Absent,
}

fn delta_sources(repo: &Repository, ep: &Endpoints, delta: &DiffDelta) -> Result<FileSources, GitError> {
    let old = match (ep.from_tree, delta.old_file().path()) {
        (Some(tree_oid), Some(op)) => {
            let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
            tree.get_path(op).ok().map(|entry| entry.id())
        }
        _ => None,
    };
    let new_blob = delta.new_file().id();
    let new = match (&ep.right, delta.new_file().path()) {
        (RightSide::WorkTree, Some(np)) => {
            let wd = repo.workdir().ok_or("no working directory")?;
            NewSide::WorkTree(wd.join(np))
        }
        (RightSide::Tree(_), Some(_)) if !new_blob.is_zero() => NewSide::Blob(new_blob),
        _ => NewSide::Absent,
    };
    Ok(FileSources { old, new })
}

/// Raw bytes, untouched: CRLF normalization is the caller's job, since stripping CR
/// pairs from an image corrupts it.
fn read_sources(repo: &Repository, sources: &FileSources) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let blob = |oid: Oid| repo.find_blob(oid).ok().map(|b| b.content().to_vec());
    let old = sources.old.and_then(blob);
    let new = match &sources.new {
        NewSide::WorkTree(path) => fs::read(path).ok(),
        NewSide::Blob(oid) => blob(*oid),
        NewSide::Absent => None,
    };
    (old, new)
}

/// Extract one file's content + metadata from an already-built delta. Shared by
/// `get_file_diff` (locate one file) and `compute_diff_full` (every file in a single
/// pass) so callers never re-run the whole-repo diff once per file.
fn extract_file_diff(repo: &Repository, delta: &DiffDelta, sources: &FileSources) -> Result<FileDiff, GitError> {
    let status = map_status(delta.status());

    let old_path = delta
        .old_file()
        .path()
        .map(|p| p.to_string_lossy().to_string());
    let new_path = delta
        .new_file()
        .path()
        .map(|p| p.to_string_lossy().to_string());

    let (old_bytes, new_bytes_raw) = read_sources(repo, sources);
    // The working copy is CRLF-normalized for text comparison when git filters to
    // LF (`core.autocrlf=true|input`, the Windows default) — otherwise a raw CRLF
    // working file against an LF blob renders every line as changed. Raw bytes are
    // left alone for the binary path (see `read_sources`).
    let new_bytes = match new_bytes_raw {
        Some(b) if normalizes_crlf(repo) => Some(strip_cr(b)),
        other => other,
    };

    let binary = delta.new_file().is_binary()
        || delta.old_file().is_binary()
        || old_bytes.as_deref().map(looks_binary).unwrap_or(false)
        || new_bytes.as_deref().map(looks_binary).unwrap_or(false);

    // Drop content for binary files — the UI shows an "Unsupported file" placeholder.
    let old_content = if binary { None } else { old_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()) };
    let new_content = if binary { None } else { new_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()) };

    Ok(FileDiff {
        old_file_name: old_path,
        new_file_name: new_path,
        old_content,
        new_content,
        status,
        binary,
    })
}

pub fn get_file_diff(target: &Target, path: &str) -> Result<FileDiff, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;

    let delta = delta_for_path(&diff, path).ok_or_else(|| format!("file not in diff: {path}"))?;
    let sources = delta_sources(&repo, &ep, &delta)?;

    extract_file_diff(&repo, &delta, &sources)
}

/// One binary file's two sides for the UI's binary/image card: exact byte sizes
/// (the delta's recorded size can read 0 for working-tree files, so lengths come
/// from the bytes we actually read) and, when `include_data` is asked and the side
/// is small enough, base64 of the raw bytes so the webview can render an `<img>`
/// from a data URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryFileDiff {
    pub old_size: Option<u64>,
    pub new_size: Option<u64>,
    pub old_data: Option<String>,
    pub new_data: Option<String>,
}

/// Sides above this are not embedded: a multi-MB base64 string across IPC and into
/// a data URL is wasted work the webview renders poorly anyway. The size is still
/// reported, so the UI can say "too large to preview". Far above any screenshot a
/// review needs to see inline.
pub(crate) const MAX_IMAGE_PREVIEW_BYTES: usize = 8 * 1024 * 1024;

pub fn get_binary_file_diff(target: &Target, path: &str, include_data: bool) -> Result<BinaryFileDiff, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;

    let delta = delta_for_path(&diff, path).ok_or_else(|| format!("file not in diff: {path}"))?;
    let sources = delta_sources(&repo, &ep, &delta)?;

    Ok(binary_file_diff(&repo, &sources, include_data))
}

/// `get_binary_file_diff` for sources already resolved by `compute_diff_full` — just
/// the blob/file reads, no whole-repo diff.
pub fn binary_file_diff_from_sources(
    repo_path: &str,
    sources: &FileSources,
    include_data: bool,
) -> Result<BinaryFileDiff, GitError> {
    let repo = open_repo(repo_path)?;
    Ok(binary_file_diff(&repo, sources, include_data))
}

fn binary_file_diff(repo: &Repository, sources: &FileSources, include_data: bool) -> BinaryFileDiff {
    let (old_bytes, new_bytes) = read_sources(repo, sources);
    let embed = |b: &Option<Vec<u8>>| match b {
        Some(bytes) if include_data && bytes.len() <= MAX_IMAGE_PREVIEW_BYTES => {
            Some(BASE64.encode(bytes))
        }
        _ => None,
    };
    BinaryFileDiff {
        old_size: old_bytes.as_ref().map(|b| b.len() as u64),
        new_size: new_bytes.as_ref().map(|b| b.len() as u64),
        old_data: embed(&old_bytes),
        new_data: embed(&new_bytes),
    }
}

pub struct FullDiff {
    pub summary: DiffSummary,
    pub files: HashMap<String, FileDiff>,
    pub sources: HashMap<String, FileSources>,
}

/// Build the whole diff ONCE and return the file-list summary, every file's
/// extracted content, and every file's byte sources in a single pass. This is the
/// cached path (see `git::cache`): it replaces N separate `get_file_diff` /
/// `get_binary_file_diff` calls — each of which re-ran the full repo diff + rename
/// detection — with one computation the cache serves per file.
/// Content is bounded (see the MAX_CACHED_* consts); over-cap files are omitted and
/// fall back to a one-off `get_file_diff`. (#perf)
pub fn compute_diff_full(target: &Target) -> Result<FullDiff, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let ep = resolve_endpoints(&repo, target)?;
    let diff = build_diff(&repo, &ep)?;

    let mut files = Vec::new();
    let mut contents: HashMap<String, FileDiff> = HashMap::new();
    let mut all_sources: HashMap<String, FileSources> = HashMap::new();
    let mut held_bytes: usize = 0;
    for (idx, delta) in diff.deltas().enumerate() {
        let entry = summary_entry(&diff, idx, &delta);
        let path = entry.path.clone();
        files.push(entry);
        let Ok(sources) = delta_sources(&repo, &ep, &delta) else {
            continue;
        };

        // Eagerly cache content so the per-file fetch is a map hit — but keep held
        // memory bounded: skip individually huge files, and stop once the snapshot
        // passes the total cap. Skipped files fall back to a one-off get_file_diff.
        // The pre-check uses the delta's recorded size (accurate for tree blobs); a
        // working-tree file can report size 0, so a post-read length check backs it
        // up before we RETAIN the content. (#perf)
        let size = delta.new_file().size().max(delta.old_file().size());
        if size <= MAX_CACHED_FILE_BYTES && held_bytes < MAX_CACHED_SNAPSHOT_BYTES {
            if let Ok(fd) = extract_file_diff(&repo, &delta, &sources) {
                let n = fd.old_content.as_deref().map_or(0, str::len)
                    + fd.new_content.as_deref().map_or(0, str::len);
                if n as u64 <= MAX_CACHED_FILE_BYTES {
                    held_bytes += n;
                    contents.insert(path.clone(), fd);
                }
            }
        }
        all_sources.insert(path, sources);
    }

    Ok(FullDiff {
        summary: DiffSummary { files, base_label: ep.base_label, head_label: ep.head_label },
        files: contents,
        sources: all_sources,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;

    fn target(repo_path: &str, mode: DiffMode) -> Target {
        Target { repo_path: repo_path.into(), worktree: None, mode, base: None, commit: None }
    }

    #[test]
    fn file_diff_returns_old_and_new_content() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let fd = get_file_diff(
            &Target { repo_path: dir.path().to_str().unwrap().into(), worktree: None, mode: DiffMode::Uncommitted, base: None, commit: None },
            "file.txt",
        ).unwrap();
        assert_eq!(fd.old_content.as_deref(), Some("line1\nline2\n"));
        assert_eq!(fd.new_content.as_deref(), Some("line1\nCHANGED\nline2\n"));
    }

    #[test]
    fn crlf_working_copy_is_normalized_when_git_stores_lf() {
        let (dir, repo) = repo_with_commit();
        repo.config().unwrap().set_str("core.autocrlf", "true").unwrap();
        write(dir.path(), "file.txt", "line1\r\nCHANGED\r\n");

        let fd = get_file_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted), "file.txt").unwrap();

        assert_eq!(fd.old_content.as_deref(), Some("line1\nline2\n"));
        assert_eq!(fd.new_content.as_deref(), Some("line1\nCHANGED\n"));
    }

    #[test]
    fn crlf_working_copy_is_kept_when_git_stores_it_verbatim() {
        let (dir, repo) = repo_with_commit();
        repo.config().unwrap().set_str("core.autocrlf", "false").unwrap();
        write(dir.path(), "file.txt", "line1\r\nCHANGED\r\n");

        let fd = get_file_diff(&target(dir.path().to_str().unwrap(), DiffMode::Uncommitted), "file.txt").unwrap();

        assert_eq!(fd.new_content.as_deref(), Some("line1\r\nCHANGED\r\n"));
    }

    #[test]
    fn compute_diff_full_returns_summary_and_per_file_content_in_one_pass() {
        let (dir, _repo) = repo_with_commit(); // file.txt = "line1\nline2\n"
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        write(dir.path(), "new.ts", "export const x = 1;\n");
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let FullDiff { summary, files, .. } = compute_diff_full(&t).unwrap();

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
    fn binary_file_is_flagged_and_content_omitted() {
        let (dir, _repo) = repo_with_commit();
        // an untracked "png" with NUL bytes
        std::fs::write(dir.path().join("logo.png"), [0x89u8, b'P', b'N', b'G', 0x00, 0x01, 0x02, 0x00]).unwrap();
        let fd = get_file_diff(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "logo.png",
        )
        .unwrap();
        assert!(fd.binary, "png with NUL bytes should be flagged binary");
        assert!(fd.new_content.is_none(), "binary content must be omitted");
    }

    #[test]
    fn binary_file_diff_reports_sizes_and_base64_when_asked() {
        let (dir, _repo) = repo_with_commit();
        let png = [0x89u8, b'P', b'N', b'G', 0x00, 0x01, 0x02, 0x00];
        std::fs::write(dir.path().join("logo.png"), png).unwrap();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let bd = get_binary_file_diff(&t, "logo.png", true).unwrap();
        assert_eq!(bd.old_size, None, "added file: no old side");
        assert_eq!(bd.new_size, Some(png.len() as u64));
        assert_eq!(bd.new_data.as_deref(), Some(BASE64.encode(png).as_str()), "data follows the include flag");

        let bd = get_binary_file_diff(&t, "logo.png", false).unwrap();
        assert_eq!(bd.new_size, Some(png.len() as u64), "size is reported regardless");
        assert_eq!(bd.new_data, None, "data only when asked");
    }

    #[test]
    fn binary_file_diff_carries_both_sides_of_a_modified_image() {
        let (dir, repo) = repo_with_commit();
        let old_png = [0x89u8, b'O', b'L', b'D', 0x00, 0x01];
        std::fs::write(dir.path().join("logo.png"), old_png).unwrap();
        commit_all(&repo, "add binary logo");
        let new_png = [0x89u8, b'N', b'E', b'W', 0x00, 0x02, 0x03];
        std::fs::write(dir.path().join("logo.png"), new_png).unwrap();

        let bd = get_binary_file_diff(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "logo.png",
            true,
        )
        .unwrap();

        assert_eq!(bd.old_size, Some(old_png.len() as u64), "old side read from HEAD's blob");
        assert_eq!(bd.new_size, Some(new_png.len() as u64));
        assert_eq!(bd.old_data.as_deref(), Some(BASE64.encode(old_png).as_str()));
        assert_eq!(bd.new_data.as_deref(), Some(BASE64.encode(new_png).as_str()));
    }

    #[test]
    fn binary_file_diff_keeps_size_but_drops_data_over_the_preview_cap() {
        let (dir, _repo) = repo_with_commit();
        let big: Vec<u8> = std::iter::once(0u8)
            .chain(std::iter::repeat_n(b'x', MAX_IMAGE_PREVIEW_BYTES))
            .collect();
        std::fs::write(dir.path().join("big.bin"), &big).unwrap();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let bd = get_binary_file_diff(&t, "big.bin", true).unwrap();

        assert_eq!(bd.new_size, Some(big.len() as u64), "size is exact even over the cap");
        assert_eq!(bd.new_data, None, "oversized data is never embedded");
    }

    #[test]
    fn binary_file_diff_reports_a_deleted_files_old_side_only() {
        let (dir, repo) = repo_with_commit();
        let png = [0x89u8, b'B', b'Y', b'E', 0x00];
        std::fs::write(dir.path().join("gone.png"), png).unwrap();
        commit_all(&repo, "add gone.png");
        std::fs::remove_file(dir.path().join("gone.png")).unwrap();

        let bd = get_binary_file_diff(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "gone.png",
            true,
        )
        .unwrap();

        assert_eq!(bd.old_size, Some(png.len() as u64));
        assert_eq!(bd.new_size, None, "deleted: no new side");
        assert_eq!(bd.old_data.as_deref(), Some(BASE64.encode(png).as_str()));
        assert_eq!(bd.new_data, None);
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
        write(dir.path(), "fresh.ts", "const a = 1\nconst b = 2\nconst c = 3\n");

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
        let f = summary.files.iter().find(|f| f.path == "feature.txt").unwrap();
        assert_eq!(f.status, FileStatus::Modified, "expected Modified, got {:?}", f.status);

        let fd = get_file_diff(
            &target(dir.path().to_str().unwrap(), DiffMode::Uncommitted),
            "feature.txt",
        )
        .unwrap();
        assert_eq!(fd.old_content.as_deref(), Some("a\nb\nc\n"), "old content must be HEAD's");
    }

    #[test]
    fn uncommitted_in_linked_worktree_shows_modified_not_added() {
        use git2::WorktreeAddOptions;
        let (dir, repo) = repo_with_commit(); // main: file.txt
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
        let f = summary.files.iter().find(|f| f.path == "feature.txt").unwrap();
        assert_eq!(f.status, FileStatus::Modified, "expected Modified, got {:?}", f.status);
    }
}
