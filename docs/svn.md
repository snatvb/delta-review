# SVN support

Delta reviews SVN working copies alongside git ones. Git stays the priority;
SVN is a fallback for directories git cannot claim.

## What works (v1)

The **Uncommitted** view — local changes against `BASE` (the pristine
revision your working copy was last updated to). This is fully offline: the
change list comes from `svn status`, old file sides from the local pristine
store (`svn cat -r BASE`), new sides from disk. Comments, anchors, viewed
tracking, refresh-on-change, `.deltaignore` and the agent export all work on
SVN reviews exactly like on git ones.

Everything else — Last commit, Branch vs base, the commit stepper — is git
only. SVN history operations are server round-trips by design, and the v1
scope deliberately stays offline; the mode switcher hides those modes on SVN
reviews (see `src/vcsProfile.ts`).

## Detection

`vcs::Repo::open` walks ancestor directories, probing each level for `.git`
**before** `.svn`:

- a git-svn working copy (both `.git` and `.svn` present) opens as **git**;
- the **nearest** marker wins overall — an SVN checkout nested inside a git
  monorepo is still an SVN working copy;
- detection is pure filesystem metadata — no process spawn, no network. The
  `svn` CLI is only needed to compute a diff, so a missing CLI surfaces as a
  friendly install hint on the diff, not a failure to open.

### Manual override

Every repository entry in `registry.json` (app data dir) carries two fields:

```json
{
  "root": "/path/to/checkout",
  "vcs": "svn",
  "vcsOverride": "git"
}
```

`vcs` is the stamped detection result. `vcsOverride` forces the kind —
hand-edited, never exposed in the UI, and preserved across Delta's registry
rewrites. It only takes effect when the forced kind's marker actually exists
at the repo root (it chooses between two real repositories; it cannot conjure
one). Overrides load at app startup; edit → restart. The `dr` CLI gate only
asks "is this a repository at all", so it behaves correctly without them.

## Requirements

The `svn` command line client (1.8+) must be installed:

- macOS: `brew install subversion` (Apple removed svn from the CLI tools in 2020)
- Windows: the [VisualSVN command-line client](https://www.visualsvn.com/downloads/)
  or `choco install sliksvn` (TortoiseSVN's installer has an optional
  "command line client tools" checkbox too)

Delta does not bundle the CLI in v1. Its location is resolved once per app
launch: every `PATH` entry, then on macOS `/opt/homebrew/bin`,
`/usr/local/bin`, `/opt/local/bin` (MacPorts) and on Windows the
VisualSVN / TortoiseSVN / SlikSvn install folders — GUI apps inherit a
minimal `PATH` that omits all of them. On Windows the binary is looked up as
`svn.exe` (a bare `svn` wrapper counts anywhere).

### Diagnostics

Every CLI resolution and invocation is logged to `svn-debug.log` in the app
data dir (bounded at 2 MB):

- Windows: `%APPDATA%\com.snatvb.delta-review\svn-debug.log`
- macOS: `~/Library/Application Support/com.snatvb.delta-review/svn-debug.log`

If the "not found" error appears while `svn` works in your terminal, that log
records the exact `PATH` and locations the app searched.

## Delta Ignore

All three layers apply to SVN. The local layer (Settings → Ignore → This
repository) can't live in git's `info/deltaignore` slot, and `.svn` belongs
to svn, so it is stored in the app data dir under `svn-local-deltaignore/`,
one file per working-copy root. Nothing is written into the working copy.

## Status refresh

A whole-copy `svn status` walks every versioned file and can take seconds on
a large checkout, so Delta avoids repeating it (`src-tauri/src/vcs/svn/status.rs`):

- **Watched edits are targeted.** While a review window watches the copy,
  every changed path (and its parent directories, so a new unversioned
  folder is noticed) is queued; the next refresh runs
  `svn status --depth empty` on just those paths and merges the answer into
  the last full result. `svn:ignore` matches come back as ignored and drop
  out, so build output and logs cost one tiny status call and never offer
  Refresh.
- **A full status runs** when `.svn/wc.db` moves (update, commit, revert,
  add), when the watcher stopped, overflowed or queued more than 2000 paths,
  or when a targeted call fails.
- **Slow copies open instantly.** The last full result is saved per copy in
  `svn-status/` in the app data dir. When that copy's full status took over
  1.5 s, a review opens on the saved list and verifies it with a full status
  in the background; a different result offers Refresh like any other
  change.
- **BASE reads are cached** until `.svn/wc.db` moves, so a refresh doesn't
  re-run `svn cat` for every changed file.
- Deleted-directory expansion queries `svn info --depth infinity` only for
  the deleted paths, not the whole copy.

## Known v1 limitations

- **Replaced files review as added.** After `svn rm` + `svn add` of the same
  path, `svn cat -r BASE` fails (`E200009`: no pristine until commit) and the
  pre-replace content is only reachable through the server. A replacement is
  shown as an added file rather than erroring the diff or silently dropping
  the old side.
- **Over-cap files report no stats.** A working side larger than the content
  cache cap (4 MB) skips its BASE read entirely — line counts show 0 and the
  old side is unavailable, so a multi-GB file can't balloon extraction
  memory. (Git shows stats for such files; the SVN v1 trades that for bounded
  process/memory cost. On-demand single-file fetch is likewise capped.)
- **svn:ignore is not re-applied inside unversioned directories.** An
  unversioned directory's files are all listed (`.deltaignore` still applies).
- **No property diffs.** Property-only changes (a directory's props, an
  untouched file's props) don't appear in the diff.
- **No externals traversal.** `svn:externals` checkouts are skipped.
- **Renames are delete + add.** SVN's copy-based renames aren't paired.
- **Label fallback.** If the CLI is missing when a review opens, the worktree
  label falls back to `svn`; installing the CLI mid-review starts a fresh
  review (the label participates in the review id).

## Implementation notes

- All knowledge comes from the `svn` CLI's `--xml` output (`status`, `info`);
  `.svn/wc.db` is never read directly — its schema is internal and svn locks
  it during operations.
- Deleted/missing **directories** appear in `svn status` as one row without
  their files; `svn info --xml --depth infinity` (which still lists
  scheduled-deleted nodes) expands them to per-file deletions.
- A snapshot **pins** the binary BASE sides it read: git blobs are immutable,
  but an SVN BASE moves on the next commit/update, and a re-read under a
  still-displayed snapshot would serve different bytes than the window shows
  (wrong image previews especially). Pinned bytes are bounded by the same
  cache caps as text content.
- `svn cat` targets are passed absolute and peg-escaped (`path@` for paths
  containing `@`) after a `--` separator, so leading-dash names and peg
  revisions can't misparse.
- The fs watcher treats `.svn/wc.db` churn as the SVN equivalent of a ref
  move (full reload) and ignores the rest of `.svn` (pristine/lock noise).
