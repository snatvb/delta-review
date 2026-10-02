//! Branch enumeration + the fork-point suggestion ("where was HEAD cut from?").
//!
//! `suggest_base` picks the branch whose merge-base with HEAD is the closest
//! ancestor of HEAD — the branch this one was actually cut from. It feeds both
//! the base picker's "auto" strategy and `resolve_base`'s implicit path.

use super::{default_branch, open_repo, GitError};
use git2::{BranchType, Oid, Repository, Sort};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

/// rev-list counts stop here, so a huge divergence shows as "999+" instead of
/// walking a decade of history per branch on every dropdown open.
const COUNT_CAP: usize = 999;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedBase {
    pub name: String,
    pub merge_base_short_oid: String,
    /// Commit time of the fork point (unix seconds).
    pub merge_base_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Display ref: "dev" for local, "origin/dev" for remote.
    pub name: String,
    pub remote: bool,
    pub is_current: bool,
    pub is_default: bool,
    pub short_oid: String,
    pub last_commit_at: Option<i64>,
    pub last_subject: Option<String>,
    /// Commits HEAD has that this branch doesn't — "your work" against this base.
    pub ahead: u32,
    /// Commits this branch has that HEAD doesn't — the base moved on.
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub branches: Vec<BranchInfo>,
    pub suggested: Option<SuggestedBase>,
}

struct Candidate {
    name: String,
    remote: bool,
    merge_base: Oid,
    merge_base_time: i64,
}

impl Candidate {
    fn rank(&self, default_label: Option<&str>) -> (bool, bool, &str) {
        (
            Some(self.name.as_str()) == default_label,
            !self.remote,
            &self.name,
        )
    }
}

/// True when `a` is a better fork-point guess than `b`.
fn candidate_better(
    repo: &Repository,
    a: &Candidate,
    b: &Candidate,
    default_label: Option<&str>,
) -> bool {
    if a.merge_base_time != b.merge_base_time {
        return a.merge_base_time > b.merge_base_time;
    }
    // Same timestamp (same-second commits, clock skew): the fork point closer to
    // HEAD — the descendant — is where the cut actually happened.
    if a.merge_base != b.merge_base {
        if repo
            .graph_descendant_of(a.merge_base, b.merge_base)
            .unwrap_or(false)
        {
            return true;
        }
        if repo
            .graph_descendant_of(b.merge_base, a.merge_base)
            .unwrap_or(false)
        {
            return false;
        }
    }
    // Unrelated forks tie: prefer the default branch, then local, then name.
    a.rank(default_label) > b.rank(default_label)
}

/// Fork-point scan result memo, keyed by the worktree's own git dir.
type SuggestionCache = std::collections::HashMap<PathBuf, (Oid, Option<SuggestedBase>)>;

/// Suggests nothing while HEAD *is* the repo's default branch (nothing was "cut";
/// comparing main-to-itself falls back to the default-branch chain) or when no
/// candidate has a meaningful fork point.
pub fn suggest_base(repo: &Repository) -> Option<SuggestedBase> {
    let head_ref = repo.head().ok()?;
    let head = head_ref.peel_to_commit().ok()?;
    let current = head_ref.shorthand().map(str::to_string);
    let (default_label, _oid) = default_branch(repo)?;
    if current.as_deref() == Some(default_label.as_str()) {
        return None;
    }

    // Fork-point scan per HEAD, memoized: list_commits pages through this on
    // every scroll, and the scan is one merge-base per branch. Keyed by the
    // worktree's own git dir (worktrees share a commondir but have distinct
    // HEADs). A base branch moving without HEAD moving (a fetch) is rare and
    // self-corrects on the next HEAD change.
    static CACHE: LazyLock<Mutex<SuggestionCache>> = LazyLock::new(Default::default);
    let cache_key = repo.path().to_path_buf();
    {
        let cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_head, cached)) = cache.get(&cache_key) {
            if *cached_head == head.id() {
                return cached.clone();
            }
        }
    }

    let mut best: Option<Candidate> = None;
    for candidate in fork_candidates(repo, head.id(), current.as_deref()) {
        match &best {
            Some(b) if !candidate_better(repo, &candidate, b, Some(&default_label)) => {}
            _ => best = Some(candidate),
        }
    }
    let suggested = best.map(|c| SuggestedBase {
        name: c.name,
        merge_base_short_oid: super::short_oid(c.merge_base),
        merge_base_at: c.merge_base_time,
    });
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.insert(cache_key, (head.id(), suggested.clone()));
    suggested
}

/// Every branch that could be HEAD's fork parent, with its merge-base into HEAD.
/// Skips the current branch itself, HEAD-symref aliases (`origin/HEAD`), and
/// branches that already contain HEAD entirely (merge-base == HEAD → empty diff).
fn fork_candidates(repo: &Repository, head_oid: Oid, current: Option<&str>) -> Vec<Candidate> {
    let branches = repo
        .branches(None)
        .map(|iter| iter.filter_map(|r| r.ok()).collect::<Vec<_>>())
        .unwrap_or_default();
    branches
        .into_iter()
        .filter_map(|(branch, bt)| {
            let name = branch.name().ok().flatten()?.to_string();
            if name == "HEAD" || name.ends_with("/HEAD") {
                return None; // symref aliases, not real branches
            }
            let remote = bt == BranchType::Remote;
            if !remote && current == Some(name.as_str()) {
                return None;
            }
            let tip = branch.get().peel_to_commit().ok()?.id();
            // The pushed twin of the current branch: mb == HEAD → nothing to review.
            let merge_base = repo.merge_base(head_oid, tip).ok()?;
            if merge_base == head_oid {
                return None;
            }
            let merge_base_time = repo.find_commit(merge_base).ok()?.time().seconds();
            Some(Candidate {
                name,
                remote,
                merge_base,
                merge_base_time,
            })
        })
        .collect()
}

