//! Process-wide diff cache. A per-file fetch used to re-run the whole-repo diff
//! (build + rename detection) every call — O(files) redundant work that dominated
//! large reviews. This memoizes diff *snapshots* (summary + every file's content,
//! built once by `compute_diff_full`) so each `get_file_diff` is a map read.
//!
//! Held in Tauri managed state. Snapshots are keyed by *target identity*
//! (repo/mode/base/commit) — not resolved OIDs — so the hot per-file path does zero
//! git work on a hit. Freshness therefore rides entirely on `invalidate`: the fs
//! watcher calls it on any working-tree/`.git` change, and `refresh_review` calls it
//! on a manual refresh. Committed-commit snapshots are immutable, and every other
//! mode's content-changing event (edit, commit, checkout, fetch) trips the watcher,
//! so a cached snapshot is only ever served for state the watcher would not have
//! invalidated. (#perf)
//!
//! The hot snapshots are only half the story. The UI never swaps its diff under
//! the user (#12): after `invalidate` the window keeps rendering the old snapshot
//! until Refresh is applied — so the *last served* snapshot per target (which
//! `invalidate` deliberately keeps) is the only record of "what the user is
//! actually looking at". The viewed-baseline stamp reads it
//! (`served_file`), so a "viewed" toggle in that window baselines the displayed
//! content rather than absorbing the unseen edit waiting on disk.
use std::sync::{Arc, Mutex};

use git2::Repository;

use crate::git::diff::{compute_diff_full, extract_file_diff, get_file_diff, with_fresh_sources, DiffSummary, FileDiff, FileSources, FullDiff};
use crate::git::open_repo;
use crate::git::model::{DiffMode, Target};
use crate::git::GitError;

/// Most recent snapshots to retain. A small LRU (not a single slot) so multiple
/// review windows on different targets don't evict each other. Per-snapshot content
/// is bounded by the MAX_CACHED_* caps in `diff.rs`, so held memory stays bounded.
const MAX_SNAPSHOTS: usize = 4;

/// Identity of a diff snapshot = its target. The diff content is fully determined by
/// (repo_path, mode, base, commit); resolved OIDs are deliberately NOT part of the
/// key (see the module doc — freshness comes from `invalidate`, so the hit path
/// avoids resolving them).
#[derive(PartialEq, Eq, Clone)]
struct SnapshotKey {
    repo_path: String,
    mode: DiffMode,
    base: Option<String>,
    commit: Option<String>,
}

fn key_of(target: &Target) -> SnapshotKey {
    SnapshotKey {
        repo_path: target.repo_path.clone(),
        mode: target.mode,
        base: target.base.clone(),
        commit: target.commit.clone(),
    }
}

struct Snapshot {
    key: SnapshotKey,
    diff: FullDiff,
}

#[derive(Default)]
struct Inner {
    /// Hot snapshots — dropped by `invalidate` so the next fetch rebuilds against
    /// current disk.
    hot: Vec<Arc<Snapshot>>,
    /// The last snapshot served per key — never dropped by `invalidate`. This is
    /// the "what the user is looking at" record; see the module doc.
    served: Vec<Arc<Snapshot>>,
}

/// Bounded LRU of recent diff snapshots. Cloning the handle is cheap (shared `Arc`)
/// so a command can move one into `spawn_blocking` and the fs watcher can hold its
/// own; the snapshots themselves are `Arc`-shared so reads clone content off-lock.
#[derive(Default, Clone)]
pub struct DiffCache(Arc<Mutex<Inner>>);

/// Replace (or append) the served copy for a key, bounded like the hot LRU.
fn upsert_served(served: &mut Vec<Arc<Snapshot>>, snap: &Arc<Snapshot>) {
    if let Some(pos) = served.iter().position(|s| s.key == snap.key) {
        served.remove(pos);
    }
    served.push(snap.clone());
    if served.len() > MAX_SNAPSHOTS {
        served.remove(0);
    }
}

/// Same worktree on disk? Cheap string-eq first, then a best-effort canonicalize so
/// the watcher's canonical root still matches a target opened by a symlinked path.
fn same_worktree(a: &str, b: &str) -> bool {
    a == b
        || matches!(
            (std::fs::canonicalize(a), std::fs::canonicalize(b)),
            (Ok(x), Ok(y)) if x == y
        )
}

