use git2::Oid;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

static GIT_BINARY: LazyLock<Option<PathBuf>> = LazyLock::new(|| {
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let resolved = find_git(path_dirs.into_iter().chain(extra_probe_dirs()));
    match &resolved {
        Some(bin) => crate::applog::info("git-cli", &format!("git binary: {}", bin.display())),
        None => crate::applog::warn("git-cli", "git binary not found; diffs use the full libgit2 scan"),
    }
    resolved
});

fn git_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["git.exe"]
    } else {
        &["git"]
    }
}

fn extra_probe_dirs() -> Vec<PathBuf> {
    let dirs: &[&str] = if cfg!(windows) {
        &[r"C:\Program Files\Git\cmd", r"C:\Program Files (x86)\Git\cmd"]
    } else {
        &["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"]
    };
    dirs.iter().map(PathBuf::from).collect()
}

fn find_git(dirs: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    dirs.into_iter()
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|d| git_names().iter().map(move |n| d.join(n)))
        .find(|candidate| candidate.is_file() && runs_without_prompt(candidate))
}

// macOS ships /usr/bin/git as an Xcode shim that pops an install dialog when the
// command line tools are missing; only trust it once xcode-select reports them.
fn runs_without_prompt(candidate: &Path) -> bool {
    if !cfg!(target_os = "macos") || candidate != Path::new("/usr/bin/git") {
        return true;
    }
    Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .output()
        .is_ok_and(|out| out.status.success())
}

// libgit2 stats every tracked file (12 s on an 815k-file repo); git CLI uses threaded preload and fsmonitor (~3 s).
// Untracked stays in "normal" mode: "-uall" bypasses the untracked cache (1.5 s vs 4.6 s there); libgit2 expands the dirs.
pub fn changed_worktree_paths(workdir: &Path, from_tree: Oid) -> Option<Vec<String>> {
    let git = GIT_BINARY.as_deref()?;
    changed_worktree_paths_with(git, workdir, from_tree)
}

pub(crate) fn changed_worktree_paths_with(
    git: &Path,
    workdir: &Path,
    from_tree: Oid,
) -> Option<Vec<String>> {
    let tree = from_tree.to_string();
    let (tracked, untracked) = std::thread::scope(|scope| {
        let tracked = scope.spawn(|| {
            run(git, workdir, &["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", &tree, "--"])
        });
        let untracked = run(git, workdir, &["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames"]);
        (tracked.join().ok().flatten(), untracked)
    });
    let mut paths = split_nul(&tracked?)?;
    paths.extend(untracked_from_status(&untracked?)?);
    paths.sort_unstable();
    paths.dedup();
    Some(paths)
}

fn run(git: &Path, workdir: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut command = Command::new(git);
    command
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(workdir)
        .env("GIT_TERMINAL_PROMPT", "0");
    hide_console_window(&mut command);
    match command.output() {
        Ok(out) if out.status.success() => Some(out.stdout),
        Ok(out) => {
            crate::applog::warn(
                "git-cli",
                &format!(
                    "git {} failed in {}: {}",
                    args.first().unwrap_or(&""),
                    workdir.display(),
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
            );
            None
        }
        Err(e) => {
            crate::applog::warn("git-cli", &format!("spawn {} failed: {e}", git.display()));
            None
        }
    }
}

fn split_nul(bytes: &[u8]) -> Option<Vec<String>> {
    bytes
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8(s.to_vec()).ok())
        .collect()
}

fn untracked_from_status(bytes: &[u8]) -> Option<Vec<String>> {
    Some(
        split_nul(bytes)?
            .into_iter()
            .filter_map(|entry| entry.strip_prefix("?? ").map(str::to_owned))
            .collect(),
    )
}

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untracked_entries_are_picked_from_porcelain_output() {
        let out = b"?? new.txt\0 M file.txt\0?? dir/nested.rs\0D  gone.txt\0";
        assert_eq!(
            untracked_from_status(out).unwrap(),
            vec!["new.txt".to_string(), "dir/nested.rs".to_string()]
        );
    }

    #[test]
    fn non_utf8_output_is_rejected_so_the_caller_falls_back() {
        assert_eq!(split_nul(b"ok\0\xff\xfe\0"), None);
    }

    #[test]
    fn missing_binary_yields_none() {
        let dir = tempfile::TempDir::new().unwrap();
        let missing = dir.path().join("no-such-git");
        assert_eq!(changed_worktree_paths_with(&missing, dir.path(), Oid::zero()), None);
    }

    #[test]
    fn find_git_skips_dirs_without_the_binary() {
        let empty = tempfile::TempDir::new().unwrap();
        let hit = tempfile::TempDir::new().unwrap();
        std::fs::write(hit.path().join(git_names()[0]), b"").unwrap();
        assert_eq!(
            find_git(vec![empty.path().to_path_buf(), hit.path().to_path_buf()]),
            Some(hit.path().join(git_names()[0]))
        );
        assert_eq!(find_git(Vec::<PathBuf>::new()), None);
    }
}
