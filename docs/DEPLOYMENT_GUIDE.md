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

- **Node.js**: 20.x or higher
- **Git**: 2.x or higher
- **tmux**: 3.x or higher (for agent terminals)
- **RAM**: 4GB minimum (8GB recommended)
- **Storage**: 10GB minimum for database and worktrees

### Optional Requirements

- **Docker**: 20.x or higher (for containerized deployment)
- **Nginx**: For production reverse proxy

## Local Development Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd factoryfactory
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Start Development Server

```bash
# Easiest way - uses SQLite with sensible defaults
pnpm dev

# Or using the CLI directly
ff serve --dev
```

The default database location is `~/factory-factory/data.db`. No configuration required!

### 4. Access the Application

- Frontend: http://localhost:3000
- Backend API: http://localhost:3001

## Production Deployment

### Option 1: Using the CLI (Recommended)

#### 1. Build the Application

```bash
ff build
```

#### 2. Start Production Server

```bash
ff serve
```

The server will:
- Automatically create the database at `~/factory-factory/data.db`
- Run migrations on startup
- Find available ports if defaults are in use
- Open your browser automatically

#### Custom Configuration

```bash
# Custom database location
ff serve --database-path /path/to/data.db

# Custom ports
ff serve --port 8080 --backend-port 8081

# Don't open browser
ff serve --no-open

# Verbose logging
ff serve --verbose
```

### Option 2: Manual Deployment

#### 1. Build the Application

```bash
pnpm build
```

#### 2. Set Environment Variables

```bash
export DATABASE_PATH="/path/to/data.db"
export NODE_ENV=production
```

#### 3. Start the Server

```bash
pnpm start
```

## Docker Deployment

### Production with Docker

#### 1. Build Images

```bash
docker-compose --profile production build
```

#### 2. Start Services

```bash
docker-compose --profile production up -d
```

The SQLite database will be stored in a Docker volume (`data`) for persistence.

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_PATH` | `~/factory-factory/data.db` | SQLite database file path |
| `BACKEND_PORT` | `3001` | Backend API port |
| `FRONTEND_PORT` | `3000` | Frontend port |
| `NODE_ENV` | `development` | Environment mode |

Note: No `ANTHROPIC_API_KEY` needed - Claude uses OAuth authentication via `claude login`.

### CLI Options

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port` | `3000` | Frontend port |
| `--backend-port` | `3001` | Backend API port |
| `-d, --database-path` | `~/factory-factory/data.db` | SQLite database path |
| `--host` | `localhost` | Host to bind to |
| `--dev` | `false` | Run in development mode |
| `--no-open` | `false` | Don't open browser |
| `-v, --verbose` | `false` | Verbose logging |

### Agent Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCHESTRATOR_MODEL` | `sonnet` | Model for orchestrator |
| `SUPERVISOR_MODEL` | `sonnet` | Model for supervisors |
| `WORKER_MODEL` | `sonnet` | Model for workers |
| `ORCHESTRATOR_PERMISSIONS` | `strict` | Permission mode |
| `SUPERVISOR_PERMISSIONS` | `relaxed` | Permission mode |
| `WORKER_PERMISSIONS` | `yolo` | Permission mode |

## Database Migrations

### Automatic Migrations

The `ff serve` command automatically runs migrations on startup. No manual intervention needed!

### Manual Migrations

```bash
# Run migrations manually
ff db:migrate

# With custom database path
ff db:migrate --database-path /path/to/data.db
```

### Development Migrations

```bash
# Create a new migration
pnpm db:migrate

# Reset database (destroys data!)
npx prisma migrate reset
```

### Database Studio

```bash
# Open Prisma Studio to browse/edit data
ff db:studio
```

## Backup and Recovery

### Database Backup

SQLite databases are simple files - just copy the file!

```bash
# Simple backup
cp ~/factory-factory/data.db ~/factory-factory/backup-$(date +%Y%m%d).db

# With CLI
cp $(ff db:path 2>/dev/null || echo ~/factory-factory/data.db) backup.db
```

### Database Restore

```bash
# Stop the server first, then restore
cp backup.db ~/factory-factory/data.db
```

### Automated Backups

Set up a cron job for regular backups:

```bash
# Edit crontab
crontab -e

# Add daily backup at 2 AM
0 2 * * * cp ~/factory-factory/data.db ~/backups/ff-$(date +\%Y\%m\%d).db
```

## Monitoring

### Health Check Endpoints

- `/health` - Basic health check
- `/health/database` - Database connection
- `/health/agents` - Agent health summary
- `/health/all` - Comprehensive check

### Monitoring Recommendations

1. **Set up health check monitoring**: Use uptime services to ping `/health`
2. **Alert on failures**: Configure alerts for `/health/all` returning non-200
3. **Log aggregation**: Ship logs to a centralized logging service
4. **Database size monitoring**: Monitor SQLite file size growth

## Security Considerations

### Production Checklist

- [ ] Use HTTPS (configure nginx with SSL)
- [ ] Set appropriate CORS origins
- [ ] Use environment variables for configuration
- [ ] Enable rate limiting
- [ ] Set up firewall rules
- [ ] Regular security updates
- [ ] Backup database regularly

### CORS Configuration

```env
CORS_ALLOWED_ORIGINS=https://your-domain.com,https://www.your-domain.com
```

### SSL/TLS Setup

1. Obtain SSL certificates (Let's Encrypt recommended)
2. Place certificates in `./certs/` directory
3. Use the provided nginx.conf for HTTPS configuration

---

For user documentation, see [USER_GUIDE.md](./USER_GUIDE.md).
For architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md).
