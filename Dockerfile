# FactoryFactory Dockerfile
# Multi-stage build for cloud deployment

ARG NODE_VERSION=20
ARG PNPM_VERSION=10.28.1

# ============================================================================
# Stage 1: Install dependencies
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS deps
ARG PNPM_VERSION
WORKDIR /app

# Build tools for native modules (better-sqlite3, node-pty)
RUN apk add --no-cache python3 make g++ git libc6-compat

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy package manifests (workspace + root + sub-packages)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/

# Copy files needed by postinstall script (runs prisma generate + node-pty fixup)
COPY scripts/postinstall.mjs scripts/
COPY prisma/schema.prisma prisma/

# Install all dependencies (dev deps needed for build stage)
RUN pnpm install --frozen-lockfile

# ============================================================================
# Stage 2: Build application
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS builder
ARG PNPM_VERSION
WORKDIR /app

RUN apk add --no-cache git libc6-compat
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/prisma/generated ./prisma/generated

# Copy source
COPY . .

# Build everything: core workspace, backend TS, frontend Vite SPA, prompts
ENV NODE_ENV=production
RUN pnpm build


# ============================================================================
# Stage 3: Production runner
# ============================================================================
FROM node:${NODE_VERSION}-alpine AS runner
ARG PNPM_VERSION
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
    docker \
    docker-cli-compose \
    containerd \
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

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Install Claude CLI and Codex CLI globally
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/

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
