pub mod branches;
pub mod cache;
pub mod deltaignore;
pub mod diff;
pub mod log;
pub mod model;

use git2::{Oid, Repository, Tree};
use model::{DiffMode, Target};

pub type GitError = String;

pub enum RightSide {
    Tree(Oid),
    WorkTree,
}

pub struct Endpoints {
    pub from_tree: Option<Oid>,
    pub right: RightSide,
    pub base_label: String,
    pub head_label: String,
}

pub fn open_repo(repo_path: &str) -> Result<Repository, GitError> {
    Repository::discover(repo_path).map_err(|e| format!("open repo: {e}"))
}

fn tree_of<'r>(repo: &'r Repository, oid: Oid) -> Result<Tree<'r>, GitError> {
    repo.find_commit(oid)
        .and_then(|c| c.tree())
        .map_err(|e| format!("tree: {e}"))
}

/// The repo's canonical default branch as (label, commit): the branch
/// `refs/remotes/origin/HEAD` points at (label resolved through the symref, so
/// it shows as the real branch name like "main", never "HEAD"), else local
/// `main`, else `master`.
pub fn default_branch(repo: &Repository) -> Option<(String, Oid)> {
    if let Ok(sym) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = sym.symbolic_target() {
            if let Ok((_, oid)) = peel_branch_ref(repo, target) {
                // "refs/remotes/origin/main" → "main"
                let label = target
                    .rsplit_once('/')
                    .map_or_else(|| target.to_string(), |(_, tail)| tail.to_string());
                return Some((label, oid));
            }
        }
    }
    ["main", "master"]
        .iter()
        .find_map(|name| peel_branch_ref(repo, name).ok())
}

/// Peel a branch-ish ref name to (label, commit).
fn peel_branch_ref(repo: &Repository, name: &str) -> Result<(String, Oid), GitError> {
    let obj = repo
        .revparse_single(name)
        .map_err(|e| format!("{name}: {e}"))?;
    let commit = obj.peel_to_commit().map_err(|e| format!("{name}: {e}"))?;
    Ok((name.to_string(), commit.id()))
}

/// Resolve the base branch to (label, commit oid).
///
/// Cascade: an explicit `base` wins; without one, the fork-point suggestion
/// (the branch HEAD was cut from — see `branches::suggest_base`); failing that,
/// the repo's default branch (`default_branch`).
pub fn resolve_base(repo: &Repository, base: Option<&str>) -> Result<(String, Oid), GitError> {
    if let Some(b) = base {
        let obj = repo
            .revparse_single(b)
            .map_err(|_| format!("base branch '{b}' not found"))?;
        let commit = obj
            .peel_to_commit()
            .map_err(|_| format!("base '{b}' does not point at a commit"))?;
        return Ok((b.to_string(), commit.id()));
    }
    if let Some(s) = branches::suggest_base(repo) {
        if let Ok((label, oid)) = peel_branch_ref(repo, &s.name) {
            return Ok((label, oid));
        }
    }
    default_branch(repo).ok_or_else(|| {
        "could not resolve a base branch (fork point, origin/HEAD, main, master)".into()
    })
}

