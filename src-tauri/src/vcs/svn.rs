//! The SVN backend. v1 scope is the working-copy diff only ("uncommitted"):
//! `svn status --xml` for the change list (offline — it reads the local
//! pristine store), `svn cat -r BASE` for old sides, the filesystem for new
//! sides. Everything history-shaped (log, per-revision diffs, branch
//! comparison) is server-bound in SVN and deliberately out of scope; see
//! docs/svn.md.
//!
//! Never read `.svn/wc.db` directly — its schema is internal and svn locks
//! it during operations. All knowledge comes from the CLI, whose `--xml`
//! output is the stable machine interface.
use crate::git::deltaignore::DeltaIgnore;
use crate::git::diff::{DiffSummary, FileDiff, FileStatus, MAX_CACHED_FILE_BYTES, MAX_CACHED_SNAPSHOT_BYTES};
use crate::git::model::Target;
use crate::registry::model::{repo_name_from_path, RepoEntry, WorktreeEntry};
use crate::vcs::{file_entry, FileHeader, FileSources, FullDiff, NewSide, OldSide, PinnedBase, VcsError, VcsKind};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::{Instant, SystemTime};

pub struct SvnRepo {
    root: PathBuf,
}

impl SvnRepo {
    pub fn new(root: PathBuf) -> Self {
        SvnRepo { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The review-identity label: the last URL segment ("trunk", a branch
    /// name). Falls back to "svn" when the CLI is unavailable so a review
    /// still opens — the diff command surfaces the install message instead.
    /// (The two labels produce different review ids; installing the CLI
    /// mid-review starts a fresh review. Documented in docs/svn.md.)
    pub fn worktree_label(&self) -> String {
        info(&self.root).ok().map(|i| url_tail(&i.url)).unwrap_or_else(|| "svn".into())
    }

    /// One checked-out working copy — SVN has no linked worktrees.
    pub fn list_worktrees(&self) -> Vec<WorktreeEntry> {
        vec![WorktreeEntry {
            path: self.root.display().to_string(),
            branch: self.worktree_label(),
            is_main: true,
            // Last-changed times come from `svn log`, which always contacts
            // the server — not paid for a picker listing.
            last_commit_at: None,
            dirty: false,
        }]
    }

    pub fn repo_entry(&self) -> RepoEntry {
        let root = self.root.display().to_string();
        let mut h = Sha256::new();
        h.update(root.as_bytes());
        let id: String = h.finalize()[..8].iter().map(|b| format!("{:02x}", b)).collect();
        RepoEntry {
            id,
            root,
            name: repo_name_from_path(&self.root.display().to_string()),
            default_branch: None,
            worktrees: self.list_worktrees(),
            vcs: VcsKind::Svn,
            vcs_override: None,
        }
    }

    // --- the uncommitted pipeline ---

    pub fn compute_diff_full(&self, _target: &Target) -> Result<FullDiff, VcsError> {
        let t0 = Instant::now();
        let plans = self.uncommitted_plans()?;
        let ignore = DeltaIgnore::for_worktree(&self.root, None);

        // Per-file work is independent and `svn cat` is a process spawn
        // (~tens of ms each), so slots are extracted in bounded parallel
        // batches — serial extraction would cost seconds on a 100-file
        // changeset. Same fan-out shape as the git worktree scan.
        let mut files = Vec::with_capacity(plans.len());
        let mut contents: HashMap<String, FileDiff> = HashMap::new();
        let mut all_sources: HashMap<String, FileSources> = HashMap::new();
        let mut headers: HashMap<String, FileHeader> = HashMap::new();
        let mut held_bytes: usize = 0;
        for chunk in plans.chunks(16) {
            let slots: Vec<FileSlot> = std::thread::scope(|s| {
                let handles: Vec<_> =
                    chunk.iter().map(|p| s.spawn(|| self.extract_slot(p, &ignore, true))).collect();
                handles
                    .into_iter()
                    .map(|h| h.join().expect("svn extract thread panicked"))
                    .collect::<Result<Vec<_>, _>>()
            })?;
            for slot in slots {
                let path = slot.entry.path.clone();
                // Same retention contract as the git path: ignored and
                // over-cap files keep their header + sources (extracted on
                // demand later) but don't hold content in the snapshot.
                // Pinned binary BASE bytes count toward the budget like text.
                if !slot.entry.ignored
                    && slot.extracted_bytes as u64 <= MAX_CACHED_FILE_BYTES
                    && held_bytes < MAX_CACHED_SNAPSHOT_BYTES
                {
                    held_bytes += slot.extracted_bytes;
                    contents.insert(path.clone(), slot.file_diff.clone());
                }
                files.push(slot.entry);
                all_sources.insert(path.clone(), slot.sources);
                headers.insert(path, slot.header);
            }
        }

        crate::perf::log("svn diff full", &self.root.display().to_string(), t0);
        Ok(FullDiff {
            summary: DiffSummary {
                files,
                base_label: "BASE".into(),
                head_label: "working copy".into(),
            },
            files: contents,
            sources: all_sources,
            headers,
        })
    }

    pub fn get_file_diff(&self, _target: &Target, path: &str) -> Result<FileDiff, VcsError> {
        let plan = self.plan_for(path)?;
        let ignore = DeltaIgnore::for_worktree(&self.root, None);
        // One-off resolution: no snapshot to bound, so caps don't apply
        // (mirrors git's over-cap fallback) and BASE reads stay live.
        Ok(self.extract_slot(&plan, &ignore, false)?.file_diff)
    }

    pub fn fresh_sources(&self, _target: &Target, path: &str) -> Result<FileSources, VcsError> {
        let plan = self.plan_for(path)?;
        Ok(self.extract_slot(&plan, &DeltaIgnore::for_worktree(&self.root, None), false)?.sources)
    }

    fn plan_for(&self, path: &str) -> Result<FilePlan, VcsError> {
        self.uncommitted_plans()?
            .into_iter()
            .find(|p| p.rel == path)
            .ok_or_else(|| format!("file not in diff: {path}"))
    }

    /// The change list: `svn status` mapped onto the review's file statuses.
    /// `svn status` already hides svn:ignore / global-ignores matches (they
    /// only appear with `--no-ignore`), so ignore handling is free. Property-
    /// only changes on directories appear as `item="normal"` and are skipped
    /// (property diffs are out of scope for v1); externals (`X`) likewise.
    ///
    /// A deleted/missing DIRECTORY shows as one row on the directory — svn
    /// never descends into it, and it's already gone from disk so fs checks
    /// can't tell dir from file. `svn info --depth infinity` still lists the
    /// scheduled-deleted nodes until the delete commits, so dir-ness and the
    /// member files come from there (paid only when a deletion exists).
    fn uncommitted_plans(&self) -> Result<Vec<FilePlan>, VcsError> {
        let xml = run_text(&self.root, &["status", "--xml", "--ignore-externals"])?;
        let entries = parse_status_xml(&xml);
        let versioned = if entries.iter().any(|e| e.item == "deleted" || e.item == "missing") {
            let info_xml = run_text(&self.root, &["info", "--xml", "--depth", "infinity"])?;
            parse_info(&info_xml).1
        } else {
            HashMap::new()
        };
        let is_versioned_dir =
            |p: &str| versioned.get(p).map(|k| k == "dir").unwrap_or(false);

        let mut plans = Vec::new();
        for e in entries {
            let abs = self.root.join(&e.path);
            match e.item.as_str() {
                "modified" | "conflicted" if !abs.is_dir() && !is_versioned_dir(&e.path) => {
                    plans.push(FilePlan { rel: e.path, status: FileStatus::Modified, has_base: true })
                }
                // v1 limitation (verified against 1.14.5): a replaced file
                // has no pristine until it's committed — `svn cat -r BASE`
                // fails with E200009 and the pre-replace content is only
                // reachable through the server. Rather than error the whole
                // diff or fake a missing side silently, a replacement
                // reviews as an added file. See docs/svn.md.
                "replaced" if !abs.is_dir() && !is_versioned_dir(&e.path) => {
                    plans.push(FilePlan { rel: e.path, status: FileStatus::Added, has_base: false })
                }
                // Both scheduled deletes (svn rm) and missing files (deleted
                // behind svn's back) review against BASE with no new side.
                "deleted" | "missing" => {
                    if is_versioned_dir(&e.path) {
                        let prefix = format!("{}/", e.path);
                        for file in versioned_files_under(&versioned, &prefix) {
                            plans.push(FilePlan { rel: file, status: FileStatus::Deleted, has_base: true });
                        }
                    } else {
                        plans.push(FilePlan { rel: e.path, status: FileStatus::Deleted, has_base: true })
                    }
                }
                "added" if !abs.is_dir() && !is_versioned_dir(&e.path) => {
                    plans.push(FilePlan { rel: e.path, status: FileStatus::Added, has_base: false })
                }
                "unversioned" => {
                    if abs.is_dir() {
                        // svn lists an unversioned directory as a single entry
                        // without descending; walk it so its files review like
                        // git untracked content. svn:ignore patterns inside
                        // unversioned directories are not re-applied in v1 —
                        // `.deltaignore` still is.
                        for rel in walk_files(&self.root, &abs) {
                            plans.push(FilePlan { rel, status: FileStatus::Added, has_base: false });
                        }
                    } else {
                        plans.push(FilePlan { rel: e.path, status: FileStatus::Added, has_base: false })
                    }
                }
                _ => {}
            }
        }
        plans.sort_by(|a, b| a.rel.cmp(&b.rel));
        plans.dedup_by(|a, b| a.rel == b.rel);
        Ok(plans)
    }

    /// Everything one changed file contributes to a snapshot: summary entry
    /// (with line stats), the extractable diff, byte sources, header.
    ///
    /// ONE BASE read drives size, binary flag, stats and content — no second
    /// `svn cat` per file. In snapshot mode (`for_snapshot`), a working side
    /// already over the cache cap skips the BASE read entirely (the snapshot
    /// wouldn't retain the content, and cat'ing gigabytes for line counts
    /// isn't worth it — v1: over-cap files report no stats) and binary BASE
    /// sides are PINNED into the sources: git's old side is an immutable
    /// blob, but SVN's BASE moves on the next commit/update, and a re-read
    /// under the still-displayed snapshot would serve different bytes than
    /// the window shows.
    fn extract_slot(
        &self,
        plan: &FilePlan,
        ignore: &DeltaIgnore,
        for_snapshot: bool,
    ) -> Result<FileSlot, VcsError> {
        let abs = self.root.join(&plan.rel);
        let new_len = if plan.status == FileStatus::Deleted {
            None
        } else {
            std::fs::metadata(&abs).ok().map(|m| m.len())
        };
        let over_cap = for_snapshot && new_len.map(|n| n > MAX_CACHED_FILE_BYTES).unwrap_or(false);

        let old_bytes: Option<Vec<u8>> = if plan.has_base && !over_cap {
            Some(cat_base(&self.root, &plan.rel)?)
        } else {
            None
        };
        let new_bytes_raw = if over_cap { None } else { std::fs::read(&abs).ok() };
        // svn:eol-style=native keeps the repository form LF while the working
        // copy holds platform EOLs — mirror git's autocrlf handling with a
        // per-file heuristic (BASE pure LF + working CRLF → normalize).
        let normalize = base_is_lf_working_is_crlf(old_bytes.as_deref(), new_bytes_raw.as_deref());
        let new_bytes = match new_bytes_raw {
            Some(b) if normalize => Some(crate::vcs::strip_cr(b)),
            other => other,
        };

        let binary = old_bytes.as_deref().map(crate::git::diff::looks_binary).unwrap_or(false)
            || if over_cap {
                peek_binary(&abs)
            } else {
                new_bytes.as_deref().map(crate::git::diff::looks_binary).unwrap_or(false)
            };
        let ignored = ignore.is_ignored(&plan.rel);
        let (additions, deletions) = if ignored || binary || over_cap {
            (0, 0)
        } else {
            let old_text =
                old_bytes.as_deref().map(|b| String::from_utf8_lossy(b).into_owned());
            let new_text =
                new_bytes.as_deref().map(|b| String::from_utf8_lossy(b).into_owned());
            line_stats_of(old_text.as_deref(), new_text.as_deref())
        };

        let bytes = (old_bytes.as_ref().map(|b| b.len()).unwrap_or(0) as u64)
            .max(new_len.unwrap_or(0));
        let entry = file_entry(plan.rel.clone(), plan.status, additions, deletions, binary, bytes, ignored);

        // Pin binary BASE sides (and mark over-cap ones unavailable) so a
        // served snapshot never re-reads a BASE that may have moved.
        let pinned = if plan.has_base && for_snapshot {
            if over_cap {
                Some(PinnedBase::Unavailable)
            } else if binary && old_bytes.as_ref().map(|b| b.len()).unwrap_or(0) as u64
                <= MAX_CACHED_FILE_BYTES
            {
                Some(PinnedBase::Bytes(Arc::new(
                    old_bytes.clone().expect("binary under cap read its BASE"),
                )))
            } else {
                None
            }
        } else {
            None
        };

        let header = FileHeader::new(
            plan.status,
            if plan.has_base { Some(plan.rel.clone()) } else { None },
            Some(plan.rel.clone()),
            binary,
        );
        let pinned_len = match &pinned {
            Some(PinnedBase::Bytes(b)) => b.len(),
            _ => 0,
        };
        let file_diff = crate::vcs::file_diff_from_bytes(&header, old_bytes, new_bytes);
        let extracted_bytes = file_diff.old_content.as_deref().map_or(0, str::len)
            + file_diff.new_content.as_deref().map_or(0, str::len)
            + pinned_len;
        let sources = FileSources::new(
            if plan.has_base {
                OldSide::SvnBase { root: self.root.clone(), rel: plan.rel.clone(), pinned }
            } else {
                OldSide::Absent
            },
            NewSide::WorkTree(abs),
        );
        Ok(FileSlot { entry, file_diff, sources, header, extracted_bytes })
    }
}

struct FilePlan {
    /// WC-root-relative, forward slashes (as svn reports it).
    rel: String,
    status: FileStatus,
    /// A BASE side exists to diff against (modified/deleted/missing — not
    /// adds or unversioned files).
    has_base: bool,
}

struct FileSlot {
    entry: crate::git::diff::FileEntry,
    file_diff: FileDiff,
    sources: FileSources,
    header: FileHeader,
    extracted_bytes: usize,
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

const MISSING_SVN_MESSAGE: &str = "SVN working copy detected, but the `svn` command line tools \
were not found. Install them (macOS: `brew install subversion`; Windows: the VisualSVN or \
TortoiseSVN command line client tools) and restart the app.";

/// Why the resolution failed, with the evidence — a GUI-launched app sees
/// launchd's minimal PATH, so the message carries what this process actually
/// looked at and turns "works in my terminal" reports into one-glance answers.
fn missing_svn_error() -> VcsError {
    format!(
        "{MISSING_SVN_MESSAGE} (this process' PATH: {}; also probed /opt/homebrew/bin, \
/usr/local/bin and /opt/local/bin)",
        std::env::var("PATH").unwrap_or_else(|_| "<unset>".into())
    )
}

/// Locate `svn`: every PATH entry first, then the conventional
/// package-manager locations — a GUI-launched app inherits launchd's minimal
/// PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which omits all of them.
/// Splits on both `:` and `;` so a Windows PATH parses too.
fn find_svn(path_var: &str) -> Option<PathBuf> {
    path_var
        .split([':', ';'])
        .filter(|s| !s.is_empty())
        .chain(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"])
        .map(|dir| PathBuf::from(dir).join("svn"))
        .find(|bin| bin.exists())
}

static SVN_BINARY: LazyLock<Option<PathBuf>> =
    LazyLock::new(|| find_svn(&std::env::var("PATH").unwrap_or_default()));

fn run_bytes(root: &Path, args: &[&str]) -> Result<Vec<u8>, VcsError> {
    let bin = SVN_BINARY.as_deref().ok_or_else(missing_svn_error)?;
    let output = std::process::Command::new(bin)
        .arg("--non-interactive")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("run svn {}: {e}", args.first().unwrap_or(&"")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("svn {}: {stderr}", args.first().unwrap_or(&"")));
    }
    Ok(output.stdout)
}

fn run_text(root: &Path, args: &[&str]) -> Result<String, VcsError> {
    let bytes = run_bytes(root, args)?;
    String::from_utf8(bytes)
        .map_err(|_| format!("svn {}: output is not UTF-8", args.first().unwrap_or(&"")))
}

/// The BASE-side content of one file, from the local pristine store (no
/// network). `--` ends option parsing and the path is passed absolute, so a
/// leading-dash filename can't be read as a flag; a path containing `@` gets
/// a trailing `@` so svn doesn't read it as `path@PEGREV`.
pub(crate) fn cat_base(root: &Path, rel: &str) -> Result<Vec<u8>, VcsError> {
    let mut target = root.join(rel).display().to_string();
    if target.contains('@') {
        target.push('@');
    }
    run_bytes(root, &["cat", "-r", "BASE", "--", &target])
}

// --- svn info (cached; invalidates when wc.db moves) ---

struct SvnInfo {
    url: String,
}

type InfoCache = HashMap<PathBuf, (SystemTime, Arc<SvnInfo>)>;
static INFO_CACHE: LazyLock<RwLock<InfoCache>> = LazyLock::new(|| RwLock::new(HashMap::new()));

fn info(root: &Path) -> Result<Arc<SvnInfo>, VcsError> {
    let stamp = std::fs::metadata(root.join(".svn/wc.db"))
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    if let Some((t, cached)) = INFO_CACHE.read().unwrap_or_else(|e| e.into_inner()).get(root) {
        if *t == stamp {
            return Ok(cached.clone());
        }
    }
    let xml = run_text(root, &["info", "--xml"])?;
    let parsed = Arc::new(parse_info_url(&xml).ok_or("svn info: could not parse output")?);
    INFO_CACHE
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .insert(root.to_path_buf(), (stamp, parsed.clone()));
    Ok(parsed)
}

fn url_tail(url: &str) -> String {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("svn")
        .to_string()
}

// ---------------------------------------------------------------------------
// XML parsing (quick-xml; schemas verified against svn 1.14)
// ---------------------------------------------------------------------------

pub(crate) struct SvnStatusEntry {
    pub path: String,
    pub item: String,
}

pub(crate) fn parse_status_xml(xml: &str) -> Vec<SvnStatusEntry> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                // quick-xml 0.42: names and attribute keys/values are &str /
                // Cow<str>, already entity-decoded.
                match e.local_name().as_ref() {
                    "entry" => {
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == "path" {
                                path = Some(attr.value.clone().into_owned());
                            }
                        }
                    }
                    "wc-status" => {
                        let mut item = String::new();
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == "item" {
                                item = attr.value.clone().into_owned();
                            }
                        }
                        if let Some(p) = path.take() {
                            if !item.is_empty() {
                                out.push(SvnStatusEntry { path: p, item });
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    out
}

/// The URL of the first `<entry>` — for the WC root run, that's the WC's URL.
fn parse_info_url(xml: &str) -> Option<SvnInfo> {
    parse_info(xml).0.map(|url| SvnInfo { url })
}

/// `(first entry's url, every entry's path → kind)` — `info --depth infinity`
/// lists all versioned nodes (including scheduled-deleted ones), which is how
/// a deleted directory's member files are recovered.
fn parse_info(xml: &str) -> (Option<String>, HashMap<String, String>) {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut url: Option<String> = None;
    let mut kinds: HashMap<String, String> = HashMap::new();
    let mut in_url = false;
    let mut buf = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                match e.local_name().as_ref() {
                    "entry" => {
                        let mut path = String::new();
                        let mut kind = String::new();
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                "path" => path = attr.value.clone().into_owned(),
                                "kind" => kind = attr.value.clone().into_owned(),
                                _ => {}
                            }
                        }
                        if !path.is_empty() && !kind.is_empty() {
                            kinds.insert(path, kind);
                        }
                    }
                    // Only the root entry's url is wanted (nested entries
                    // carry their own <url>; the first one wins).
                    "url" if url.is_none() => {
                        in_url = true;
                        buf.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                if in_url {
                    buf.push_str(&unescape_bytes(t.as_ref()));
                }
            }
            // quick-xml splits entity references into their own events,
            // carrying the name between `&` and `;` — decode it back.
            Ok(Event::GeneralRef(entity)) => {
                if in_url {
                    match entity.as_ref() {
                        "amp" => buf.push('&'),
                        "lt" => buf.push('<'),
                        "gt" => buf.push('>'),
                        "quot" => buf.push('"'),
                        "apos" => buf.push('\''),
                        name => buf.push_str(name),
                    }
                }
            }
            Ok(Event::End(_)) => {
                if in_url {
                    url = Some(std::mem::take(&mut buf));
                    in_url = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    (url, kinds)
}

fn versioned_files_under(kinds: &HashMap<String, String>, dir_prefix: &str) -> Vec<String> {
    let mut files: Vec<String> = kinds
        .iter()
        .filter(|(p, k)| *k == "file" && p.starts_with(dir_prefix))
        .map(|(p, _)| p.clone())
        .collect();
    files.sort();
    files
}

/// Minimal XML entity decoding for text nodes — svn's `--xml` output is
/// UTF-8 and escapes at most the five predefined entities. (quick-xml 0.42
/// already decodes attribute values; text nodes arrive raw here.)
fn unescape_bytes(raw: &str) -> String {
    if !raw.contains('&') {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        let (entity, len) = if rest.starts_with("&amp;") {
            ("&", 5)
        } else if rest.starts_with("&lt;") {
            ("<", 4)
        } else if rest.starts_with("&gt;") {
            (">", 4)
        } else if rest.starts_with("&quot;") {
            ("\"", 6)
        } else if rest.starts_with("&apos;") {
            ("'", 6)
        } else {
            ("&", 1) // not an entity — keep the byte
        };
        out.push_str(entity);
        rest = &rest[len..];
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/// +/- line counts between two text sides. Added and deleted files count
/// whole lines; both sides absent is nothing.
pub(crate) fn line_stats_of(old: Option<&str>, new: Option<&str>) -> (usize, usize) {
    use similar::{ChangeTag, TextDiff};
    match (old, new) {
        (Some(o), Some(n)) => {
            let diff = TextDiff::from_lines(o, n);
            let mut additions = 0;
            let mut deletions = 0;
            for change in diff.iter_all_changes() {
                match change.tag() {
                    ChangeTag::Insert => additions += 1,
                    ChangeTag::Delete => deletions += 1,
                    ChangeTag::Equal => {}
                }
            }
            (additions, deletions)
        }
        (None, Some(n)) => (n.lines().count(), 0),
        (Some(o), None) => (0, o.lines().count()),
        (None, None) => (0, 0),
    }
}

/// The svn:eol-style normalization trigger: BASE is pure LF, the working copy
/// carries CRLF. Binary sides (containing NUL) never match.
pub(crate) fn base_is_lf_working_is_crlf(old: Option<&[u8]>, new: Option<&[u8]>) -> bool {
    match (old, new) {
        (Some(o), Some(n)) if !o.is_empty() && !n.is_empty() => {
            !o.contains(&0) && !o.contains(&b'\r') && n.windows(2).any(|w| w == b"\r\n")
        }
        _ => false,
    }
}

/// Binary sniff of just the first 8000 bytes (git's heuristic window) — used
/// for over-cap files whose full content is deliberately not loaded.
fn peek_binary(path: &Path) -> bool {
    use std::io::Read;
    std::fs::File::open(path)
        .and_then(|mut f| {
            let mut head = vec![0u8; 8000];
            match f.read(&mut head) {
                Ok(n) => Ok(crate::git::diff::looks_binary(&head[..n])),
                Err(e) => Err(e),
            }
        })
        .unwrap_or(false)
}

/// All files under `dir`, as root-relative forward-slash paths. VCS metadata
/// directories are never review content (an unversioned dir may legitimately
/// contain a foreign `.git` — a vendored checkout).
fn walk_files(root: &Path, dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk_into(root, dir, &mut out);
    out
}

fn walk_into(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if path.is_dir() {
            if name == ".svn" || name == ".git" {
                continue;
            }
            walk_into(root, &path, out);
        } else {
            let rel = path.strip_prefix(root).unwrap_or(&path);
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const STATUS_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path=".">
<entry path="file with spaces.txt">
<wc-status item="deleted" props="none" revision="1">
<commit revision="1"><author>t</author><date>2026-09-30T12:00:00Z</date></commit>
</wc-status>
</entry>
<entry path="src">
<wc-status item="normal" props="modified" revision="1"></wc-status>
</entry>
<entry path="src/a.txt">
<wc-status item="modified" props="none" revision="1"></wc-status>
</entry>
<entry path="src/added.txt">
<wc-status item="added" props="none" revision="-1"></wc-status>
</entry>
<entry path="src/replaced.txt">
<wc-status item="replaced" props="none" revision="-1"></wc-status>
</entry>
<entry path="src/missing.txt">
<wc-status item="missing" props="none" revision="2"></wc-status>
</entry>
<entry path="src/untracked.txt">
<wc-status item="unversioned" props="none"></wc-status>
</entry>
<entry path="unversioned_dir">
<wc-status item="unversioned" props="none"></wc-status>
</entry>
</target>
</status>"#;

    #[test]
    fn parses_status_items_and_paths() {
        let entries = parse_status_xml(STATUS_XML);
        let by_path = |p: &str| entries.iter().find(|e| e.path == p).unwrap().item.clone();
        assert_eq!(by_path("file with spaces.txt"), "deleted");
        assert_eq!(by_path("src"), "normal");
        assert_eq!(by_path("src/a.txt"), "modified");
        assert_eq!(by_path("src/replaced.txt"), "replaced");
        assert_eq!(by_path("src/missing.txt"), "missing");
        assert_eq!(by_path("unversioned_dir"), "unversioned");
        assert_eq!(entries.len(), 8);
    }

    const INFO_XML: &str = r#"<info>
<entry kind="dir" path="." revision="0">
<url>file:///tmp/re%20po/trunk</url>
<repository><root>file:///tmp/re%20po</root><uuid>u</uuid></repository>
</entry>
<entry kind="file" path="src" revision="1">
<url>file:///tmp/re%20po/trunk/src</url>
</entry>
<entry kind="file" path="src/deep/one.txt" revision="1"></entry>
<entry kind="dir" path="src/deep" revision="1"></entry>
</info>"#;

    #[test]
    fn parses_info_url_and_kinds() {
        let (url, kinds) = parse_info(INFO_XML);
        assert_eq!(url.as_deref(), Some("file:///tmp/re%20po/trunk"), "first entry's url only");
        assert_eq!(kinds.get(".").map(String::as_str), Some("dir"));
        assert_eq!(kinds.get("src/deep/one.txt").map(String::as_str), Some("file"));
        assert_eq!(kinds.get("src/deep").map(String::as_str), Some("dir"));
    }

    #[test]
    fn parses_info_url_with_entities() {
        let xml = r#"<info><entry><url>http://host/a&amp;b/trunk</url></entry></info>"#;
        let (url, _) = parse_info(xml);
        assert_eq!(url.as_deref(), Some("http://host/a&b/trunk"));
    }

    #[test]
    fn url_tail_handles_trailing_slash_and_empty() {
        assert_eq!(url_tail("http://h/repo/trunk"), "trunk");
        assert_eq!(url_tail("http://h/repo/trunk/"), "trunk");
        // A repo hosted at the URL root labels by its last segment (the host).
        assert_eq!(url_tail("http://h/"), "h");
    }

    #[test]
    fn line_stats_of_counts_added_and_deleted_lines() {
        let (a, d) = line_stats_of(Some("a\nb\n"), Some("a\nB\nc\n"));
        assert_eq!((a, d), (2, 1));
        assert_eq!(line_stats_of(None, Some("x\ny\n")), (2, 0));
        assert_eq!(line_stats_of(Some("x\n"), None), (0, 1));
        assert_eq!(line_stats_of(None, None), (0, 0));
    }

    #[test]
    fn crlf_heuristic_requires_pure_lf_base_and_crlf_working() {
        assert!(base_is_lf_working_is_crlf(Some(b"a\nb\n".as_slice()), Some(b"a\r\nb\r\n".as_slice())));
        assert!(!base_is_lf_working_is_crlf(Some(b"a\r\n".as_slice()), Some(b"a\r\n".as_slice())));
        assert!(!base_is_lf_working_is_crlf(Some(b"a\n".as_slice()), Some(b"b\n".as_slice())));
        assert!(!base_is_lf_working_is_crlf(None, Some(b"a\r\n".as_slice())));
    }

    #[test]
    fn walk_files_skips_vcs_metadata_and_is_relative() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("sub/.git")).unwrap();
        std::fs::write(dir.path().join("sub/.git/config"), b"").unwrap();
        std::fs::write(dir.path().join("sub/keep.txt"), b"").unwrap();
        std::fs::write(dir.path().join("top.txt"), b"").unwrap();
        let mut files = walk_files(dir.path(), dir.path());
        files.sort();
        assert_eq!(files, vec!["sub/keep.txt".to_string(), "top.txt".to_string()]);
    }

    #[test]
    fn missing_cli_message_names_the_fix() {
        assert!(MISSING_SVN_MESSAGE.contains("svn"));
        assert!(MISSING_SVN_MESSAGE.contains("brew install subversion"));
    }

    #[test]
    fn find_svn_scans_path_entries_and_survives_empty_path() {
        let dir = tempfile::TempDir::new().unwrap();
        let bin = dir.path().join("svn");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        let path_var = dir.path().display().to_string();
        assert_eq!(find_svn(&path_var), Some(bin.clone()));
        // A longer PATH keeps scanning entries in order.
        assert_eq!(find_svn(&format!("/nonexistent:{path_var}")), Some(bin));
        // An empty PATH falls through to the package-manager locations; on a
        // machine without any of them that's a clean None (the error then
        // carries the PATH for diagnosis).
        let _ = find_svn("");
    }

    // --- integration: a real throwaway repository (skipped when svn absent) ---

    fn scratch_wc() -> Option<(tempfile::TempDir, SvnRepo)> {
        if SVN_BINARY.is_none() {
            return None;
        }
        let dir = tempfile::TempDir::new().unwrap();
        let repo = dir.path().join("repo");
        let out = std::process::Command::new("svnadmin")
            .arg("create")
            .arg(&repo)
            .output()
            .expect("svnadmin create");
        assert!(out.status.success(), "svnadmin create failed");
        let repo_url = format!("file://{}", std::fs::canonicalize(&repo).unwrap().display());
        let wc = dir.path().join("wc");
        let out = std::process::Command::new("svn")
            .args(["checkout", "-q", &repo_url])
            .arg(&wc)
            .output()
            .expect("svn checkout");
        assert!(out.status.success(), "svn checkout: {}", String::from_utf8_lossy(&out.stderr));
        Some((dir, SvnRepo::new(wc)))
    }

    fn write(wc: &Path, rel: &str, content: &[u8]) {
        let p = wc.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, content).unwrap();
    }

    fn svn(wc: &Path, args: &[&str]) {
        let out = std::process::Command::new("svn")
            .arg("--non-interactive")
            .args(args)
            .current_dir(wc)
            .output()
            .expect("run svn");
        assert!(
            out.status.success(),
            "svn {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn target(wc: &Path) -> Target {
        Target {
            repo_path: wc.display().to_string(),
            worktree: None,
            mode: crate::git::model::DiffMode::Uncommitted,
            base: None,
            commit: None,
        }
    }

    #[test]
    fn uncommitted_reports_all_local_states_with_content() {
        let Some((dir, repo)) = scratch_wc() else { return };
        let wc = dir.path().join("wc");
        write(&wc, "src/a.txt", b"line1\nline2\n");
        write(&wc, "gone.txt", b"gone\n");
        write(&wc, "file with spaces.txt", b"spaces\n");
        svn(&wc, &["add", "-q", "src", "gone.txt", "file with spaces.txt"]);
        svn(&wc, &["ci", "-q", "-m", "init"]);
        // Local states: M, A, D, !, ? — created with no commit in between.
        write(&wc, "src/a.txt", b"line1\nCHANGED\nline2\n");
        write(&wc, "src/added.txt", b"brand new\n");
        svn(&wc, &["add", "-q", "src/added.txt"]);
        svn(&wc, &["rm", "-q", "file with spaces.txt"]);
        std::fs::remove_file(wc.join("gone.txt")).unwrap();
        write(&wc, "src/untracked.txt", b"untracked\n");

        let full = repo.compute_diff_full(&target(&wc)).unwrap();
        let by_path = |p: &str| full.summary.files.iter().find(|f| f.path == p).unwrap().clone();

        let modified = by_path("src/a.txt");
        assert_eq!(modified.status, FileStatus::Modified);
        assert_eq!((modified.additions, modified.deletions), (1, 0), "an inserted line; LCS keeps line1/line2");
        assert_eq!(full.files["src/a.txt"].old_content.as_deref(), Some("line1\nline2\n"));
        assert_eq!(full.files["src/a.txt"].new_content.as_deref(), Some("line1\nCHANGED\nline2\n"));

        let added = by_path("src/added.txt");
        assert_eq!(added.status, FileStatus::Added);
        assert_eq!((added.additions, added.deletions), (1, 0));
        assert_eq!(full.files["src/added.txt"].old_content, None);

        let deleted = by_path("file with spaces.txt");
        assert_eq!(deleted.status, FileStatus::Deleted);
        assert_eq!(full.files["file with spaces.txt"].old_content.as_deref(), Some("spaces\n"));
        assert_eq!(full.files["file with spaces.txt"].new_content, None);

        let missing = by_path("gone.txt");
        assert_eq!(missing.status, FileStatus::Deleted);
        assert_eq!(full.files["gone.txt"].old_content.as_deref(), Some("gone\n"));

        let untracked = by_path("src/untracked.txt");
        assert_eq!(untracked.status, FileStatus::Added);
        assert_eq!(full.files["src/untracked.txt"].new_content.as_deref(), Some("untracked\n"));

        // No property-only directory rows, and the labels describe the anchor.
        assert!(full.summary.files.iter().all(|f| f.path != "src"));
        assert_eq!(full.summary.base_label, "BASE");
        assert_eq!(full.summary.head_label, "working copy");
    }

    #[test]
    fn deleted_directory_expands_to_its_files() {
        let Some((dir, repo)) = scratch_wc() else { return };
        let wc = dir.path().join("wc");
        write(&wc, "src/deep/one.txt", b"a\n");
        write(&wc, "src/deep/two.txt", b"b\n");
        write(&wc, "src/top.txt", b"t\n");
        write(&wc, "keep.txt", b"k\n");
        svn(&wc, &["add", "-q", "src", "keep.txt"]);
        svn(&wc, &["ci", "-q", "-m", "init"]);
        svn(&wc, &["rm", "-q", "src/deep"]);

        let full = repo.compute_diff_full(&target(&wc)).unwrap();
        let paths: HashSet<&str> = full.summary.files.iter().map(|f| f.path.as_str()).collect();
        assert!(!paths.contains("src/deep"), "the directory row must not be a file entry");
        assert!(paths.contains("src/deep/one.txt"), "member files must appear; got {paths:?}");
        assert!(paths.contains("src/deep/two.txt"));
        assert!(!paths.contains("src/top.txt"), "siblings outside the deleted dir stay clean");
        let one = full.summary.files.iter().find(|f| f.path == "src/deep/one.txt").unwrap();
        assert_eq!(one.status, FileStatus::Deleted);
        assert_eq!((one.additions, one.deletions), (0, 1));
        assert_eq!(full.files["src/deep/one.txt"].old_content.as_deref(), Some("a\n"));
        assert_eq!(full.files["src/deep/one.txt"].new_content, None);
    }

    #[test]
    fn missing_directory_removed_behind_svns_back_also_expands() {
        let Some((dir, repo)) = scratch_wc() else { return };
        let wc = dir.path().join("wc");
        write(&wc, "pkg/lib/util.txt", b"u\n");
        svn(&wc, &["add", "-q", "pkg"]);
        svn(&wc, &["ci", "-q", "-m", "init"]);
        std::fs::remove_dir_all(wc.join("pkg")).unwrap();

        let full = repo.compute_diff_full(&target(&wc)).unwrap();
        let util = full
            .summary
            .files
            .iter()
            .find(|f| f.path == "pkg/lib/util.txt")
            .expect("the missing dir's files must appear");
        assert_eq!(util.status, FileStatus::Deleted);
        assert_eq!(full.files["pkg/lib/util.txt"].old_content.as_deref(), Some("u\n"));
    }

    #[test]
    fn replaced_file_reviews_as_added_in_v1() {
        let Some((dir, repo)) = scratch_wc() else { return };
        let wc = dir.path().join("wc");
        write(&wc, "replace.txt", b"orig\n");
        svn(&wc, &["add", "-q", "replace.txt"]);
        svn(&wc, &["ci", "-q", "-m", "init"]);
        // delete + add of the same path = replaced; `svn cat -r BASE` fails
        // with E200009 here (no pristine until commit) — the documented v1
        // limitation treats it as an add rather than erroring the diff.
        svn(&wc, &["rm", "-q", "--keep-local", "replace.txt"]);
        write(&wc, "replace.txt", b"replaced\n");
        svn(&wc, &["add", "-q", "replace.txt"]);

        let full = repo.compute_diff_full(&target(&wc)).unwrap();
        let entry = full.summary.files.iter().find(|f| f.path == "replace.txt").unwrap();
        assert_eq!(entry.status, FileStatus::Added);
        assert_eq!(full.files["replace.txt"].old_content, None);
        assert_eq!(full.files["replace.txt"].new_content.as_deref(), Some("replaced\n"));
    }

    #[test]
    fn unversioned_directories_descend_into_files() {
        let Some((dir, repo)) = scratch_wc() else { return };
        let wc = dir.path().join("wc");
        write(&wc, "keep.txt", b"committed\n");
        svn(&wc, &["add", "-q", "keep.txt"]);
        svn(&wc, &["ci", "-q", "-m", "init"]);
        write(&wc, "unversioned_dir/nested/deep.txt", b"deep\n");

        let full = repo.compute_diff_full(&target(&wc)).unwrap();
        let deep = full
            .summary
            .files
            .iter()
            .find(|f| f.path == "unversioned_dir/nested/deep.txt")
            .expect("unversioned dir contents must be walked");
        assert_eq!(deep.status, FileStatus::Added);
        assert_eq!(full.files["unversioned_dir/nested/deep.txt"].new_content.as_deref(), Some("deep\n"));
    }

    #[test]
    fn deltaignore_mutes_svn_files_like_git_ones() {
        let Some((dir, repo)) = scratch_wc() else { return };
        let wc = dir.path().join("wc");
        write(&wc, "src/a.txt", b"one\n");
        write(&wc, "gen/g.ts", b"generated\n");
        svn(&wc, &["add", "-q", "src", "gen"]);
        svn(&wc, &["ci", "-q", "-m", "init"]);
        write(&wc, "src/a.txt", b"two\n");
        write(&wc, "gen/g.ts", b"generated more\n");
        write(&wc, ".deltaignore", b"gen/\n");
        svn(&wc, &["add", "-q", "--no-ignore", ".deltaignore"]);

        let full = repo.compute_diff_full(&target(&wc)).unwrap();
        let gen = full.summary.files.iter().find(|f| f.path == "gen/g.ts").unwrap();
        assert!(gen.ignored);
        assert_eq!((gen.additions, gen.deletions), (0, 0));
        assert!(!full.files.contains_key("gen/g.ts"), "ignored content must not be retained");
        // …but still extractable on demand, like git.
        let fd = repo.get_file_diff(&target(&wc), "gen/g.ts").unwrap();
        assert_eq!(fd.new_content.as_deref(), Some("generated more\n"));
    }

    #[test]
    fn crlf_working_copy_against_lf_base_is_normalized() {
        let Some((dir, repo)) = scratch_wc() else { return };
        let wc = dir.path().join("wc");
        write(&wc, "eol.txt", b"lf\nlf\n");
        svn(&wc, &["add", "-q", "eol.txt"]);
        svn(&wc, &["propset", "-q", "svn:eol-style", "native", "eol.txt"]);
        svn(&wc, &["ci", "-q", "-m", "eol"]);
        // The working copy carries CRLF; the repo (BASE) form is LF.
        std::fs::write(wc.join("eol.txt"), b"lf\r\nCHANGED\r\n").unwrap();

        let full = repo.compute_diff_full(&target(&wc)).unwrap();
        let fd = &full.files["eol.txt"];
        assert_eq!(fd.old_content.as_deref(), Some("lf\nlf\n"));
        assert_eq!(fd.new_content.as_deref(), Some("lf\nCHANGED\n"));
        let entry = full.summary.files.iter().find(|f| f.path == "eol.txt").unwrap();
        assert_eq!((entry.additions, entry.deletions), (1, 1), "no spurious whole-file CRLF diff");
    }

    #[test]
    fn binary_files_are_flagged_content_dropped_and_old_side_pinned() {
        let Some((dir, repo)) = scratch_wc() else { return };
        let wc = dir.path().join("wc");
        let old_png = [0x89u8, b'O', b'L', b'D', 0x00, 0x01];
        write(&wc, "logo.png", &old_png);
        svn(&wc, &["add", "-q", "logo.png"]);
        svn(&wc, &["ci", "-q", "-m", "logo"]);
        let new_png = [0x89u8, b'N', b'E', b'W', 0x00, 0x02, 0x03];
        write(&wc, "logo.png", &new_png);

        let full = repo.compute_diff_full(&target(&wc)).unwrap();
        let entry = full.summary.files.iter().find(|f| f.path == "logo.png").unwrap();
        assert!(entry.binary);
        assert!(full.files["logo.png"].old_content.is_none());
        assert!(full.files["logo.png"].new_content.is_none());

        // Sizes come through the pinned/live source contract, and the pinned
        // old side survives a commit landing under the still-served snapshot.
        let vcs_repo = crate::vcs::Repo::Svn(SvnRepo::new(repo.root().to_path_buf()));
        let sources = full.sources.get("logo.png").unwrap();
        let sizes = vcs_repo.binary_sizes(sources).unwrap();
        assert_eq!(sizes.old_size, Some(old_png.len() as u64));
        assert_eq!(sizes.new_size, Some(new_png.len() as u64));
        assert_eq!(
            vcs_repo.read_source(sources, crate::vcs::BlobSide::Old).unwrap().as_deref(),
            Some(&old_png[..]),
            "the old side must answer from the pinned bytes"
        );

        // The BASE moves (commit) — the pinned old side must NOT follow it.
        svn(&wc, &["ci", "-q", "-m", "new logo"]);
        assert_eq!(
            vcs_repo.read_source(sources, crate::vcs::BlobSide::Old).unwrap().as_deref(),
            Some(&old_png[..]),
            "a served snapshot's old side is frozen at capture time"
        );
    }

    #[test]
    fn comments_reanchor_and_viewed_reset_across_refresh_for_svn() {
        use crate::git::cache::DiffCache;
        use crate::review::model::{Anchor, Comment, CommentScope, Review, Side, Snapshot, ViewedEntry};
        let Some((dir, repo)) = scratch_wc() else { return };
        let wc = dir.path().join("wc");
        write(&wc, "a.txt", b"line1\nline2\nline3\n");
        svn(&wc, &["add", "-q", "a.txt"]);
        svn(&wc, &["ci", "-q", "-m", "init"]);
        write(&wc, "a.txt", b"line1\nline2 CHANGED\nline3\n");

        let mut review = Review::new(
            "id".into(),
            target(&wc),
            Snapshot { base_oid: String::new(), head_oid: None, head_commit: None, captured_at: String::new() },
            "t".into(),
        );
        review.comments.push(Comment {
            id: "c1".into(),
            scope: CommentScope::Line,
            anchor: Some(Anchor {
                file: "a.txt".into(),
                side: Side::New,
                start_line: Some(2),
                end_line: None,
                snippet: Some("line2 CHANGED".into()),
            }),
            body: "b".into(),
            stale: false,
            resolved: false,
            commit: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        });
        // A freshly-toggled viewed entry carries an empty hash (the FE never
        // computes one) — reconcile stamps the current diff and keeps it.
        review.viewed.push(ViewedEntry { file: "a.txt".into(), diff_hash: String::new() });

        let cache = DiffCache::default();
        let session = crate::review::reconcile::reconcile(&cache, review).unwrap();
        assert_eq!(session.vcs, VcsKind::Svn);
        assert_eq!(session.review.snapshot.base_oid, "BASE");
        let c = &session.review.comments[0];
        assert!(!c.stale, "the anchor matches the current content");
        assert_eq!(c.anchor.as_ref().unwrap().start_line, Some(2));
        assert_eq!(session.review.viewed.len(), 1);
        assert!(!session.review.viewed[0].diff_hash.is_empty(), "the empty baseline is stamped");

        // …an edit that changes the file drops viewed and re-anchors the comment.
        write(&wc, "a.txt", b"header\nline1\nline2 CHANGED\nline3\n");
        cache.invalidate(&wc.display().to_string());
        let second = crate::review::reconcile::reconcile(&cache, session.review).unwrap();
        assert!(second.review.viewed.is_empty(), "a changed diff resets viewed");
        let c = &second.review.comments[0];
        assert!(!c.stale);
        assert_eq!(c.anchor.as_ref().unwrap().start_line, Some(3), "the anchor followed the shift");
    }

    #[test]
    fn worktree_label_is_the_url_tail() {
        let Some((_dir, repo)) = scratch_wc() else { return };
        // The scratch WC is a checkout of .../repo, so the URL tail is "repo".
        assert_eq!(repo.worktree_label(), "repo");
    }
}
