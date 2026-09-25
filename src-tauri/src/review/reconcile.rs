use crate::anchor::{diff_hash, reanchor};
use crate::git::cache::DiffCache;
use crate::git::diff::DiffSummary;
use crate::git::model::Target;
use crate::git::{open_repo, resolve_endpoints, resolve_worktree, GitError, RightSide};
use crate::review::model::{review_id, Review, Side, Snapshot};
use git2::{Oid, Repository, Sort};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub review: Review,
    pub summary: DiffSummary,
    /// Canonical repo display name (the main worktree's dir name). Filled by the
    /// command layer; reconcile itself leaves it empty.
    #[serde(default)]
    pub repo_name: String,
}

impl ReviewSession {
    pub fn reviewable_file_count(&self) -> u32 {
        self.summary.files.iter().filter(|f| !f.ignored).count() as u32
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Reconcile a review against the current repo state: re-resolve worktree/id,
/// recompute the diff, re-anchor comments (best-effort, else stale), reset viewed
/// where the file's diff changed, and refresh the snapshot.
pub fn reconcile(cache: &DiffCache, mut review: Review) -> Result<ReviewSession, GitError> {
    let repo = open_repo(&review.target.repo_path)?;
    let worktree = resolve_worktree(&repo)?;
    review.target.worktree = Some(worktree.clone());
    review.id = review_id(&review.target.repo_path, &worktree);

    let summary = cache.summary(&review.target)?;
    let present: HashSet<String> =
        summary.files.iter().map(|f| f.path.clone()).collect();
    let ignored: std::collections::HashSet<String> =
        summary.files.iter().filter(|f| f.ignored).map(|f| f.path.clone()).collect();

    // Hand untagged comments to the commits that landed since the last snapshot
    // (before the stale loop, so freshly-tagged comments take the frozen path).
    let head_commit_oid = hand_off_to_new_commits(&repo, &mut review);

    // Re-anchor comments.
    let target = review.target.clone();
    for comment in &mut review.comments {
        // Commit-tagged comments are frozen: the commit is immutable, so the anchor
        // never needs re-checking — it's stale only if the commit is no longer
        // reachable from HEAD (history was rewritten away).
        if let Some(oid) = comment.commit.clone() {
            comment.stale = !commit_reachable_from_head(&repo, head_commit_oid, &oid);
            continue;
        }
        let Some(anchor) = comment.anchor.as_mut() else {
            continue; // general note — no anchor
        };
        if ignored.contains(anchor.file.as_str()) {
            continue;
        }
        let has_lines = anchor.start_line.is_some() && anchor.snippet.is_some();
        if !has_lines {
            // file-scope: present in diff => fresh, else stale
            comment.stale = !present.contains(anchor.file.as_str());
            continue;
        }
        let content = file_side_content(cache, &target, &anchor.file, anchor.side);
        match content {
            Some(content) => {
                match reanchor(
                    anchor.start_line.unwrap(),
                    anchor.snippet.as_deref().unwrap(),
                    &content,
                ) {
                    Some((start, end)) => {
                        anchor.start_line = Some(start);
                        anchor.end_line = end;
                        comment.stale = false;
                    }
                    None => comment.stale = true,
                }
            }
            None => comment.stale = true, // file removed from diff or binary
        }
    }

    // Reset viewed entries whose file diff changed (or vanished).
    // An empty diff_hash here is the fallback path — legacy data, or a save whose
    // stamp found nothing served — so stamp the current content and keep.
    review.viewed = std::mem::take(&mut review.viewed)
        .into_iter()
        .filter_map(|mut v| {
            if !present.contains(&v.file) {
                return None; // file no longer in the diff → drop viewed progress
            }
            if ignored.contains(&v.file) {
                return Some(v);
            }
            match cache.file(&target, &v.file) {
                Ok(fd) => {
                    let current = diff_hash(
                        fd.old_content.as_deref().unwrap_or(""),
                        fd.new_content.as_deref().unwrap_or(""),
                    );
                    if v.diff_hash.is_empty() {
                        v.diff_hash = current; // first reconcile after toggle → stamp + keep
                        Some(v)
                    } else if v.diff_hash == current {
                        Some(v) // unchanged → keep
                    } else {
                        None // file's diff changed since viewed → drop
                    }
                }
                Err(_) => Some(v), // present but unreadable → keep (don't lose on uncertainty)
            }
        })
        .collect();

    // Refresh snapshot.
    let ep = resolve_endpoints(&repo, &review.target)?;
    review.snapshot = Snapshot {
        base_oid: ep.from_tree.map(|o| o.to_string()).unwrap_or_default(),
        head_oid: match ep.right {
            RightSide::Tree(o) => Some(o.to_string()),
            RightSide::WorkTree => None,
        },
        head_commit: head_commit_oid.map(|o| o.to_string()),
        captured_at: now(),
    };
    review.last_opened_at = now();

    Ok(ReviewSession { review, summary, repo_name: String::new() })
}

/// Hand untagged comments over to the commits that landed since the last
/// snapshot. A comment written against the working tree belongs to the code it
/// was written about: once that code is committed, the comment follows it into
/// history — tagged with the newest commit that touched its file — instead of
/// rotting as an untagged stale note on a diff that no longer contains it.
/// Tagged comments stay reachable forever (view that commit in the picker);
/// they also drop out of the working view and the agent export.
///
/// Only a linear fast-forward counts (the stored HEAD must remain an ancestor
/// of the new HEAD). A rebase/force-push or a branch switch is not "the work
/// got committed" — there the comments stay put and staleness decides. Returns
/// the current HEAD commit oid for the snapshot refresh.
fn hand_off_to_new_commits(repo: &Repository, review: &mut Review) -> Option<Oid> {
    let head = repo.head().ok()?.peel_to_commit().ok()?;
    let head_oid = head.id();
    let Some(prev) = review.snapshot.head_commit.clone() else {
        return Some(head_oid); // fresh review or pre-field data — stamp, never tag
    };
    let Ok(prev_oid) = Oid::from_str(&prev) else {
        return Some(head_oid);
    };
    if prev_oid == head_oid {
        return Some(head_oid); // nothing landed
    }
    if !repo.graph_descendant_of(head_oid, prev_oid).unwrap_or(false) {
        return Some(head_oid); // rewritten/switched — not a plain addition
    }

    // Walk (prev, HEAD] newest-first: the first commit seen touching a file is
    // that file's newest owner. Both delta sides are recorded so a rename's old
    // path still hands off comments anchored to it.
    let mut owner: HashMap<String, String> = HashMap::new();
    if let Ok(mut walk) = repo.revwalk() {
        let _ = walk.set_sorting(Sort::TIME);
        if walk.push(head_oid).is_ok() && walk.hide(prev_oid).is_ok() {
            for oid in walk.flatten() {
                let Ok(commit) = repo.find_commit(oid) else { continue };
                let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
                let Ok(tree) = commit.tree() else { continue };
                if let Ok(diff) = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None) {
                    for delta in diff.deltas() {
                        for path in [delta.old_file().path(), delta.new_file().path()].into_iter().flatten() {
                            owner
                                .entry(path.to_string_lossy().into_owned())
                                .or_insert_with(|| commit.id().to_string());
                        }
                    }
                }
            }
        }
    }

    for comment in &mut review.comments {
        if comment.commit.is_some() {
            continue; // already owned by a commit — never retagged
        }
        if let Some(oid) = comment.anchor.as_ref().and_then(|a| owner.get(&a.file)) {
            comment.commit = Some(oid.clone());
        }
    }
    Some(head_oid)
}

/// A commit-tagged comment's commit must still be reachable from HEAD (an
/// ancestor of it, or HEAD itself). Reachability — not branch membership — so
/// comments tagged with commits on the base branch itself (a repo reviewed on
/// `main`) don't read as stale.
fn commit_reachable_from_head(repo: &Repository, head_oid: Option<Oid>, oid: &str) -> bool {
    let Some(head) = head_oid else { return false };
    let Ok(target) = Oid::from_str(oid) else { return false };
    if target == head {
        return true; // libgit2 does not count a commit as its own descendant
    }
    let Ok(commit) = repo.find_commit(target) else { return false };
    repo.graph_descendant_of(head, commit.id()).unwrap_or(false)
}

/// Fill a content baseline into any viewed entry that lacks one, hashing the
/// file's diff from the cache's *served* snapshot — the last one fetched for
/// this target, which `invalidate` does not drop — so the baseline is the
/// version on screen, not whatever is on disk now. This matters in the
/// agent-workflow window between a watcher invalidation and the user applying
/// Refresh: the UI still renders the old snapshot there, and a stamp that read
/// current disk would absorb the unseen edit — the next `reconcile` would then
/// keep the file marked viewed across a diff the user never reviewed. Called at
/// save time (the moment the user toggles "viewed") and from the refresh path
/// (see `refresh_review_impl`). A target this process never fetched (or a file
/// too large for the snapshot) leaves the hash empty for `reconcile`'s lazy
/// stamp. Idempotent: a non-empty hash is never overwritten.
pub fn stamp_viewed_baselines(cache: &DiffCache, review: &mut Review) {
    for v in review.viewed.iter_mut() {
        if !v.diff_hash.is_empty() {
            continue;
        }
        if let Some(Ok(fd)) = cache.served_file(&review.target, &v.file) {
            v.diff_hash = diff_hash(
                fd.old_content.as_deref().unwrap_or(""),
                fd.new_content.as_deref().unwrap_or(""),
            );
        }
    }
}

/// Overlay persisted viewed baselines onto the review the frontend holds in
/// memory. The frontend sends its in-memory review to `refresh_review`; an entry
/// it toggled since the last reconcile still carries an empty hash there, even
/// though `save_review` already stamped and persisted the real baseline. Adopt
/// the persisted hash so `reconcile` compares against the version the user saw,
/// not the (possibly already-changed) current content.
pub fn adopt_persisted_viewed_hashes(incoming: &mut Review, persisted: &Review) {
    for v in incoming.viewed.iter_mut() {
        if !v.diff_hash.is_empty() {
            continue;
        }
        if let Some(p) = persisted
            .viewed
            .iter()
            .find(|p| p.file == v.file && !p.diff_hash.is_empty())
        {
            v.diff_hash = p.diff_hash.clone();
        }
    }
}

/// Comments are owned by the save path, not the refresh path. The review the
/// frontend hands to `refresh_review` can lag its own state — `reviewRef` is
/// updated in a post-commit effect, so a refresh firing right after a comment is
/// added carries the *older* comment list. Trusting it would let the refresh
/// persist that reduced set and silently drop the new comment (the diff-refresh
/// data-loss bug). Reconcile against the authoritative on-disk comments instead:
/// a comment the frontend added but hasn't saved yet is absent here, but it stays
/// safe in the frontend's memory (its own save lands independently, and the
/// frontend re-merges the refreshed state onto its live comments when applied).
pub fn restore_persisted_comments(incoming: &mut Review, persisted: &Review) {
    incoming.comments = persisted.comments.clone();
}

fn file_side_content(cache: &DiffCache, target: &Target, file: &str, side: Side) -> Option<String> {
    let fd = cache.file(target, file).ok()?;
    match side {
        Side::New => fd.new_content,
        Side::Old => fd.old_content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::{DiffMode, Target};
    use crate::git::test_support::*;
    use crate::review::model::{Anchor, Comment, CommentScope, Review, Side, Snapshot, ViewedEntry};

    fn empty_review(repo_path: &str) -> Review {
        let target = Target {
            repo_path: repo_path.into(),
            worktree: None,
            mode: DiffMode::Uncommitted,
            base: None,
            commit: None,
        };
        Review::new(
            "id".into(),
            target,
            Snapshot { base_oid: "".into(), head_oid: None, head_commit: None, captured_at: "".into() },
            "t".into(),
        )
    }

    fn line_comment(file: &str, line: u32, snippet: &str) -> Comment {
        Comment {
            id: "c1".into(),
            scope: CommentScope::Line,
            anchor: Some(Anchor {
                file: file.into(),
                side: Side::New,
                start_line: Some(line),
                end_line: None,
                snippet: Some(snippet.into()),
            }),
            body: "b".into(),
            stale: false,
            resolved: false,
            commit: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }

    /// A feature branch off main with one commit, returning (dir, repo, commit oid).
    fn repo_with_feature_commit() -> (tempfile::TempDir, git2::Repository, git2::Oid) {
        let (dir, repo) = repo_with_commit(); // main @ initial
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.branch("feature", &repo.find_commit(base).unwrap(), false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        write(dir.path(), "file.txt", "line1\nADDED\nline2\n");
        let oid = commit_all(&repo, "second on feature");
        (dir, repo, oid)
    }

    #[test]
    fn tagged_comment_stays_fresh_when_its_commit_is_present() {
        let (dir, _repo, oid) = repo_with_feature_commit();
        let mut r = empty_review(dir.path().to_str().unwrap());
        r.target.mode = DiffMode::BranchVsBase;
        let mut c = line_comment("file.txt", 2, "ADDED");
        c.commit = Some(oid.to_string());
        r.comments.push(c);
        let session = reconcile(&DiffCache::default(), r).unwrap();
        assert!(!session.review.comments[0].stale, "a present commit's comment stays fresh");
    }

    #[test]
    fn tagged_comment_goes_stale_when_its_commit_is_gone() {
        let (dir, _repo, _oid) = repo_with_feature_commit();
        let mut r = empty_review(dir.path().to_str().unwrap());
        r.target.mode = DiffMode::BranchVsBase;
        let mut c = line_comment("file.txt", 2, "ADDED");
        c.commit = Some("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef".into());
        r.comments.push(c);
        let session = reconcile(&DiffCache::default(), r).unwrap();
        assert!(session.review.comments[0].stale, "an unknown commit oid => stale");
    }

    #[test]
    fn tagged_comment_stays_fresh_on_the_base_branch_itself() {
        // A repo reviewed directly on `main`: the branch walk (merge-base..HEAD)
        // is empty there, so branch-membership staleness would flag every tagged
        // comment. Reachability from HEAD is the criterion — this stays fresh.
        let (dir, repo) = repo_with_commit();
        let head = repo.head().unwrap().peel_to_commit().unwrap().id();
        let mut r = empty_review(dir.path().to_str().unwrap());
        let mut c = line_comment("file.txt", 1, "line1");
        c.commit = Some(head.to_string());
        r.comments.push(c);
        let session = reconcile(&DiffCache::default(), r).unwrap();
        assert!(!session.review.comments[0].stale, "a commit reachable from HEAD is not stale, even on the base branch");
    }

    #[test]
    fn committing_the_work_hands_untagged_comments_to_the_commit_that_took_their_file() {
        // The review-before-commit workflow: the user comments uncommitted agent
        // work; the agent then commits it. The comment on the committed file
        // follows it into history; the one on a still-uncommitted file stays live.
        let (dir, _repo) = repo_with_commit(); // main @ initial, file.txt = line1\nline2
        write(dir.path(), "file.txt", "line1\nADDED\nline2\n"); // the work under review
        write(dir.path(), "other.txt", "draft\n"); // stays uncommitted

        // First reconcile while the work is uncommitted — stamps snapshot.head_commit.
        let mut r = empty_review(dir.path().to_str().unwrap());
        let mut other = line_comment("other.txt", 1, "draft");
        other.id = "c2".into();
        r.comments.push(line_comment("file.txt", 2, "ADDED"));
        r.comments.push(other);
        let first = reconcile(&DiffCache::default(), r).unwrap();
        assert!(first.review.comments.iter().all(|c| c.commit.is_none()));

        // The agent commits file.txt (only).
        let repo = git2::Repository::open(dir.path()).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("T", "t@t").unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        let oid = repo
            .commit(Some("HEAD"), &sig, &sig, "agent work", &tree, &[&parent])
            .unwrap();

        let second = reconcile(&DiffCache::default(), first.review).unwrap();
        let by_file = |f: &str| {
            second.review.comments.iter().find(|c| c.anchor.as_ref().unwrap().file == f).unwrap()
        };
        assert_eq!(by_file("file.txt").commit, Some(oid.to_string()), "the committed file's comment is handed to that commit");
        assert!(by_file("other.txt").commit.is_none(), "a still-uncommitted file's comment stays live");
        assert!(!by_file("file.txt").stale, "the handed-off comment is fresh — its commit is reachable");
        // And the snapshot advanced, so the same handoff can't fire twice.
        assert_eq!(second.review.snapshot.head_commit.as_deref(), Some(oid.to_string().as_str()));
    }

    #[test]
    fn a_history_rewrite_does_not_hand_off_comments() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nADDED\nline2\n");
        let mut r = empty_review(dir.path().to_str().unwrap());
        r.comments.push(line_comment("file.txt", 2, "ADDED"));
        let first = reconcile(&DiffCache::default(), r).unwrap();

        // A commit lands, then the branch is reset to before it (rewrite): the
        // stored HEAD is no longer an ancestor of the new HEAD, so this is not
        // "the work got committed" — the comment must stay untagged.
        let repo = git2::Repository::open(dir.path()).unwrap();
        let start = repo.head().unwrap().peel_to_commit().unwrap().id();
        write(dir.path(), "file.txt", "line1\nADDED\nline2\nextra\n");
        let _mid = commit_all(&repo, "to be undone");
        let old = repo.find_commit(start).unwrap();
        repo.reset(old.as_object(), git2::ResetType::Hard, None).unwrap();

        let second = reconcile(&DiffCache::default(), first.review).unwrap();
        assert!(second.review.comments[0].commit.is_none(), "a rewritten-away HEAD must not tag comments");
    }

    #[test]
    fn reanchors_moved_comment_and_clears_stale() {
        let (dir, _repo) = repo_with_commit(); // file.txt = "line1\nline2\n"
        write(dir.path(), "file.txt", "inserted\nline1\nline2\n"); // line1 moved 1->2
        let mut r = empty_review(dir.path().to_str().unwrap());
        let mut c = line_comment("file.txt", 1, "line1");
        c.stale = true;
        r.comments.push(c);
        let session = reconcile(&DiffCache::default(), r).unwrap();
        let a = session.review.comments[0].anchor.as_ref().unwrap();
        assert_eq!(a.start_line, Some(2));
        assert_eq!(session.review.comments[0].stale, false);
    }

    #[test]
    fn marks_stale_when_snippet_gone() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "completely\ndifferent\n");
        let mut r = empty_review(dir.path().to_str().unwrap());
        r.comments.push(line_comment("file.txt", 1, "line1"));
        let session = reconcile(&DiffCache::default(), r).unwrap();
        assert_eq!(session.review.comments[0].stale, true);
    }

    #[test]
    fn leaves_comments_and_viewed_on_deltaignored_files_untouched() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), ".deltaignore", "file.txt\n");
        write(dir.path(), "file.txt", "completely\ndifferent\n");
        let mut r = empty_review(dir.path().to_str().unwrap());
        r.comments.push(line_comment("file.txt", 1, "line1"));
        r.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: "stale-hash".into() });

        let session = reconcile(&DiffCache::default(), r).unwrap();

        let file = session.summary.files.iter().find(|f| f.path == "file.txt").unwrap();
        assert!(file.ignored);
        assert_eq!((file.additions, file.deletions), (0, 0));
        assert_eq!(session.review.comments[0].stale, false);
        assert_eq!(session.review.comments[0].anchor.as_ref().unwrap().start_line, Some(1));
        assert_eq!(session.review.viewed.len(), 1);
        assert_eq!(session.review.viewed[0].diff_hash, "stale-hash");
    }

    #[test]
    fn drops_viewed_when_file_absent_from_diff() {
        // repo_with_commit creates file.txt committed; no working-tree change means
        // the Uncommitted diff is empty → file.txt is absent from the diff.
        let (dir, _repo) = repo_with_commit();
        let mut r = empty_review(dir.path().to_str().unwrap());
        r.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: "anything".into() });
        let session = reconcile(&DiffCache::default(), r).unwrap();
        assert_eq!(session.review.viewed.len(), 0);
    }

    #[test]
    fn stamps_empty_diff_hash_and_keeps_viewed() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\n");
        let mut r = empty_review(dir.path().to_str().unwrap());
        // FE toggles viewed with empty hash (doesn't know the hash)
        r.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: "".into() });
        let session = reconcile(&DiffCache::default(), r).unwrap();
        // Entry must be kept and its hash must now be non-empty (stamped)
        assert_eq!(session.review.viewed.len(), 1);
        assert!(!session.review.viewed[0].diff_hash.is_empty());
    }

    #[test]
    fn keeps_viewed_when_diff_unchanged_drops_when_changed() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nCHANGED\n");
        // capture the current diff hash for file.txt by reconciling once
        let r = empty_review(dir.path().to_str().unwrap());
        let first = reconcile(&DiffCache::default(), r.clone()).unwrap();
        // mark viewed with the correct current hash
        let fd =
            crate::git::diff::get_file_diff(&first.review.target, "file.txt").unwrap();
        let h = crate::anchor::diff_hash(
            fd.old_content.as_deref().unwrap_or(""),
            fd.new_content.as_deref().unwrap_or(""),
        );
        let mut r = first.review;
        r.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: h });
        let kept = reconcile(&DiffCache::default(), r.clone()).unwrap();
        assert_eq!(kept.review.viewed.len(), 1);
        // now change the file -> viewed should drop
        write(dir.path(), "file.txt", "line1\nCHANGED-AGAIN\n");
        let dropped = reconcile(&DiffCache::default(), r).unwrap();
        assert_eq!(dropped.review.viewed.len(), 0);
    }

    #[test]
    fn stamp_viewed_baselines_reads_the_cached_snapshot_not_current_disk() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nAAA\nline2\n");
        let mut r = empty_review(dir.path().to_str().unwrap());
        let cache = DiffCache::default();

        // Prime the cache with the version the user is looking at (AAA) and record its hash.
        let seen = cache.file(&r.target, "file.txt").unwrap();
        let seen_hash = diff_hash(
            seen.old_content.as_deref().unwrap_or(""),
            seen.new_content.as_deref().unwrap_or(""),
        );

        // The FE marks the file viewed with an empty hash (it never computes the baseline).
        r.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: String::new() });

        // The working tree changes before the stamp runs, but the cache is NOT invalidated.
        // Stamping must hash the cached snapshot the user saw — not re-diff current disk. With
        // the old raw `get_file_diff` this would read BBB and produce a different hash.
        write(dir.path(), "file.txt", "line1\nBBB\nline2\n");

        stamp_viewed_baselines(&cache, &mut r);

        assert_eq!(
            r.viewed[0].diff_hash, seen_hash,
            "stamp must read the cached snapshot (a map read), not a fresh whole-repo diff of current disk",
        );
    }

    #[test]
    fn stamp_after_watcher_invalidate_still_hashes_what_the_user_saw() {
        // The agent-workflow race the served snapshot exists for: the agent edits
        // the file, the fs watcher invalidates the hot cache, but the UI keeps
        // showing the old diff until the user applies Refresh (#12). A viewed
        // toggle in that window must baseline the STILL-DISPLAYED content — a
        // stamp that rebuilds from disk absorbs the unseen edit, and the next
        // reconcile then keeps the file marked viewed across a diff the user
        // never reviewed.
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "file.txt", "line1\nAAA\nline2\n");
        let mut r = empty_review(dir.path().to_str().unwrap());
        let cache = DiffCache::default();

        // The diff pane fetched the file (AAA) — that is the version on screen.
        let seen = cache.file(&r.target, "file.txt").unwrap();
        let seen_hash = diff_hash(
            seen.old_content.as_deref().unwrap_or(""),
            seen.new_content.as_deref().unwrap_or(""),
        );

        // The edit lands and the watcher invalidates; the screen still shows AAA.
        write(dir.path(), "file.txt", "line1\nBBB\nline2\n");
        cache.invalidate(dir.path().to_str().unwrap());

        // The user toggles viewed against the still-displayed AAA diff.
        r.viewed.push(ViewedEntry { file: "file.txt".into(), diff_hash: String::new() });
        stamp_viewed_baselines(&cache, &mut r);

        assert_eq!(
            r.viewed[0].diff_hash, seen_hash,
            "the baseline must be the displayed (pre-invalidation) content, not the edit the user hasn't applied yet",
        );
    }
}
