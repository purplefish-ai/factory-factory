# FactoryFactory Dockerfile
# Multi-stage build for production deployment

# ============================================================================
# Stage 1: Dependencies
# ============================================================================
FROM node:20-alpine AS deps
WORKDIR /app

# Install dependencies for native modules
RUN apk add --no-cache libc6-compat

# Copy package files
COPY package.json package-lock.json* ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# ============================================================================
# Stage 2: Builder
# ============================================================================
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Set environment for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build Next.js frontend
RUN npm run build

# ============================================================================
# Stage 3: Runner
# ============================================================================
FROM node:20-alpine AS runner
WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    libc6-compat \
    git \
    tmux \
    bash \
    curl

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 factoryfactory

# Copy built assets
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src/backend ./src/backend
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

# Start command
CMD ["node", "server.js"]
