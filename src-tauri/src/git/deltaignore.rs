use git2::Repository;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::path::Path;

pub const DELTAIGNORE_FILE: &str = ".deltaignore";

pub struct DeltaIgnore(Gitignore);

impl DeltaIgnore {
    pub fn load(root: &Path) -> Self {
        let mut builder = GitignoreBuilder::new(root);
        let _ = builder.add(root.join(DELTAIGNORE_FILE));
        Self(builder.build().unwrap_or_else(|_| Gitignore::empty()))
    }

    pub fn for_repo(repo: &Repository) -> Self {
        match repo.workdir() {
            Some(root) => Self::load(root),
            None => Self(Gitignore::empty()),
        }
    }

    pub fn is_ignored(&self, rel_path: &str) -> bool {
        self.0.matched_path_or_any_parents(rel_path, false).is_ignore()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_rules(rules: &str) -> (tempfile::TempDir, DeltaIgnore) {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(dir.path().join(DELTAIGNORE_FILE), rules).unwrap();
        let ignore = DeltaIgnore::load(dir.path());
        (dir, ignore)
    }

    #[test]
    fn matches_gitignore_patterns() {
        let (_dir, ig) = with_rules("generated/\n*.gen.ts\n/root-only.txt\n");
        assert!(ig.is_ignored("generated/api.ts"));
        assert!(ig.is_ignored("pkg/generated/deep/file.xml"));
        assert!(ig.is_ignored("src/client.gen.ts"));
        assert!(ig.is_ignored("root-only.txt"));
        assert!(!ig.is_ignored("src/root-only.txt"));
        assert!(!ig.is_ignored("src/client.ts"));
    }

    #[test]
    fn negation_re_includes_a_path() {
        let (_dir, ig) = with_rules("generated/**\n!generated/keep.ts\n");
        assert!(ig.is_ignored("generated/drop.ts"));
        assert!(!ig.is_ignored("generated/keep.ts"));
    }

    #[test]
    fn missing_file_ignores_nothing() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(!DeltaIgnore::load(dir.path()).is_ignored("anything.ts"));
    }
}
