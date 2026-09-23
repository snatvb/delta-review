use crate::git::model::Target;
use crate::git::{open_repo, resolve_base, GitError};
use git2::{Oid, Repository, Sort};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMeta {
    pub oid: String,
    pub short_oid: String,
    pub subject: String,
    pub author: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPage {
    pub commits: Vec<CommitMeta>,
    pub has_more: bool,
}

/// Oids on `merge-base(base, HEAD)..HEAD`, newest first, walked lazily so a caller
/// that needs one page never materializes a long branch's whole history.
fn with_branch_walk<T>(
    target: &Target,
    f: impl FnOnce(&Repository, &mut dyn Iterator<Item = Result<Oid, GitError>>) -> Result<T, GitError>,
) -> Result<T, GitError> {
    let repo = open_repo(&target.repo_path)?;
    let head = repo.head().map_err(|e| format!("head: {e}"))?;
    let head_oid = head
        .peel_to_commit()
        .map_err(|e| format!("head commit: {e}"))?
        .id();
    let (_label, base_oid) = resolve_base(&repo, target.base.as_deref())?;
    let mb = repo
        .merge_base(head_oid, base_oid)
        .map_err(|e| format!("merge-base: {e}"))?;

    let mut walk = repo.revwalk().map_err(|e| format!("revwalk: {e}"))?;
    walk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;
    walk.push(head_oid).map_err(|e| e.to_string())?;
    // Always hide the merge-base: it excludes the base and its ancestors. When the
    // base resolves to HEAD's own branch (mb == HEAD) this correctly yields empty.
    walk.hide(mb).map_err(|e| e.to_string())?;

    let mut oids = walk.map(|oid| oid.map_err(|e| e.to_string()));
    f(&repo, &mut oids)
}

/// One page of the branch's commits, newest first.
pub fn list_commits(target: &Target, skip: usize, limit: usize) -> Result<CommitPage, GitError> {
    with_branch_walk(target, |repo, oids| {
        let mut commits = Vec::with_capacity(limit);
        let mut has_more = false;
        for oid in oids.skip(skip) {
            let oid = oid?;
            if commits.len() == limit {
                has_more = true;
                break;
            }
            let c = repo.find_commit(oid).map_err(|e| e.to_string())?;
            commits.push(CommitMeta {
                oid: oid.to_string(),
                short_oid: oid.to_string().chars().take(7).collect(),
                subject: c.summary().unwrap_or("").to_string(),
                author: c.author().name().unwrap_or("").to_string(),
                time: c.time().seconds(),
            });
        }
        Ok(CommitPage { commits, has_more })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::model::DiffMode;
    use crate::git::test_support::*;

    fn target(repo_path: &str) -> Target {
        Target { repo_path: repo_path.into(), worktree: None, mode: DiffMode::Commit, base: None, commit: None }
    }

    #[test]
    fn lists_branch_commits_newest_first_excluding_base() {
        let (dir, repo) = repo_with_commit(); // main @ "initial"
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.branch("feature", &repo.find_commit(base).unwrap(), false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        write(dir.path(), "a.txt", "1\n");
        let c1 = commit_all(&repo, "first on feature");
        write(dir.path(), "b.txt", "2\n");
        let c2 = commit_all(&repo, "second on feature");

        let page = list_commits(&target(dir.path().to_str().unwrap()), 0, 10).unwrap();
        let oids: Vec<String> = page.commits.iter().map(|c| c.oid.clone()).collect();
        assert_eq!(oids, vec![c2.to_string(), c1.to_string()]); // newest first
        assert_eq!(page.commits[0].subject, "second on feature");
        assert!(!page.has_more);
    }

    #[test]
    fn pages_through_branch_commits() {
        use std::collections::HashSet;
        let (dir, repo) = repo_with_commit();
        let base = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.branch("feature", &repo.find_commit(base).unwrap(), false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        let mut made = Vec::new();
        for i in 0..5 {
            write(dir.path(), "a.txt", &format!("{i}
"));
            made.push(commit_all(&repo, &format!("c{i}")).to_string());
        }
        let t = target(dir.path().to_str().unwrap());

        // Same-second commits have no defined TIME order, so compare pages as sets.
        let pages: Vec<CommitPage> = [0, 2, 4].iter().map(|&skip| list_commits(&t, skip, 2).unwrap()).collect();
        assert_eq!(pages.iter().map(|p| p.commits.len()).collect::<Vec<_>>(), vec![2, 2, 1]);
        assert_eq!(pages.iter().map(|p| p.has_more).collect::<Vec<_>>(), vec![true, true, false]);
        let paged: HashSet<String> = pages.iter().flat_map(|p| p.commits.iter().map(|c| c.oid.clone())).collect();
        assert_eq!(paged, made.into_iter().collect::<HashSet<_>>());
    }

    #[test]
    fn empty_when_head_is_base() {
        let (dir, _repo) = repo_with_commit(); // on main, no commits ahead of base(main)
        let page = list_commits(&target(dir.path().to_str().unwrap()), 0, 10).unwrap();
        assert!(page.commits.is_empty());
    }
}
