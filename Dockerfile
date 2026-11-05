# FactoryFactory Dockerfile
# Multi-stage build for cloud deployment

# Node 26 does not bundle Corepack. Share one pinned pnpm installation across stages.
FROM node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS base
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}/bin:${PNPM_HOME}:${PATH}"
# Keep the pnpm version and release asset SHA-256 digests pinned together.
# Use musl release archives on Alpine and verify before extraction.
RUN PNPM_VERSION=12.15.0 \
  && case "$(uname -m)" in \
       x86_64) PNPM_ARCH=x64; PNPM_SHA256=d33802cc987dcfbe02a991473764ba25ad1b2344189e2097a2570baed66f008a ;; \
       aarch64) PNPM_ARCH=arm64; PNPM_SHA256=1188ef8a57bfc5786f3f739a98067242e531a4636e3f52e9e9ddc75564ea804d ;; \
       *) echo "Unsupported pnpm architecture: $(uname -m)" >&2; exit 1 ;; \
     esac \
  && mkdir -p "${PNPM_HOME}" \
  && wget -qO /tmp/pnpm.tar.gz "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${PNPM_ARCH}-musl.tar.gz" \
  && echo "${PNPM_SHA256}  /tmp/pnpm.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/pnpm.tar.gz -C "${PNPM_HOME}" \
  && rm /tmp/pnpm.tar.gz

# ============================================================================
# Stage 1: Install dependencies
# ============================================================================
FROM base AS deps
WORKDIR /app

# Build tools for native modules (better-sqlite3, node-pty)
RUN apk add --no-cache python3 make g++ git libc6-compat

# Copy package manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.mjs ./
COPY patches/ ./patches/

# Dependency-stage postinstall only prepares node-pty helper permissions.
# Prisma generation belongs to the builder, after the source/config are copied.
COPY scripts/postinstall.mjs scripts/

# Install all dependencies (dev deps needed for build stage)
RUN pnpm install --frozen-lockfile

# Retain the exact installed runtime graph and local patches while removing
# development tools from the image. Work on a separate stage so builds keep them.
FROM deps AS production-deps
RUN pnpm prune --prod --ignore-scripts

# ============================================================================
# Stage 2: Build application
# ============================================================================
FROM base AS builder
WORKDIR /app

RUN apk add --no-cache git libc6-compat

# Copy dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy source
COPY . .

# Generate Prisma and build everything: backend TS, frontend Vite SPA, prompts
ENV NODE_ENV=production
# Use relative asset paths so the app works behind a reverse proxy with a path prefix.
# Relative paths (./assets/...) resolve correctly regardless of the proxy mount point,
# whereas root-absolute paths (/assets/...) cause 404s for <link rel="preload"> tags
# that the browser fires before JS runs.
ENV VITE_BASE_PATH=./
RUN pnpm build


# ============================================================================
# Stage 3: Production runner
# ============================================================================
FROM base AS runner
WORKDIR /app

# Runtime system dependencies + cloudflared for tunnel + GitHub CLI
# python3, make, g++ are needed so workspace `pnpm install` can compile
# native modules (node-pty has no Linux prebuilds)
# uv, pip, pipx, virtualenv for Python development in agent workspaces
# Resolve pipx and virtualenv together to avoid conflicting Alpine dependencies.
RUN apk add --no-cache \
    git \
    bash \
    tmux \
    curl \
    lsof \
    libc6-compat \
    libstdc++ \
    python3 \
    py3-pip \
    make \
    g++ \
    github-cli \
  && CF_VERSION="2026.10.7" \
  && UV_VERSION="0.13.6" \
  && case "$(uname -m)" in \
       x86_64) CF_ARCH=amd64; UV_ARCH=x86_64; \
         CF_SHA256=1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872; \
         UV_SHA256=5d61f26b6c7213779eda90edc6971ea6b0b796bfb8d49a574c8ad69b59838548 ;; \
       aarch64) CF_ARCH=arm64; UV_ARCH=aarch64; \
         CF_SHA256=3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775; \
         UV_SHA256=819692e404d23e5aae6bc44c0e260f1f5492fd1910ab4693b2c650f926dbe800 ;; \
       *) echo "Unsupported architecture" >&2; exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/cloudflared-linux-${CF_ARCH}" \
       -o /tmp/cloudflared \
  && echo "${CF_SHA256}  /tmp/cloudflared" | sha256sum -c - \
  && install -m 755 /tmp/cloudflared /usr/local/bin/cloudflared \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_ARCH}-unknown-linux-musl.tar.gz" \
       -o /tmp/uv.tar.gz \
  && echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/uv.tar.gz -C /tmp \
  && install -m 755 /tmp/uv-${UV_ARCH}-unknown-linux-musl/uv /usr/local/bin/uv \
  && install -m 755 /tmp/uv-${UV_ARCH}-unknown-linux-musl/uvx /usr/local/bin/uvx \
  && rm -rf /tmp/cloudflared /tmp/uv.tar.gz /tmp/uv-${UV_ARCH}-unknown-linux-musl \
  && pip3 install --no-cache-dir --break-system-packages pipx==1.18.5 virtualenv==21.15.0 \
  && python3 -m pipx ensurepath

# Keep standalone Codex available for workspace shell use; Claude uses ff claude.
RUN pnpm add -g @openai/codex@0.166.0

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/.node-version ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/patches ./patches

# Copy Prisma artifacts (migrations for runtime runner + generated client)
COPY --from=builder /app/prisma/migrations ./prisma/migrations
COPY --from=builder /app/prisma/schema.prisma ./prisma/
COPY --from=builder /app/prisma/generated ./prisma/generated

# Expose managed provider login commands in setup and workspace terminals.
RUN chmod +x /app/dist/src/cli/bootstrap.mjs \
  && ln -s /app/dist/src/cli/bootstrap.mjs /usr/local/bin/ff

# Create data directory
RUN mkdir -p /data

# Create execution space folder
RUN mkdir -p /execution_space_folder

ENV NODE_ENV=production
ENV PATH="/app/node_modules/.bin:/root/.local/bin:${PATH}"
ENV BACKEND_PORT=7001
ENV DATABASE_PATH=/data/data.db
ENV BASE_DIR=/data
ENV WORKTREE_BASE_DIR=/data/worktrees

EXPOSE 7001

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:7001/health || exit 1

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