impl DiffCache {
    /// Lock the cache, recovering from a poisoned mutex instead of panicking — a
    /// panic under the guard must not brick diff fetching for the rest of the session.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The snapshot for `target`, built on a miss. Shared by `summary` and `file`.
    /// The whole-repo build runs under the lock so concurrent first-fetches of the
    /// same target dedup onto one diff (rather than each running their own); the
    /// returned `Arc` then lets callers clone content out *after* the lock is dropped.
    fn snapshot(&self, target: &Target) -> Result<Arc<Snapshot>, GitError> {
        let key = key_of(target);
        let t0 = std::time::Instant::now();
        let mut cache = self.lock();
        let lock_wait = t0.elapsed();
        if let Some(pos) = cache.hot.iter().position(|s| s.key == key) {
            let hit = cache.hot.remove(pos);
            cache.hot.push(hit.clone()); // most-recently-used at the back
            upsert_served(&mut cache.served, &hit);
            if crate::perf::enabled() && lock_wait.as_millis() > 0 {
                eprintln!(
                    "[perf] snapshot hit  {}/{:?} lock_wait={:.1}ms",
                    target.repo_path.rsplit('/').next().unwrap_or(&target.repo_path),
                    target.mode,
                    lock_wait.as_secs_f64() * 1e3,
                );
            }
            return Ok(hit);
        }
        // The build itself runs under the lock by design (see the doc above); the
        // perf stamp splits lock_wait from build so a convoy shows up as N hits
        // with lock_wait ~= the one miss's build time.
        let build = std::time::Instant::now();
        let diff = compute_diff_full(target);
        if crate::perf::enabled() {
            let n = diff.as_ref().map_or(0, |d| d.summary.files.len());
            eprintln!(
                "[perf] snapshot MISS {}/{:?} files={n} lock_wait={:.1}ms build={:.1}ms",
                target.repo_path.rsplit('/').next().unwrap_or(&target.repo_path),
                target.mode,
                lock_wait.as_secs_f64() * 1e3,
                build.elapsed().as_secs_f64() * 1e3,
            );
        }
        let snap = Arc::new(Snapshot { key, diff: diff? });
        cache.hot.push(snap.clone());
        if cache.hot.len() > MAX_SNAPSHOTS {
            cache.hot.remove(0); // evict least-recently-used (front)
        }
        upsert_served(&mut cache.served, &snap);
        Ok(snap)
    }

    /// The file-list summary for `target` (builds + caches the snapshot on a miss).
    pub fn summary(&self, target: &Target) -> Result<DiffSummary, GitError> {
        Ok(self.snapshot(target)?.diff.summary.clone())
    }

    /// One file's diff for `target` — a map read once the snapshot is built. Files
    /// left out of the map (over the cache cap, or `.deltaignore`d) are extracted from
    /// the snapshot's header + sources, without rebuilding the whole-repo diff.
    pub fn file(&self, target: &Target, path: &str) -> Result<FileDiff, GitError> {
        let snap = self.snapshot(target)?;
        if let Some(fd) = snap.diff.files.get(path) {
            return Ok(fd.clone());
        }
        match (snap.diff.headers.get(path), snap.diff.sources.get(path)) {
            (Some(header), Some(sources)) => extract_file_diff(&open_repo(&target.repo_path)?, header, sources),
            _ => get_file_diff(target, path),
        }
    }

    /// Run `f` on `path`'s byte sources from the snapshot, so a binary card's reads
    /// need no whole-repo diff of their own — per-card diffs exhausted memory on huge
    /// repos when a screenful of images loaded at once.
    pub fn with_sources<T>(
        &self,
        target: &Target,
        path: &str,
        f: impl FnOnce(&Repository, &FileSources) -> T,
    ) -> Result<T, GitError> {
        let snap = self.snapshot(target)?;
        match snap.diff.sources.get(path) {
            Some(sources) => Ok(f(&open_repo(&target.repo_path)?, sources)),
            None => with_fresh_sources(target, path, f),
        }
    }

    /// One file's diff from the last snapshot *served* for `target` — the version
    /// the UI is (still) rendering. Unlike `file`, this never rebuilds from disk:
    /// after a watcher invalidation the window keeps showing the old snapshot until
    /// Refresh is applied, so the served copy — not current disk — is "what the
    /// user actually saw". `None` when nothing was ever served for this target. A
    /// file too large for the cached snapshot has no served copy and falls back to
    /// a fresh one-off read.
    pub fn served_file(&self, target: &Target, path: &str) -> Option<Result<FileDiff, GitError>> {
        let key = key_of(target);
        let snap = self.lock().served.iter().rev().find(|s| s.key == key)?.clone();
        match snap.diff.files.get(path) {
            Some(fd) => Some(Ok(fd.clone())),
            None => Some(get_file_diff(target, path)),
        }
    }

