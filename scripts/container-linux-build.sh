#!/usr/bin/env bash
set -euo pipefail

# Runs INSIDE the delta-review-linux-builder image (see
# scripts/linux-builder.Dockerfile) on an emulated amd64 ubuntu:22.04. The host
# wrapper is scripts/build-release.sh, which mounts the repo at /work with
# named volumes for node_modules and the tauri target dir.

version="$1"
staging="release/${version}"

export RUSTUP_HOME=/usr/local/rustup
export CARGO_HOME=/usr/local/cargo
export PATH="/usr/local/cargo/bin:/usr/local/bin:${PATH}"
# UV_USE_IO_URING=0: node's libuv asserts under QEMU emulation when io_uring
# is in play; the flag is also baked into the builder image.
export UV_USE_IO_URING=0
export APPIMAGE_EXTRACT_AND_RUN=1
export NO_STRIP=true

pnpm install --frozen-lockfile

# Docker Desktop's Rosetta emulation refuses to exec AppImage type-2 ELF
# runtimes ("Exec format error" from the `AI` magic at offset 8). tauri-bundler
# zeroes that magic for its own linuxdeploy copy, but not for the appimage
# plugin, so pre-place a patched one in the bundler's tools cache.
tools_cache="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
mkdir -p "$tools_cache"
plugin="$tools_cache/linuxdeploy-plugin-appimage.AppImage"
if [ ! -f "$plugin" ]; then
  curl -fsSL -o "$plugin" \
    https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage
  chmod +x "$plugin"
  printf '\000\000\000' | dd of="$plugin" bs=1 seek=8 count=3 conv=notrunc status=none
fi

updater_cfg='{}'
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  updater_cfg='{"bundle":{"createUpdaterArtifacts":true}}'
fi

pnpm tauri build --bundles deb,appimage --config "$updater_cfg"

mkdir -p "$staging"
bundle_dir="src-tauri/target/release/bundle"
for f in "$bundle_dir/deb/"*.deb \
         "$bundle_dir/appimage/"*.AppImage \
         "$bundle_dir/appimage/"*.AppImage.tar.gz \
         "$bundle_dir/appimage/"*.sig; do
  if [ -f "$f" ]; then
    cp -v "$f" "$staging/"
  fi
done

# Artifacts land on the host bind mount; give them back to the host user.
chown -R "${HOST_UID}:${HOST_GID}" "$staging"
