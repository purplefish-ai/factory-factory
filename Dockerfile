# FactoryFactory Dockerfile
# Multi-stage build for production deployment

# pnpm version used throughout the build
ARG PNPM_VERSION=10.28.1

# ============================================================================
# Stage 1: Dependencies
# ============================================================================
FROM node:20-alpine AS deps
ARG PNPM_VERSION
WORKDIR /app

# Install dependencies for native modules and pnpm
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

# Install dependencies with pnpm
RUN pnpm install --frozen-lockfile

# Generate Prisma client
RUN pnpm db:generate

# ============================================================================
# Stage 2: Builder
# ============================================================================
FROM node:20-alpine AS builder
ARG PNPM_VERSION
WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Set environment for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build Next.js frontend and backend
RUN pnpm build:all

# ============================================================================
# Stage 3: Runner
# ============================================================================
FROM node:20-alpine AS runner
ARG PNPM_VERSION
WORKDIR /app

# Install runtime dependencies and pnpm
RUN apk add --no-cache \
    libc6-compat \
    git \
    tmux \
    bash \
    curl
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 factoryfactory

# Copy built assets
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Set ownership
RUN chown -R factoryfactory:nodejs /app

# Switch to non-root user
USER factoryfactory

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV BACKEND_PORT=3001
ENV HOSTNAME="0.0.0.0"

# Expose ports
EXPOSE 3000 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/health || exit 1

# Create startup script that runs migrations then starts the app
# Note: For production, run migrations separately before deploying
# This is a convenience for local Docker usage
ENTRYPOINT ["sh", "-c", "pnpm db:migrate:deploy && node server.js"]
