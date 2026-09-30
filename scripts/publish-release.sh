#!/usr/bin/env bash
set -euo pipefail

# Publishes the fork release: commits the version bump if needed, tags, pushes,
# and creates a GitHub release on snatvb/delta-review with every artifact from
# release/<version>/ (built by scripts/build-release.sh) plus a multi-platform
# latest.json for the in-app updater.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

REPO_SLUG="snatvb/delta-review"

usage() {
  cat <<'USAGE'
Usage:
  scripts/publish-release.sh [--remote origin]

Publishes release/<version>/ artifacts for the current package.json version.
If package.json has an uncommitted version bump, this commits it before tagging.
USAGE
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

package_version() {
  node -e "console.log(JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version)"
}

product_name() {
  node -e "console.log(JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json', 'utf8')).productName)"
}

ensure_publishable_worktree() {
  local status
  status="$(git status --porcelain --untracked-files=no)"

  if [ -z "$status" ]; then
    return
  fi

  local unexpected
  unexpected="$(printf '%s\n' "$status" | awk '$2 != "package.json" { print }')"
  if [ -n "$unexpected" ]; then
    printf '%s\n' "$status" >&2
    die "only package.json may be changed when publishing (commit or stash the rest)"
  fi
}

commit_version_bump_if_needed() {
  local version="$1"

  if git diff --quiet -- package.json && git diff --cached --quiet -- package.json; then
    printf 'No uncommitted package.json version bump; publishing current HEAD as v%s.\n' "$version"
    return
  fi

  git add package.json
  git commit -m "chore(release): v${version}"
}

changelog_section() {
  local version="$1"
  # The CHANGELOG heading carries a date suffix ("## 0.17.0 — 2026-09-30"), so
  # match the version as a heading prefix; drop leading blank lines.
  awk -v ver="## ${version}" '
    !found && index($0, ver) == 1 { found = 1; next }
    found && /^## / { exit }
    found { print }
  ' CHANGELOG.md | sed -e '/./,$!d'
}

# latest.json platform key for an updater artifact, or empty if the file is not
# an updater artifact (e.g. the raw .deb).
platform_for_asset() {
  case "$1" in
    *.app.tar.gz)        printf 'darwin-aarch64\n' ;;
    *.nsis.zip)          printf 'windows-x86_64\n' ;;
    *-setup.exe)         printf 'windows-x86_64\n' ;;
    *.AppImage.tar.gz)   printf 'linux-x86_64\n' ;;
    *.AppImage)          printf 'linux-x86_64\n' ;;
    *)                   printf '' ;;
  esac
}

remote="origin"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote)
      shift
      [ "$#" -gt 0 ] || die "--remote requires a remote name"
      remote="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
  shift
done

require_cmd git
require_cmd gh
require_cmd node
require_cmd shasum

version="$(package_version)"
product="$(product_name)"
tag="v${version}"
staging="release/${version}"

[ -d "$staging" ] || die "no staging directory at $staging (run scripts/build-release.sh first)"
[ -f "${staging}/SHA256SUMS.txt" ] || die "SHA256SUMS.txt missing from $staging (run scripts/build-release.sh again)"
[ -f CHANGELOG.md ] || die "CHANGELOG.md not found"

if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  die "local tag already exists: ${tag}"
fi

if git ls-remote --exit-code --tags "$remote" "refs/tags/${tag}" >/dev/null 2>&1; then
  die "remote tag already exists: ${tag}"
fi

ensure_publishable_worktree
commit_version_bump_if_needed "$version"

git tag "$tag"
git push "$remote" HEAD
git push "$remote" "$tag"

base_url="https://github.com/${REPO_SLUG}/releases/download/${tag}"

# Assemble the updater manifest from whatever signed updater artifacts exist.
latest_args=()
for sig in "$staging"/*.sig; do
  [ -f "$sig" ] || continue
  asset="$(basename "$sig" .sig)"
  key="$(platform_for_asset "$asset")"
  [ -n "$key" ] || continue
  # Prefer the wrapped (v1) artifact for Windows when both forms are present.
  if [ "$key" = "windows-x86_64" ] && [ "$asset" = "${product}_${version}_x64-setup.exe" ] \
     && [ -f "$staging/${asset}.nsis.zip.sig" ]; then
    continue
  fi
  latest_args+=(--sig "${key}=${sig}" --url "${key}=${base_url}/${asset}")
done

notes_file="$(mktemp)"
latest_json="$(mktemp -d)/latest.json"
trap 'rm -f "$notes_file"; rm -rf "$(dirname "$latest_json")"' EXIT

{
  printf 'See [CHANGELOG.md](https://github.com/%s/blob/%s/CHANGELOG.md) for details.\n\n' "$REPO_SLUG" "$tag"
  changelog_section "$version"
} > "$notes_file"

if [ "${#latest_args[@]}" -gt 0 ]; then
  node scripts/gen-latest-json.mjs \
    --version "$version" \
    --pub-date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --notes "See the release page for details." \
    "${latest_args[@]}" > "$latest_json"
else
  printf 'warning: no signed updater artifacts found — publishing without latest.json.\n' >&2
fi

assets=()
for f in "$staging"/*; do
  case "$(basename "$f")" in
    latest.json) ;;
    *) assets+=("$f") ;;
  esac
done
if [ -s "$latest_json" ]; then
  assets+=("$latest_json")
fi

gh release create "$tag" "${assets[@]}" \
  --repo "$REPO_SLUG" \
  --title "delta-review ${tag}" \
  --notes-file "$notes_file"

printf '\nPublished %s on %s with %s assets.\n' "$tag" "$REPO_SLUG" "$((${#assets[@]}))"
printf 'SHA-256 checksums are in SHA256SUMS.txt on the release page.\n'
