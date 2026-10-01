#!/usr/bin/env bash
set -euo pipefail

# Runs INSIDE the delta-review-msi-builder image (Debian bookworm + wixl).
# Packages the cross-compiled Windows Delta.exe into an MSI. The host wrapper
# is scripts/build-release.sh (--only windows), which mounts the repo at /work
# WITHOUT the target-dir volume so the Windows exe built on the host is visible.

version="$1"
# `app` is productName (drives the MSI file name); `binary` is mainBinaryName
# (the cross-compiled exe). They intentionally differ from the CLI shim name.
app="$2"
binary="DeltaReview"
staging="release/${version}"

exe="src-tauri/target/x86_64-pc-windows-gnu/release/${binary}.exe"
[ -f "$exe" ] || { printf 'error: %s not built yet\n' "$exe" >&2; exit 1; }

msi="${staging}/${app}_${version}_x64.msi"
mkdir -p "$staging"

wixl -v -a x64 \
  -D Version="$version" \
  -D ExePath="../../src-tauri/target/x86_64-pc-windows-gnu/release/${binary}.exe" \
  -D IconPath="../../src-tauri/icons/icon.ico" \
  -o "$msi" \
  scripts/windows-msi/Delta.wxs

# Smoke-check the result: dump the summary information and layout.
msiinfo export "$msi" Property | head -20
msiextract --list "$msi"

chown "${HOST_UID}:${HOST_GID}" "$msi"
printf '\nMSI built: %s\n' "$msi"
