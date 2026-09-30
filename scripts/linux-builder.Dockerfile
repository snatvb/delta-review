# Builder image for the fork's Linux x86_64 release artifacts. Baked once by
# scripts/build-release.sh and reused across builds; the per-release work
# (frontend + cargo + bundling) is driven by scripts/container-linux-build.sh.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/bin:$PATH \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    NO_STRIP=true \
    UV_USE_IO_URING=0

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl wget file git xdg-utils \
      libssl-dev libxdo-dev libgtk-3-dev \
      libayatana-appindicator3-dev librsvg2-dev \
      libwebkit2gtk-4.1-dev \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain stable --profile minimal

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@11
