# FactoryFactory Deployment Guide

This guide covers deploying FactoryFactory to various environments, from local development to production.

## Table of Contents

1. [System Requirements](#system-requirements)
2. [Local Development Setup](#local-development-setup)
3. [Production Deployment](#production-deployment)
4. [Docker Deployment](#docker-deployment)
5. [Configuration Reference](#configuration-reference)
6. [Database Migrations](#database-migrations)
7. [Backup and Recovery](#backup-and-recovery)
8. [Monitoring](#monitoring)
9. [Security Considerations](#security-considerations)

## System Requirements

### Minimum Requirements

- **Node.js**: 18.x or higher
- **PostgreSQL**: 15.x or higher
- **Git**: 2.x or higher
- **tmux**: 3.x or higher (for agent terminals)
- **RAM**: 4GB minimum (8GB recommended)
- **Storage**: 10GB minimum for database and worktrees

### Optional Requirements

- **Docker**: 20.x or higher (for containerized deployment)
- **Nginx**: For production reverse proxy
- **Redis**: For session storage (if using authentication)

## Local Development Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd factoryfactory
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit with your values
nano .env
```

Required variables for development:
```env
DATABASE_URL="postgresql://factoryfactory:factoryfactory_dev@localhost:5432/factoryfactory"
ANTHROPIC_API_KEY="your-api-key"
```

### 4. Start PostgreSQL

Using Docker:
```bash
docker-compose up -d postgres
```

Or use an existing PostgreSQL instance.

### 5. Initialize Database

```bash
# Generate Prisma client
npm run db:generate

# Run migrations
npm run db:migrate
```

### 6. Start Development Servers

In separate terminals:

```bash
# Terminal 1: Frontend
npm run dev

# Terminal 2: Backend
npm run backend:dev

# Terminal 3: Inngest Dev Server
npm run inngest:dev
```

Or all at once (requires `concurrently`):
```bash
npm run dev:all
```

### 7. Access the Application

- Frontend: http://localhost:3000
- Backend API: http://localhost:3001
- Inngest Dev UI: http://localhost:8288

## Production Deployment

### Option 1: Manual Deployment

#### 1. Build the Application

```bash
# Build frontend
npm run build

# Build backend (optional, for TypeScript compilation)
npm run build:backend
```

#### 2. Set Production Environment

```env
NODE_ENV=production
DATABASE_URL="postgresql://user:password@production-db:5432/factoryfactory"
ANTHROPIC_API_KEY="your-production-api-key"
INNGEST_EVENT_KEY="your-inngest-event-key"
INNGEST_SIGNING_KEY="your-inngest-signing-key"
```

#### 3. Run Migrations

```bash
npm run db:migrate:deploy
```

#### 4. Start Production Servers

```bash
# Start frontend
npm run start

# Start backend (in another process)
npm run start:backend
```

Use a process manager like PM2:
```bash
pm2 start npm --name "frontend" -- start
pm2 start npm --name "backend" -- run start:backend
```

### Option 2: Docker Deployment

See [Docker Deployment](#docker-deployment) section.

## Docker Deployment

### Development with Docker

```bash
# Start database only
docker-compose up -d postgres

# Or with Inngest dev server
docker-compose --profile dev up -d
```

### Production with Docker

#### 1. Build Images

```bash
docker-compose --profile production build
```

#### 2. Configure Production Environment

Create a `.env` file with production values:

```env
NODE_ENV=production
ANTHROPIC_API_KEY=your-production-key
INNGEST_EVENT_KEY=your-inngest-key
INNGEST_SIGNING_KEY=your-inngest-signing-key
POSTGRES_PASSWORD=secure-password-here
```

#### 3. Start Services

```bash
docker-compose --profile production up -d
```

#### 4. Run Migrations

```bash
docker-compose exec backend npm run db:migrate:deploy
```

### Docker Compose Profiles

- **default**: PostgreSQL only (for local development)
- **dev**: PostgreSQL + Inngest dev server
- **production**: Full stack (PostgreSQL + Backend + Frontend + Nginx)

## Configuration Reference

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `ANTHROPIC_API_KEY` | Claude API key | `sk-ant-...` |

### Optional Environment Variables

#### Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND_PORT` | `3001` | Backend API port |
| `FRONTEND_PORT` | `3000` | Frontend port |
| `NODE_ENV` | `development` | Environment mode |

#### Inngest (Required for Production)

| Variable | Description |
|----------|-------------|
| `INNGEST_EVENT_KEY` | Event key from Inngest dashboard |
| `INNGEST_SIGNING_KEY` | Signing key from Inngest dashboard |

#### Agent Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCHESTRATOR_MODEL` | `sonnet` | Model for orchestrator |
| `SUPERVISOR_MODEL` | `sonnet` | Model for supervisors |
| `WORKER_MODEL` | `sonnet` | Model for workers |
| `ORCHESTRATOR_PERMISSIONS` | `strict` | Permission mode |
| `SUPERVISOR_PERMISSIONS` | `relaxed` | Permission mode |
| `WORKER_PERMISSIONS` | `yolo` | Permission mode |

#### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_RATE_LIMIT_PER_MINUTE` | `60` | API calls per minute |
| `CLAUDE_RATE_LIMIT_PER_HOUR` | `1000` | API calls per hour |
| `MAX_CONCURRENT_WORKERS` | `10` | Max concurrent workers |
| `MAX_CONCURRENT_SUPERVISORS` | `5` | Max concurrent supervisors |
| `MAX_CONCURRENT_EPICS` | `5` | Max concurrent epics |

#### Health & Recovery

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_CHECK_INTERVAL_MS` | `300000` | Health check interval (5 min) |
| `AGENT_HEARTBEAT_THRESHOLD_MINUTES` | `7` | Unhealthy threshold |
| `MAX_WORKER_ATTEMPTS` | `5` | Max recovery attempts |
| `CRASH_LOOP_THRESHOLD_MS` | `60000` | Crash loop window |
| `MAX_RAPID_CRASHES` | `3` | Crashes before loop |

## Database Migrations

### Development Migrations

```bash
# Create a new migration
npm run db:migrate

# Reset database (destroys data!)
npx prisma migrate reset
```

### Production Migrations

```bash
# Apply pending migrations
npm run db:migrate:deploy
```

### Rollback Strategy

Prisma doesn't support automatic rollback. For production:

1. Always backup before migrating
2. Test migrations in staging first
3. Keep rollback scripts for critical changes

## Backup and Recovery

### Database Backup

```bash
# Backup database
pg_dump -h localhost -U factoryfactory -d factoryfactory > backup.sql

# With Docker
docker-compose exec postgres pg_dump -U factoryfactory factoryfactory > backup.sql
```

### Database Restore

```bash
# Restore database
psql -h localhost -U factoryfactory -d factoryfactory < backup.sql

# With Docker
docker-compose exec -T postgres psql -U factoryfactory factoryfactory < backup.sql
```

### Automated Backups

Set up a cron job for regular backups:

```bash
# Edit crontab
crontab -e

# Add daily backup at 2 AM
0 2 * * * pg_dump -h localhost -U factoryfactory factoryfactory > /backups/ff-$(date +\%Y\%m\%d).sql
```

## Monitoring

### Health Check Endpoints

- `/health` - Basic health check
- `/health/database` - Database connection
- `/health/inngest` - Inngest status
- `/health/agents` - Agent health summary
- `/health/all` - Comprehensive check

### Check Health via CLI

```bash
# Quick check
npm run health

# Full check
npm run health:all
```

### Monitoring Recommendations

1. **Set up health check monitoring**: Use uptime services to ping `/health`
2. **Alert on failures**: Configure alerts for `/health/all` returning non-200
3. **Log aggregation**: Ship logs to a centralized logging service
4. **Database monitoring**: Monitor PostgreSQL connections and performance

## Security Considerations

### Production Checklist

- [ ] Use strong database passwords
- [ ] Enable HTTPS (configure nginx with SSL)
- [ ] Set appropriate CORS origins
- [ ] Use environment variables for secrets
- [ ] Enable rate limiting
- [ ] Set up firewall rules
- [ ] Regular security updates

### CORS Configuration

```env
CORS_ALLOWED_ORIGINS=https://your-domain.com,https://www.your-domain.com
```

### SSL/TLS Setup

1. Obtain SSL certificates (Let's Encrypt recommended)
2. Place certificates in `./certs/` directory
3. Use the provided nginx.conf for HTTPS configuration

### Secrets Management

For production, consider using:
- AWS Secrets Manager
- HashiCorp Vault
- Doppler
- Environment-specific `.env` files (never commit to git)

---

For user documentation, see [USER_GUIDE.md](./USER_GUIDE.md).
For architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md).