/// All branches with picker metadata, newest activity first, plus the fork-point
/// suggestion for HEAD.
pub fn list_branches(repo_path: &str) -> Result<BranchList, GitError> {
    let repo = open_repo(repo_path)?;
    let head_ref = repo.head().map_err(|e| format!("head: {e}"))?;
    let head_oid = head_ref
        .peel_to_commit()
        .map_err(|e| format!("head commit: {e}"))?
        .id();
    let current = head_ref.shorthand().map(str::to_string);
    let default_label = default_branch(&repo).map(|(l, _)| l);

    let mut branches: Vec<BranchInfo> = Vec::new();
    for entry in repo.branches(None).map_err(|e| format!("branches: {e}"))? {
        let Ok((branch, bt)) = entry else { continue };
        let Some(name) = branch.name().ok().flatten() else {
            continue;
        };
        let name = name.to_string();
        if name == "HEAD" || name.ends_with("/HEAD") {
            continue;
        }
        let remote = bt == BranchType::Remote;
        let Ok(tip) = branch.get().peel_to_commit() else {
            continue;
        };
        let ahead = count_between(&repo, head_oid, tip.id());
        let behind = count_between(&repo, tip.id(), head_oid);
        // Default-branch matching works across a remote prefix: the label is
        // "dev" while a remote branch is named "origin/dev".
        let short = name
            .rsplit_once('/')
            .map_or(name.as_str(), |(_, tail)| tail);
        branches.push(BranchInfo {
            is_current: !remote && current.as_deref() == Some(name.as_str()),
            is_default: default_label.as_deref() == Some(name.as_str())
                || (remote && default_label.as_deref() == Some(short)),
            name,
            remote,
            short_oid: super::short_oid(tip.id()),
            last_commit_at: Some(tip.time().seconds()),
            last_subject: tip.summary().map(str::to_string),
            ahead,
            behind,
        });
    }
    branches.sort_by(|a, b| {
        b.last_commit_at
            .cmp(&a.last_commit_at)
            .then_with(|| a.name.cmp(&b.name))
    });

    let suggested = suggest_base(&repo);
    Ok(BranchList {
        branches,
        suggested,
    })
}

/// `git rev-list --count from ^not_in`, capped.
fn count_between(repo: &Repository, from: Oid, not_in: Oid) -> u32 {
    let Ok(mut walk) = repo.revwalk() else {
        return 0;
    };
    if walk.set_sorting(Sort::TIME).is_err()
        || walk.push(from).is_err()
        || walk.hide(not_in).is_err()
    {
        return 0;
    }
    walk.take(COUNT_CAP).filter_map(|o| o.ok()).count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    #[test]
    fn suggest_base_picks_the_closest_fork() {
        let (_dir, repo) = forked_repo(); // feature ← dev ← main
                                          // Same-second commits everywhere: the descendant tie-break must still
                                          // pick dev (cut at its tip), not main (cut at the root).
        let s = suggest_base(&repo).unwrap();
        assert_eq!(s.name, "dev");
    }

    #[test]
    fn list_branches_marks_current_default_and_suggests() {
        let (_dir, repo) = forked_repo();
        let root = repo.workdir().unwrap().to_str().unwrap().to_string();
        drop(repo);
        let list = list_branches(&root).unwrap();
        assert_eq!(
            list.suggested.as_ref().map(|s| s.name.as_str()),
            Some("dev")
        );

        let by_name = |n: &str| list.branches.iter().find(|b| b.name == n).unwrap();
        let feature = by_name("feature");
        assert!(feature.is_current && !feature.is_default);
        assert_eq!(
            (feature.ahead, feature.behind),
            (0, 0),
            "the current branch differs from itself by nothing"
        );
        let dev = by_name("dev");
        assert_eq!(dev.ahead, 1, "HEAD (feature) has one commit dev doesn't");
        let main = by_name("main");
        assert!(main.is_default && !main.is_current);
        assert_eq!(
            (main.ahead, main.behind),
            (2, 0),
            "HEAD is 2 commits ahead of main (dev + feat work)"
        );
    }

    #[test]
    fn suggest_base_none_when_head_is_default_branch() {
        let (_dir, repo) = repo_with_commit(); // on main, main is the default
        assert!(suggest_base(&repo).is_none());
    }

    #[test]
    fn default_branch_resolves_origin_head_symref_to_real_name() {
        let (_dir, repo) = repo_with_commit();
        let tip = repo.head().unwrap().peel_to_commit().unwrap();
        repo.reference("refs/remotes/origin/dev", tip.id(), false, "test")
            .unwrap();
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/dev",
            false,
            "test",
        )
        .unwrap();
        let (label, oid) = default_branch(&repo).unwrap();
        assert_eq!(label, "dev");
        assert_eq!(oid, tip.id());
    }
}
