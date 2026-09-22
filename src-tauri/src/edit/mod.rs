use crate::git::diff::looks_binary;
use crate::git::model::{DiffMode, Target};
use crate::git::open_repo;
use std::fs;
use std::path::{Path, PathBuf};

pub fn edit_file_line(
    target: &Target,
    path: &str,
    line: u32,
    expected: &str,
    replacement: &str,
) -> Result<(), String> {
    if !matches!(target.mode, DiffMode::AllChanges | DiffMode::Uncommitted) {
        return Err("editing requires a working-tree diff (All changes or Uncommitted)".into());
    }
    let repo = open_repo(&target.repo_path)?;
    let workdir = repo.workdir().ok_or("repository has no working directory")?;
    let resolved = resolve_in_workdir(workdir, path)?;
    replace_line_on_disk(&resolved, line, expected, replacement)
}

fn resolve_in_workdir(workdir: &Path, rel: &str) -> Result<PathBuf, String> {
    let root = workdir
        .canonicalize()
        .map_err(|e| format!("resolve worktree root: {e}"))?;
    let resolved = workdir
        .join(rel)
        .canonicalize()
        .map_err(|_| format!("{rel}: not found"))?;
    if !resolved.starts_with(&root) {
        return Err(format!("{rel}: escapes the repository root"));
    }
    Ok(resolved)
}

fn replace_line_on_disk(file: &Path, line: u32, expected: &str, replacement: &str) -> Result<(), String> {
    if line == 0 {
        return Err("line numbers are 1-based".into());
    }
    if replacement.contains('\n') || replacement.contains('\r') {
        return Err("a line edit can't introduce a line break".into());
    }
    let bytes = fs::read(file).map_err(|e| format!("read {}: {e}", file.display()))?;
    if looks_binary(&bytes) {
        return Err("binary file — editing isn't supported".into());
    }
    let content = String::from_utf8(bytes).map_err(|_| "file isn't valid UTF-8".to_string())?;

    let mut segments: Vec<&str> = content.split_inclusive('\n').collect();
    let index = (line - 1) as usize;
    let segment = *segments
        .get(index)
        .ok_or_else(|| format!("line {line} is out of range"))?;

    let (current, terminator) = if let Some(stripped) = segment.strip_suffix("\r\n") {
        (stripped, "\r\n")
    } else if let Some(stripped) = segment.strip_suffix('\n') {
        (stripped, "\n")
    } else {
        (segment, "")
    };
    if current != expected {
        return Err("file changed on disk — refusing to overwrite".into());
    }

    let replaced = format!("{replacement}{terminator}");
    segments[index] = replaced.as_str();
    fs::write(file, segments.concat()).map_err(|e| format!("write {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::*;

    fn target(repo_path: &str, mode: DiffMode) -> Target {
        Target { repo_path: repo_path.into(), worktree: None, mode, base: None, commit: None }
    }

    #[test]
    fn plain_lf_replace() {
        let (dir, _repo) = repo_with_commit();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        edit_file_line(&t, "file.txt", 1, "line1", "LINE1").unwrap();

        let content = fs::read_to_string(dir.path().join("file.txt")).unwrap();
        assert_eq!(content, "LINE1\nline2\n");
    }

    #[test]
    fn crlf_file_keeps_crlf() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "crlf.txt", "a\r\nb\r\nc\r\n");
        let t = target(dir.path().to_str().unwrap(), DiffMode::AllChanges);

        edit_file_line(&t, "crlf.txt", 2, "b", "BEE").unwrap();

        let content = fs::read_to_string(dir.path().join("crlf.txt")).unwrap();
        assert_eq!(content, "a\r\nBEE\r\nc\r\n");
    }

    #[test]
    fn file_without_trailing_newline_stays_without_one() {
        let (dir, _repo) = repo_with_commit();
        write(dir.path(), "notail.txt", "line1\nline2");
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        edit_file_line(&t, "notail.txt", 2, "line2", "LINE2").unwrap();

        let content = fs::read_to_string(dir.path().join("notail.txt")).unwrap();
        assert_eq!(content, "line1\nLINE2");
    }

    #[test]
    fn expected_mismatch_errs_and_leaves_file_untouched() {
        let (dir, _repo) = repo_with_commit();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let err = edit_file_line(&t, "file.txt", 1, "not the real line", "X").unwrap_err();
        assert!(err.contains("changed on disk"), "unexpected error: {err}");

        let content = fs::read_to_string(dir.path().join("file.txt")).unwrap();
        assert_eq!(content, "line1\nline2\n");
    }

    #[test]
    fn replacement_with_a_line_break_errs() {
        let (dir, _repo) = repo_with_commit();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let err = edit_file_line(&t, "file.txt", 1, "line1", "one\ntwo").unwrap_err();
        assert!(err.contains("line break"), "unexpected error: {err}");

        let content = fs::read_to_string(dir.path().join("file.txt")).unwrap();
        assert_eq!(content, "line1\nline2\n");
    }

    #[test]
    fn line_out_of_range_errs() {
        let (dir, _repo) = repo_with_commit();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let err = edit_file_line(&t, "file.txt", 99, "line2", "X").unwrap_err();
        assert!(err.contains("out of range"), "unexpected error: {err}");
    }

    #[test]
    fn path_traversal_errs() {
        let (dir, _repo) = repo_with_commit();
        let unique = format!("{}--outside.txt", dir.path().file_name().unwrap().to_string_lossy());
        let outside = dir.path().parent().unwrap().join(&unique);
        fs::write(&outside, "secret\n").unwrap();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let err = edit_file_line(&t, &format!("../{unique}"), 1, "secret", "X").unwrap_err();
        assert!(err.contains("escapes"), "unexpected error: {err}");

        let content = fs::read_to_string(&outside).unwrap();
        assert_eq!(content, "secret\n");
        fs::remove_file(&outside).ok();
    }

    #[test]
    fn non_utf8_file_errs() {
        let (dir, _repo) = repo_with_commit();
        fs::write(dir.path().join("bad.txt"), [b'a', b'\n', 0xff, 0xfe, b'\n']).unwrap();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let err = edit_file_line(&t, "bad.txt", 2, "?", "X").unwrap_err();
        assert!(err.contains("UTF-8"), "unexpected error: {err}");
    }

    #[test]
    fn binary_file_errs() {
        let (dir, _repo) = repo_with_commit();
        fs::write(dir.path().join("logo.png"), [0x89u8, b'P', b'N', b'G', 0x00, 0x01, 0x02, 0x00]).unwrap();
        let t = target(dir.path().to_str().unwrap(), DiffMode::Uncommitted);

        let err = edit_file_line(&t, "logo.png", 1, "x", "X").unwrap_err();
        assert!(err.contains("binary"), "unexpected error: {err}");
    }

    #[test]
    fn non_working_tree_mode_is_rejected() {
        let (dir, _repo) = repo_with_commit();
        let t = target(dir.path().to_str().unwrap(), DiffMode::LastCommit);

        let err = edit_file_line(&t, "file.txt", 1, "line1", "X").unwrap_err();
        assert!(err.contains("working-tree"), "unexpected error: {err}");
    }
}
