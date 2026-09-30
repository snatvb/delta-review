# Tiny image for the fork's Windows MSI artifact: tauri-bundler only builds
# MSIs on Windows hosts, so the fork compiles a hand-authored WiX definition
# (scripts/windows-msi/Delta.wxs) with msitools' wixl instead. Debian
# bookworm is used because ubuntu:22.04 ships no wixl package.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      wixl msitools ca-certificates \
    && rm -rf /var/lib/apt/lists/*