    /// Drop the hot snapshots for `worktree` (the path the fs watcher watches, or
    /// the target's repo path on manual refresh) so the next fetch rebuilds against
    /// current content. The served copies survive — see the module doc. A no-op for
    /// snapshots of other worktrees.
    pub fn invalidate(&self, worktree: &str) {
        let t = std::time::Instant::now();
        let mut inner = self.lock();
        let dropped = inner.hot.len();
        inner.hot.retain(|s| !same_worktree(&s.key.repo_path, worktree));
        if crate::perf::enabled() {
            eprintln!(
                "[perf] invalidate {worktree} dropped={} held={:.1}ms",
                dropped - inner.hot.len(),
                t.elapsed().as_secs_f64() * 1e3,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::{binary_sizes, BlobSide, MAX_CACHED_FILE_BYTES};
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;

    fn target(repo_path: &str, mode: DiffMode) -> Target {
        Target { repo_path: repo_path.into(), worktree: None, mode, base: None, commit: None }
    }

    #[test]
    fn deltaignored_file_is_extracted_on_demand_from_the_snapshot() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), ".deltaignore", "gen/
");
        write(dir.path(), "gen/api.ts", "export const generated = 1;
");
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);
        let cache = DiffCache::default();

        let entry = cache.summary(&t).unwrap().files.into_iter().find(|f| f.path == "gen/api.ts").unwrap();
        assert!(entry.ignored);
        assert!(cache.snapshot(&t).unwrap().diff.files.get("gen/api.ts").is_none());

        let fd = cache.file(&t, "gen/api.ts").unwrap();
        assert_eq!(fd.new_content.as_deref(), Some("export const generated = 1;
"));
    }

    #[test]
    fn serves_summary_and_file_from_one_computation() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\nline2\n");
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);
        let cache = DiffCache::default();

        let summary = cache.summary(&t).unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "file.txt");

        let fd = cache.file(&t, "file.txt").unwrap();
        assert_eq!(fd.old_content.as_deref(), Some("line1\nline2\n"));
        assert_eq!(fd.new_content.as_deref(), Some("line1\nCHANGED\nline2\n"));
    }

    #[test]
    fn memoizes_snapshot_until_invalidated() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nAAA\nline2\n");
        let repo_path = dir.path().to_str().unwrap().to_string();
        let t = target(&repo_path, DiffMode::Uncommitted);
        let cache = DiffCache::default();

