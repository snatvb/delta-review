use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

#[cfg(unix)]
const LOGIN_FLAG_SHELLS: &[&str] = &["bash", "zsh", "fish", "nu", "ksh", "sh", "dash", "tcsh", "xonsh"];

pub fn resolve(preferred: Option<&str>) -> Result<PathBuf, String> {
    match preferred.map(str::trim).filter(|s| !s.is_empty()) {
        Some(name) => find_program(name).ok_or_else(|| {
            format!("Couldn't find the shell '{name}'. Set its full path in Settings → Terminal.")
        }),
        None => default_shell().ok_or_else(|| "Couldn't find a shell to start.".to_string()),
    }
}

pub fn command(shell: &Path, cwd: &Path) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    #[cfg(unix)]
    if wants_login_flag(shell) {
        cmd.arg("-l");
    }
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

#[cfg(unix)]
fn wants_login_flag(shell: &Path) -> bool {
    shell
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| LOGIN_FLAG_SHELLS.contains(&n))
}

#[cfg(windows)]
fn default_shell() -> Option<PathBuf> {
    find_program("pwsh")
        .or_else(|| find_program("powershell"))
        .or_else(|| std::env::var_os("COMSPEC").map(PathBuf::from))
}

#[cfg(unix)]
fn default_shell() -> Option<PathBuf> {
    let from_env = std::env::var_os("SHELL").map(PathBuf::from).filter(|p| p.is_file());
    let fallbacks = ["/bin/zsh", "/bin/bash", "/bin/sh"].map(PathBuf::from);
    from_env.or_else(|| fallbacks.into_iter().find(|p| p.is_file()))
}

fn find_program(name: &str) -> Option<PathBuf> {
    let direct = Path::new(name);
    if direct.components().count() > 1 || direct.is_absolute() {
        return direct.is_file().then(|| direct.to_path_buf());
    }
    search_dirs()
        .into_iter()
        .flat_map(|dir| candidate_names(name).into_iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

#[cfg(windows)]
fn candidate_names(name: &str) -> Vec<String> {
    if Path::new(name).extension().is_some() {
        vec![name.to_string()]
    } else {
        vec![format!("{name}.exe"), name.to_string()]
    }
}

#[cfg(unix)]
fn candidate_names(name: &str) -> Vec<String> {
    vec![name.to_string()]
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(gui_launch_extra_dirs());
    dirs
}

#[cfg(unix)]
fn gui_launch_extra_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/usr/local/bin"), PathBuf::from("/opt/homebrew/bin")];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join("bin"));
    }
    dirs
}

#[cfg(windows)]
fn gui_launch_extra_dirs() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_preference_falls_back_to_default_shell() {
        assert_eq!(resolve(Some("   ")).ok(), default_shell());
        assert!(resolve(None).is_ok());
    }

    #[test]
    fn absolute_path_is_used_as_is() {
        let dir = tempfile::tempdir().unwrap();
        let shell = dir.path().join("myshell");
        std::fs::write(&shell, "").unwrap();
        assert_eq!(resolve(Some(shell.to_str().unwrap())).unwrap(), shell);
    }

    #[test]
    fn missing_shell_names_itself_in_the_error() {
        let err = resolve(Some("definitely-not-a-shell-xyz")).unwrap_err();
        assert!(err.contains("definitely-not-a-shell-xyz"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn login_flag_only_for_known_shells() {
        assert!(wants_login_flag(Path::new("/opt/homebrew/bin/nu")));
        assert!(wants_login_flag(Path::new("/bin/zsh")));
        assert!(!wants_login_flag(Path::new("/usr/bin/python3")));
    }
}
