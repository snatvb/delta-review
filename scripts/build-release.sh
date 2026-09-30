#!/usr/bin/env bash
set -euo pipefail

# Fork release builder — builds macOS, Windows, and Linux artifacts locally,
# no CI involved. Windows is cross-compiled with mingw-w64; Linux is built
# inside an emulated ubuntu:22.04 (amd64) Docker container.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  scripts/build-release.sh --version X.Y.Z | --minor | --patch | --no-bump
                           [--only mac|windows|linux] [--skip-checks]

Builds fork release artifacts into release/<version>/:
  mac      delta-review_<v>_aarch64.dmg (+ delta-review.app.tar.gz + .sig)
  windows  delta-review_<v>_x64-setup.exe (+ .sig) — cross-compiled via mingw-w64
           delta-review_<v>_x64.msi — WiX definition compiled with wixl in Docker
  linux    delta-review_<v>_amd64.deb + delta-review_<v>_amd64.AppImage (+ .sig)

Signing is best-effort:
  - macOS codesigning/notarization is skipped (pass APPLE_SIGNING_IDENTITY to sign)
  - updater artifacts are signed with ~/.tauri/delta-review-updater.key (fork key)
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

bump_version() {
  node - "$1" "${2:-}" <<'NODE'
const fs = require("fs");

const bump = process.argv[2];
const explicit = process.argv[3] || "";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`unsupported package version: ${version}`);
  }
  return match.slice(1).map(Number);
}

let next;
if (bump === "none") {
  next = pkg.version;
} else if (bump === "version") {
  if (!/^\d+\.\d+\.\d+$/.test(explicit)) {
    throw new Error(`--version must be X.Y.Z, got: ${explicit}`);
  }
  next = explicit;
} else {
  const [major, minor, patch] = parseVersion(pkg.version);
  if (bump === "major") {
    next = `${major + 1}.0.0`;
  } else if (bump === "minor") {
    next = `${major}.${minor + 1}.0`;
  } else if (bump === "patch") {
    next = `${major}.${minor}.${patch + 1}`;
  } else {
    throw new Error(`unknown bump: ${bump}`);
  }
}

if (next !== pkg.version) {
  pkg.version = next;
  fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
}
console.log(next);
NODE
}

bump=""
explicit_version=""
only=""
skip_checks=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --patch|--minor|--major)
      [ -z "$bump" ] || die "choose only one version option"
      bump="${1#--}"
      ;;
    --version)
      [ -z "$bump" ] || die "choose only one version option"
      shift
      [ "$#" -gt 0 ] || die "--version requires X.Y.Z"
      bump="version"
      explicit_version="$1"
      ;;
    --no-bump)
      [ -z "$bump" ] || die "choose only one version option"
      bump="none"
      ;;
    --only)
      shift
      [ "$#" -gt 0 ] || die "--only requires mac|windows|linux"
      case "$1" in
        mac|windows|linux) only="$1" ;;
        *) die "--only must be mac|windows|linux" ;;
      esac
      ;;
    --skip-checks)
      skip_checks=1
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

[ -n "$bump" ] || {
  usage >&2
  die "choose --patch, --minor, --major, --version X.Y.Z, or --no-bump"
}

require_cmd git
require_cmd node
require_cmd pnpm
require_cmd cargo

build_mac=0
build_windows=0
build_linux=0
case "$only" in
  "")     build_mac=1; build_windows=1; build_linux=1 ;;
  mac)    build_mac=1 ;;
  windows) build_windows=1 ;;
  linux)  build_linux=1 ;;
esac
[ "$build_linux" -eq 0 ] || require_cmd docker

old_version="$(package_version)"
product="$(product_name)"

if [ "$skip_checks" -eq 0 ]; then
  printf 'Validating current tree...\n'
  npx tsc --noEmit
  pnpm test
  (cd src-tauri && cargo test)
fi

new_version="$(bump_version "$bump" "$explicit_version")"
printf 'Version: %s -> %s\n' "$old_version" "$new_version"

# Revert the uncommitted version bump if anything below fails, so a failed run
# doesn't leave package.json dirty for the next one.
trap 'git checkout -- package.json 2>/dev/null || true' ERR

staging="release/${new_version}"
mkdir -p "$staging"

# Updater signing: fork key generated once via
#   pnpm tauri signer generate -w ~/.tauri/delta-review-updater.key -p ""
updater_cfg='{}'
key_path="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/delta-review-updater.key}"
if [ -f "$key_path" ]; then
  # Export the key CONTENT only: the bundler's createUpdaterArtifacts path reads
  # TAURI_SIGNING_PRIVATE_KEY, and `tauri signer sign` rejects having both the
  # content and the _PATH variant set at once.
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$key_path")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  updater_cfg='{"bundle":{"createUpdaterArtifacts":true}}'
else
  printf 'warning: updater key not found at %s — updater artifacts will be skipped.\n' "$key_path" >&2