pub fn resolve_endpoints(repo: &Repository, target: &Target) -> Result<Endpoints, GitError> {
    let head_ref = repo.head().map_err(|e| format!("head: {e}"))?;
    let head_commit = head_ref
        .peel_to_commit()
        .map_err(|e| format!("head commit: {e}"))?;
    let head_label = head_ref
        .shorthand()
        .map(|s| s.to_string())
        .unwrap_or_else(|| short_oid(head_commit.id()));

    match target.mode {
        DiffMode::Uncommitted => Ok(Endpoints {
            from_tree: Some(tree_of(repo, head_commit.id())?.id()),
            right: RightSide::WorkTree,
            base_label: head_label.clone(),
            head_label: "working tree".into(),
        }),
        DiffMode::LastCommit => {
            let parent = head_commit
                .parent(0)
                .map_err(|_| "last-commit: HEAD has no parent".to_string())?;
            Ok(Endpoints {
                from_tree: Some(tree_of(repo, parent.id())?.id()),
                right: RightSide::Tree(tree_of(repo, head_commit.id())?.id()),
                base_label: short_oid(parent.id()),
                head_label: short_oid(head_commit.id()),
            })
        }
        DiffMode::Commit => {
            let oid = target
                .commit
                .as_deref()
                .ok_or_else(|| "commit mode requires a commit oid".to_string())?;
            let commit = repo
                .revparse_single(oid)
                .and_then(|o| o.peel_to_commit())
                .map_err(|e| format!("commit {oid}: {e}"))?;
            // Isolated diff: parent(0) → commit. Root commit → empty left tree.
            let from_tree = match commit.parent(0) {
                Ok(parent) => Some(tree_of(repo, parent.id())?.id()),
                Err(_) => None,
            };
            Ok(Endpoints {
                from_tree,
                right: RightSide::Tree(tree_of(repo, commit.id())?.id()),
                base_label: commit
                    .parent(0)
                    .map(|p| short_oid(p.id()))
                    .unwrap_or_else(|_| "∅".into()),
                head_label: short_oid(commit.id()),
            })
        }
        DiffMode::AllChanges | DiffMode::BranchVsBase => {
            let (base_label, base_oid) = resolve_base(repo, target.base.as_deref())?;
            let mb = repo
                .merge_base(head_commit.id(), base_oid)
                .map_err(|e| format!("merge-base: {e}"))?;
            let from_tree = Some(tree_of(repo, mb)?.id());
            let right = match target.mode {
                DiffMode::AllChanges => RightSide::WorkTree,
                _ => RightSide::Tree(tree_of(repo, head_commit.id())?.id()),
            };
            Ok(Endpoints {
                from_tree,
                right,
                base_label,
                head_label,
            })
        }
    }
}

pub fn resolve_worktree(repo: &Repository) -> Result<String, GitError> {
    let head = repo.head().map_err(|e| format!("head: {e}"))?;
    if head.is_branch() {
        if let Some(name) = head.shorthand() {
            return Ok(name.to_string());
        }
    }
    let oid = head
        .peel_to_commit()
        .map_err(|e| format!("head commit: {e}"))?
        .id();
    Ok(short_oid(oid))
}

/// The shared `.git` directory for a repo and all its linked worktrees.
/// git2 0.19 has no `commondir()`, so derive it from `path()`:
/// main worktree → `<root>/.git`; linked worktree → `<root>/.git/worktrees/<name>`
/// (strip at the `worktrees` segment). Canonicalized so both forms match.
pub fn common_git_dir(repo: &git2::Repository) -> std::path::PathBuf {
    let p = repo.path();
    let base = match p
        .iter()
        .position(|c| c == std::ffi::OsStr::new("worktrees"))
    {
        Some(pos) => p.iter().take(pos).collect::<std::path::PathBuf>(),
        None => p.to_path_buf(),
    };
    std::fs::canonicalize(&base).unwrap_or(base)
}

/// The main worktree directory = parent of the shared `.git` dir. Same for every
/// linked worktree of the repo, so it yields the canonical repo name.
pub fn main_worktree_dir(repo: &git2::Repository) -> Option<std::path::PathBuf> {
    common_git_dir(repo).parent().map(|p| p.to_path_buf())
}

