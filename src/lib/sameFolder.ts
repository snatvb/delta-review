// Folder identity across path-form drift. The backend keeps every stored path
// in one canonical form, but the paths a window sees still arrive from
// different sources: the URL carries libgit2's workdir form (trailing
// separator, POSIX slashes on Windows), picker rows carry dunce-normalized
// native paths. Comparing them with === silently fails — the current review
// would reappear in its own ⌘K palette, a resumed review would mismatch. Fold
// the cosmetic differences instead; drive-letter paths are case-folded (NTFS
// is case-insensitive).
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-z]:/i.test(s)) s = s.toLowerCase();
    return s;
  };
  return norm(a) === norm(b);
}