fi

collect() { # collect <bundle-subdir> <glob...>
  local dir="src-tauri/target/$1"
  shift
  local found=0
  for pattern in "$@"; do
    for f in "$dir"/$pattern; do
      [ -f "$f" ] || continue
      cp "$f" "$staging/"
      found=1
    done
  done
  [ "$found" -eq 1 ] || die "no artifacts matched in $dir (patterns: $*)"
}

bake_builder_image() {
  local image="delta-review-linux-builder:latest"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf 'Baking %s (one-time, ~10 min under emulation)...\n' "$image"
    docker build --platform linux/amd64 -t "$image" -f scripts/linux-builder.Dockerfile scripts
  fi
  printf '%s' "$image"
}

if [ "$build_mac" -eq 1 ]; then
  printf '\n=== macOS (aarch64) ===\n'
  pnpm tauri build --bundles app,dmg
  collect release/bundle/dmg "${product}_${new_version}_aarch64.dmg"

  if [ -f "$key_path" ]; then
    app_dir="src-tauri/target/release/bundle/macos"
    [ -d "$app_dir/${product}.app" ] || die "app bundle not found in $app_dir"
    # Repack the updater tarball ourselves: macOS bsdtar would embed AppleDouble
    # `._*` members that the updater's Rust tar extractor chokes on.
    COPYFILE_DISABLE=1 tar --no-mac-metadata -C "$app_dir" -czf "$staging/${product}.app.tar.gz" "${product}.app"
    pnpm tauri signer sign "$staging/${product}.app.tar.gz"
  fi
fi

if [ "$build_windows" -eq 1 ]; then
  printf '\n=== Windows (x64, cross via mingw-w64) ===\n'
  rustup target add x86_64-pc-windows-gnu
  require_cmd x86_64-w64-mingw32-gcc
  pnpm tauri build --target x86_64-pc-windows-gnu --bundles nsis --config "$updater_cfg"
  collect x86_64-pc-windows-gnu/release/bundle/nsis "${product}_${new_version}_x64-setup.exe"
  # Updater artifacts (nsis.zip + .sig) are optional — they only exist when the
  # fork updater key was available at build time.
  for f in src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/*.nsis.zip \
           src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/*.sig; do
    [ -f "$f" ] || continue
    case "$f" in *"${new_version}"*) cp "$f" "$staging/" ;; esac
  done

  # MSI: tauri-bundler only produces MSIs on Windows hosts, so compile a
  # hand-authored WiX definition with msitools' wixl in a Debian container,
  # against the exe the cross-build just produced. No target-dir volume here —
  # the container must see the host-built Windows exe.
  msi_image="delta-review-msi-builder:latest"
  if ! docker image inspect "$msi_image" >/dev/null 2>&1; then
    printf 'Baking %s (one-time)...\n' "$msi_image"
    docker build --platform linux/amd64 -t "$msi_image" -f scripts/msi-builder.Dockerfile scripts
  fi
  docker run --rm --platform linux/amd64 \
    -v "$ROOT_DIR":/work -w /work \
    -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    "$msi_image" bash scripts/container-windows-msi.sh "$new_version"
  [ -f "$staging/${product}_${new_version}_x64.msi" ] || die "Windows MSI was not produced"
fi

if [ "$build_linux" -eq 1 ]; then
  printf '\n=== Linux (x86_64, Docker ubuntu:22.04) ===\n'
  docker run --rm --platform linux/amd64 \
    -v "$ROOT_DIR":/work -w /work \
    -v delta-review-node-modules:/work/node_modules \
    -v delta-review-target:/work/src-tauri/target \
    -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    -e TAURI_SIGNING_PRIVATE_KEY="${TAURI_SIGNING_PRIVATE_KEY:-}" \
    -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
    "$(bake_builder_image)" bash scripts/container-linux-build.sh "$new_version"
  [ -f "$staging/${product}_${new_version}_amd64.AppImage" ] || die "Linux AppImage was not produced"
  [ -f "$staging/${product}_${new_version}_amd64.deb" ] || die "Linux deb was not produced"
fi

(
  cd "$staging"
  rm -f SHA256SUMS.txt
  shasum -a 256 -- * > SHA256SUMS.txt
)

printf '\nRelease candidate built into %s.\n' "$staging"
ls -la "$staging"
printf '\nTest the artifacts, then run scripts/publish-release.sh.\n'