fn short_oid(oid: Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    /// A repo with one commit on `main` adding `file.txt` = "line1\nline2\n".
    pub fn repo_with_commit() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // ensure branch is named main
        repo.set_head("refs/heads/main").ok();
        write(dir.path(), "file.txt", "line1\nline2\n");
        commit_all(&repo, "initial");
        (dir, repo)
    }

    /// A fork chain: main@1 → dev@2 (one commit ahead) → feature@3 cut from dev's
    /// tip, HEAD on feature. The fork-point heuristic should suggest `dev`.
    pub fn forked_repo() -> (TempDir, Repository) {
        let (dir, repo) = repo_with_commit();
        {
            let initial = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("dev", &initial, false).unwrap();
        }
        repo.set_head("refs/heads/dev").unwrap();
        write(dir.path(), "dev.txt", "d\n");
        let dev_tip = commit_all(&repo, "dev work");
        {
            let dev_commit = repo.find_commit(dev_tip).unwrap();
            repo.branch("feature", &dev_commit, false).unwrap();
        }
        repo.set_head("refs/heads/feature").unwrap();
        write(dir.path(), "feat.txt", "f\n");
        commit_all(&repo, "feat work");
        (dir, repo)
    }

    pub fn write(root: &Path, rel: &str, content: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    pub fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    /// Add a linked worktree checked out on a new branch `branch`, at a sibling dir.
    /// Returns the worktree's path.
    pub fn add_worktree(
        repo: &Repository,
        root: &Path,
        name: &str,
        branch: &str,
    ) -> std::path::PathBuf {
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch(branch, &head, false).unwrap();
        // Unique sibling path (keyed by the TempDir's random name) so parallel
        // tests and re-runs don't collide on a fixed path.
        let unique = format!("{}--{name}", root.file_name().unwrap().to_string_lossy());
        let wt_path = root.parent().unwrap().join(unique);
        let reference = repo
            .find_reference(&format!("refs/heads/{branch}"))
            .unwrap();
        let mut opts = git2::WorktreeAddOptions::new();
        opts.reference(Some(&reference));
        repo.worktree(name, &wt_path, Some(&opts)).unwrap();
        wt_path
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn mode_serializes_kebab_case() {
        let json = serde_json::to_string(&DiffMode::AllChanges).unwrap();
        assert_eq!(json, "\"all-changes\"");
    }

    #[test]
    fn resolve_base_finds_main() {
        let (_dir, repo) = repo_with_commit();
        let (label, _oid) = resolve_base(&repo, None).unwrap();
        assert_eq!(label, "main");
    }

    #[test]
    fn resolve_base_cascade_explicit_then_fork_then_default() {
        let (_dir, repo) = forked_repo(); // feature ← dev ← main
                                          // Explicit beats everything.
        let (label, _oid) = resolve_base(&repo, Some("main")).unwrap();
        assert_eq!(label, "main");
        // No explicit base → the fork-point suggestion (dev), not the default (main).
        let (label, oid) = resolve_base(&repo, None).unwrap();
        assert_eq!(label, "dev");
        // And the oid is dev's tip, not the merge-base — resolve_base returns the
        // branch ref; endpoints compute the merge-base separately.
        let dev_tip = repo
            .find_reference("refs/heads/dev")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id();
        assert_eq!(oid, dev_tip);
    }

    #[test]
    fn resolve_worktree_returns_branch_name() {
        let (_dir, repo) = repo_with_commit();
        assert_eq!(resolve_worktree(&repo).unwrap(), "main");
    }

    #[test]
    fn commit_mode_diffs_parent_to_commit() {
        use crate::git::diff::compute_diff;
        let (dir, repo) = repo_with_commit(); // main: file.txt = "line1\nline2\n"
        write(dir.path(), "file.txt", "line1\nADDED\nline2\n");
        let oid = commit_all(&repo, "second");
        let summary = compute_diff(&Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Commit,
            base: None,
            commit: Some(oid.to_string()),
        })
        .unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].path, "file.txt");
        assert_eq!(summary.files[0].additions, 1);
    }

    #[test]
    fn commit_mode_root_commit_is_all_additions() {
        use crate::git::diff::{compute_diff, FileStatus};
        let (dir, repo) = repo_with_commit(); // the initial commit IS the root
        let root = repo.head().unwrap().peel_to_commit().unwrap().id();
        let summary = compute_diff(&Target {
            repo_path: dir.path().to_str().unwrap().into(),
            worktree: None,
            mode: DiffMode::Commit,
            base: None,
            commit: Some(root.to_string()),
        })
        .unwrap();
        let f = summary.files.iter().find(|f| f.path == "file.txt").unwrap();
        assert_eq!(f.status, FileStatus::Added);
    }
}
