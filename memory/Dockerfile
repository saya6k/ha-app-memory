# BUILD_FROM is no longer injected by the Supervisor (>=2026.04.0) — default to
# the HA base manifest, pinned rather than :latest. Overridable via --build-arg.
# Declared before any FROM so it is a global ARG (stage-scoped ARGs are empty
# in a later FROM).
#
# trixie, NOT bookworm: the official llama.cpp Linux release binaries are built
# on Ubuntu 24.04 and require GLIBC_2.38 / GLIBCXX_3.4.32. Debian bookworm ships
# glibc 2.36, where they fail to load (verified on aarch64).
ARG BUILD_FROM=ghcr.io/home-assistant/base-debian:trixie-2026.06.1

# ---- Node build stage -----------------------------------------------------
# trixie (glibc 2.41) on purpose: it must match the runtime base below, because
# better-sqlite3 is compiled here and its .node binary is copied over as-is.
FROM node:22-trixie-slim AS node-build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Runtime --------------------------------------------------------------
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ---- llama.cpp (prebuilt release, MIT) ------------------------------------
ARG LLAMA_BUILD=b10199
ARG LLAMA_SHA256_AARCH64=31a607f2384e9166f5a4af20c4c9e90d3044e2821bef6f60ed4494f0a7920cc9
ARG LLAMA_SHA256_AMD64=16d63bfb5c7e1c1656d940de398456ed2972af16ab5a0961f88c5929bc4fe58a

# libgomp1: llama.cpp links OpenMP. libstdc++6: needed by both llama.cpp and node.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      libgomp1 \
      libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$(uname -m)" in \
      x86_64)  asset="llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz";   sha="${LLAMA_SHA256_AMD64}" ;; \
      aarch64) asset="llama-${LLAMA_BUILD}-bin-ubuntu-arm64.tar.gz"; sha="${LLAMA_SHA256_AARCH64}" ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/llama.tar.gz \
      "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${asset}"; \
    echo "${sha}  /tmp/llama.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/llama /opt/llama; \
    tar -xzf /tmp/llama.tar.gz -C /tmp/llama; \
    bin="$(find /tmp/llama -type f -name llama-server | head -1)"; \
    [ -n "${bin}" ] || { echo "llama-server not found in release archive" >&2; exit 1; }; \
    cp -a "$(dirname "${bin}")/." /opt/llama/; \
    chmod a+x /opt/llama/llama-server; \
    rm -rf /tmp/llama /tmp/llama.tar.gz; \
    LD_LIBRARY_PATH=/opt/llama /opt/llama/llama-server --version

# ---- MCP server (Node) -----------------------------------------------------
COPY --from=node-build /usr/local/bin/node /usr/local/bin/node
COPY --from=node-build /app/dist /opt/mcp-server/dist
COPY --from=node-build /app/node_modules /opt/mcp-server/node_modules
COPY --from=node-build /app/package.json /opt/mcp-server/package.json

RUN node --version

# ---- rootfs (s6 services) --------------------------------------------------
# A failed oneshot (notably model-download: bad repo/file or checksum mismatch)
# must stop the add-on with the error still visible, instead of leaving it up in
# a broken state. Restarting is pointless for a configuration error.
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2

COPY rootfs /

RUN find /etc/s6-overlay/s6-rc.d -type f \( -name run -o -name finish -o -name "up*" \) \
      -exec chmod a+x {} \; \
 && find /etc/s6-overlay/s6-rc.d -type f -name type -exec chmod 644 {} \;

WORKDIR /
