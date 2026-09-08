# FactoryFactory Dockerfile
# Multi-stage build for cloud deployment

ARG NODE_VERSION=26.8.1

# Node 26 does not bundle Corepack. Share one pinned pnpm installation across stages.
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION=10.34.5
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN wget -qO /tmp/install-pnpm.sh https://get.pnpm.io/install.sh \
  && ENV=/etc/profile SHELL=/bin/sh PNPM_VERSION=${PNPM_VERSION} sh /tmp/install-pnpm.sh \
  && rm /tmp/install-pnpm.sh

# ============================================================================
# Stage 1: Install dependencies
# ============================================================================
FROM base AS deps
WORKDIR /app

# Build tools for native modules (better-sqlite3, node-pty)
RUN apk add --no-cache python3 make g++ git libc6-compat

# Copy package manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy files needed by postinstall script (runs prisma generate + node-pty fixup)
COPY scripts/postinstall.mjs scripts/
COPY prisma/schema.prisma prisma/

# Install all dependencies (dev deps needed for build stage)
RUN pnpm install --frozen-lockfile

# ============================================================================
# Stage 2: Build application
# ============================================================================
FROM base AS builder
WORKDIR /app

RUN apk add --no-cache git libc6-compat

# Copy dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma/generated ./prisma/generated

# Copy source
COPY . .

# Build everything: backend TS, frontend Vite SPA, prompts
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
    py3-virtualenv \
    make \
    g++ \
    github-cli \
  && ARCH="$(uname -m)" \
  && case "$ARCH" in \
       x86_64)  CF_ARCH="amd64" ;; \
       aarch64) CF_ARCH="arm64" ;; \
       armv7l)  CF_ARCH="arm"   ;; \
       *)       echo "Unsupported arch: $ARCH" && exit 1 ;; \
     esac \
  && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
       -o /usr/local/bin/cloudflared \
  && chmod +x /usr/local/bin/cloudflared \
  && UV_VERSION="0.10.6" \
  && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" -o /tmp/uv-install.sh \
  && UV_UNMANAGED_INSTALL="/usr/local/bin" sh /tmp/uv-install.sh \
  && rm /tmp/uv-install.sh \
  && pip3 install --no-cache-dir --break-system-packages pipx \
  && python3 -m pipx ensurepath

# Install Claude CLI and Codex CLI globally
RUN pnpm add -g --allow-build=@anthropic-ai/claude-code @anthropic-ai/claude-code @openai/codex

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# Copy Prisma artifacts (migrations for runtime runner + generated client)
COPY --from=builder /app/prisma/migrations ./prisma/migrations
COPY --from=builder /app/prisma/schema.prisma ./prisma/
COPY --from=builder /app/prisma/generated ./prisma/generated

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
