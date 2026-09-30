// Single source of truth for what a VCS can do. UI code asks the profile instead
// of scattering `vcs === "svn"` checks, so adding a backend never means hunting
// down conditionals across components. (#vcs)
import type { DiffMode, VcsKind } from "./types";

export interface VcsProfile {
  vcs: VcsKind;
  /** Modes the mode-switcher offers (drives the dropdown AND its width-reserving hidden labels). */
  modes: { id: DiffMode; label: string }[];
  /** Whether commit history features exist (stepper, commit picker, commit mode, pagination, [ / ] keys). */
  history: boolean;
}

// Git keeps every mode and every history feature; SVN is working-copy-only.
const PROFILES: Record<VcsKind, VcsProfile> = {
  git: {
    vcs: "git",
    modes: [
      { id: "all-changes", label: "All changes" },
      { id: "uncommitted", label: "Uncommitted" },
      { id: "last-commit", label: "Last commit" },
      { id: "branch-vs-base", label: "Branch vs base" },
    ],
    history: true,
  },
  svn: {
    vcs: "svn",
    modes: [{ id: "uncommitted", label: "Uncommitted" }],
    history: false,
  },
};

export function vcsProfile(vcs: VcsKind): VcsProfile {
  return PROFILES[vcs];
}