        // First read builds the snapshot and returns AAA.
        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("line1\nAAA\nline2\n"));

        // The working tree changes, but with no invalidation the cache keeps serving
        // the memoized snapshot — this is the whole point: per-file fetches are map
        // reads, not a fresh whole-repo diff each time.
        write(dir.path(), "file.txt", "line1\nBBB\nline2\n");
        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("line1\nAAA\nline2\n"));

        // The fs watcher fires → invalidate → the next read rebuilds and sees BBB.
        cache.invalidate(&repo_path);
        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("line1\nBBB\nline2\n"));
    }

    #[test]
    fn invalidate_keeps_the_served_snapshot_until_a_fetch_replaces_it() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nAAA\nline2\n");
        let repo_path = dir.path().to_str().unwrap().to_string();
        let t = target(&repo_path, DiffMode::Uncommitted);
        let cache = DiffCache::default();

        // Nothing fetched yet → nothing served.
        assert!(cache.served_file(&t, "file.txt").is_none());

        // The diff pane fetches the file — the served copy becomes AAA (what's on screen).
        cache.file(&t, "file.txt").unwrap();
        assert_eq!(cache.served_file(&t, "file.txt").unwrap().unwrap().new_content.as_deref(), Some("line1\nAAA\nline2\n"));

        // The watcher invalidates on the disk edit; the served copy must keep AAA —
        // the window is still rendering it until Refresh is applied.
        write(dir.path(), "file.txt", "line1\nBBB\nline2\n");
        cache.invalidate(&repo_path);
        assert_eq!(
            cache.served_file(&t, "file.txt").unwrap().unwrap().new_content.as_deref(),
            Some("line1\nAAA\nline2\n"),
            "invalidate must not drop the served (still displayed) snapshot",
        );

        // Only once a fetch actually rebuilds does the served copy advance to BBB.
        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("line1\nBBB\nline2\n"));
        assert_eq!(cache.served_file(&t, "file.txt").unwrap().unwrap().new_content.as_deref(), Some("line1\nBBB\nline2\n"));
    }

    #[test]
    fn falls_back_for_file_too_large_to_cache() {
        let (dir, _repo) = repo_with_commit();
        // A file above the per-file cap is left out of the cached snapshot, so it must
        // still be served (via a one-off diff), never reported missing.
        let big = "x".repeat(MAX_CACHED_FILE_BYTES as usize + 1024);
        write(dir.path(), "big.txt", &big);
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);
        let cache = DiffCache::default();

        let fd = cache.file(&t, "big.txt").unwrap();
        assert_eq!(fd.new_content.as_deref(), Some(big.as_str()));
    }

    #[test]
    fn serves_binary_from_snapshot_sources_with_live_worktree_bytes() {
        let (dir, _repo) = repo_with_commit();
        std::fs::write(dir.path().join("logo.png"), [0x89u8, b'P', 0x00, 0x01]).unwrap();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);
        let cache = DiffCache::default();

        let sizes = |cache: &DiffCache| cache.with_sources(&t, "logo.png", binary_sizes).unwrap().new_size;
        assert_eq!(sizes(&cache), Some(4));
        std::fs::write(dir.path().join("logo.png"), [0x89u8, b'P', 0x00, 0x01, 0x02, 0x03]).unwrap();
        assert_eq!(sizes(&cache), Some(6));
    }

    #[test]
    fn invalidate_only_drops_the_matching_worktree() {
        let (dir_a, _a) = repo_with_commit();
        write(dir_a.path(), "file.txt", "A1\n");
        let path_a = dir_a.path().to_str().unwrap().to_string();
        let t = target(&path_a, DiffMode::Uncommitted);
        let cache = DiffCache::default();

        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("A1\n"));
        // Invalidating an unrelated worktree must NOT drop this snapshot.
        cache.invalidate("/some/other/worktree");
        write(dir_a.path(), "file.txt", "A2\n");
        assert_eq!(cache.file(&t, "file.txt").unwrap().new_content.as_deref(), Some("A1\n"), "unrelated invalidate must not evict");
    }

    /// Perf probe for the slow-image-previews investigation. Not part of the
    /// normal suite (ignored): builds a "busy agent" repo — hundreds of modified
    /// text files plus a screenful of modified images — then contrasts concurrent
    /// blob reads on a hot cache against the same reads re-run after every
    /// watcher `invalidate`. After an invalidate the first request rebuilds the
    /// whole-repo snapshot *while holding the global cache lock*, so the rest of
    /// the screen's image reads serialize behind it: per-round wall time ~= one
    /// full snapshot rebuild. Run it in release:
    ///   cargo test --release blob_convoy -- --ignored --nocapture
    #[test]
    #[ignore = "perf probe — slow by design; run explicitly in release with --nocapture"]
    fn blob_convoy_under_invalidation() {
        // Shape is tunable via env so the probe can be sized like a real repo:
        //   CONVOY_TEXT=2000 CONVOY_IMG=40 CONVOY_IMG_BYTES=1048576 cargo test …
        let envn = |k: &str, d: usize| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        let (n_text, n_img) = (envn("CONVOY_TEXT", 400), envn("CONVOY_IMG", 20));
        let (img_bytes, rounds) = (envn("CONVOY_IMG_BYTES", 256 * 1024), envn("CONVOY_ROUNDS", 8));
        const READERS: usize = 16;

        // Deterministic pseudo-random bytes (no rand dep): NUL-rich so both git's
        // delta flagging and looks_binary treat them as binary, like real PNGs.
        fn noise(seed: u64, len: usize) -> Vec<u8> {
            let (mut s, mut buf) = (seed, Vec::with_capacity(len));
            for _ in 0..len {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                buf.push((s >> 56) as u8);
            }
            buf
        }
        fn png_like(seed: u64, len: usize) -> Vec<u8> {
            let mut b = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
            b.extend(noise(seed, len - 8));
            b
        }

        let (dir, repo) = repo_with_commit();
        let text_path = |i: usize| format!("src/mod-{i:03}.ts");
        let img_path = |i: usize| format!("shots/shot-{i:03}.png");

        // Base commit: every file clean and committed…
        for i in 0..n_text {
            write(dir.path(), &text_path(i), &format!("// module {i}\nexport const v{i} = {i};\n"));
        }
        std::fs::create_dir_all(dir.path().join("shots")).unwrap();
        for i in 0..n_img {
            std::fs::write(dir.path().join(img_path(i)), png_like(i as u64 + 1, img_bytes)).unwrap();
        }
        commit_all(&repo, "base");

        // …then the whole tree modified at once — the review-a-busy-agent shape.
        for i in 0..n_text {
            write(dir.path(), &text_path(i), &format!("// module {i} CHANGED\nexport const v{i} = {};\n", i * 7 + 1));
        }
        for i in 0..n_img {
            std::fs::write(dir.path().join(img_path(i)), png_like(i as u64 + 1_000_000, img_bytes)).unwrap();
        }

        let repo_path = dir.path().to_str().unwrap().to_string();
        let t = target(&repo_path, DiffMode::Uncommitted);
        let cache = DiffCache::default();

        // What the delta-blob scheme handler does per <img>: resolve sources via
        // the snapshot, then read the new side's bytes off the worktree.
        fn read_img(cache: &DiffCache, t: &Target, path: &str) -> usize {
            cache
                .with_sources(t, path, |repo, s| s.read(repo, BlobSide::New))
                .unwrap()
                .expect("image bytes")
                .len()
        }

        // Phase 1 — cold: the first blob request pays the whole-repo snapshot build.
        let cold = std::time::Instant::now();
        let n = read_img(&cache, &t, &img_path(0));
        let cold_ms = cold.elapsed().as_secs_f64() * 1e3;
        let files = cache.summary(&t).unwrap().files.len();
        println!("repo shape: {n_text} modified text files + {n_img} images of {}KB each", img_bytes / 1024);
        println!("cold first blob read:  {cold_ms:8.1}ms  ({files} changed files, image {n} bytes)");

        let run_round = |tag: &str| -> f64 {
            let (c, tt) = (&cache, &t);
            let wall = std::time::Instant::now();
            std::thread::scope(|sc| {
                for r in 0..READERS {
                    let img = img_path(r % n_img);
                    sc.spawn(move || assert_eq!(read_img(c, tt, &img), img_bytes));
                }
            });
            let ms = wall.elapsed().as_secs_f64() * 1e3;
            println!("{tag} {READERS} concurrent reads: {ms:8.1}ms");
            ms
        };

        // Phase 2 — control: cache hot, no invalidation — every read is a map read.
        let hot: f64 = (0..rounds).map(|_| run_round("hot    ")).sum();

        // Phase 3 — watcher storm: like an agent writing while the user scrolls.
        // Each invalidate drops the snapshot, so every round's first request
        // rebuilds it under the lock while the other reads queue behind.
        let mut storm = 0.0;
        for r in 0..rounds {
            write(dir.path(), &text_path(r), &format!("// module {r} EDITED AGAIN\n"));
            cache.invalidate(&repo_path);
            storm += run_round("storm  ");
        }

        println!();
        println!("summary: {rounds} rounds × {READERS} reads — hot total {hot:.0}ms vs storm total {storm:.0}ms");
        println!(
            "convoy factor: storm/hot = {:.0}× (per-round storm {:.0}ms ≈ one snapshot rebuild of {cold_ms:.0}ms)",
            storm / hot.max(1e-9),
            storm / rounds as f64,
        );
    }

    #[test]
    fn keeps_snapshots_for_multiple_targets() {
        let (dir_a, _a) = repo_with_commit();
        write(dir_a.path(), "file.txt", "A\n");
        let (dir_b, _b) = repo_with_commit();
        write(dir_b.path(), "file.txt", "B\n");
        let ta = target(dir_a.path().to_str().unwrap(), DiffMode::Uncommitted);
        let tb = target(dir_b.path().to_str().unwrap(), DiffMode::Uncommitted);
        let cache = DiffCache::default();

        assert_eq!(cache.file(&ta, "file.txt").unwrap().new_content.as_deref(), Some("A\n"));
        // A second target must not evict the first (no single-slot thrash).
        assert_eq!(cache.file(&tb, "file.txt").unwrap().new_content.as_deref(), Some("B\n"));
        // Change A without invalidating; A's snapshot must survive building B — with a
        // single slot it would have been evicted and this would rebuild to "A2".
        write(dir_a.path(), "file.txt", "A2\n");
        assert_eq!(cache.file(&ta, "file.txt").unwrap().new_content.as_deref(), Some("A\n"), "target A must survive building target B");
    }
}
