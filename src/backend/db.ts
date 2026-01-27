import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma-gen/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * Expand environment variables in a string.
 * Handles $VAR and ${VAR} syntax, including $USER.
 */
function expandEnvVars(value: string): string {
  // Replace $USER with actual home directory username
  let result = value.replace(/\$USER|\$\{USER\}/g, homedir().split('/').pop() || 'user');

  // Replace other environment variables
  result = result.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue !== undefined) {
      return expandEnvVars(envValue);
    }
    return match;
  });

  return result;
}

/**
 * Get the database file path based on environment.
 *
 * Priority:
 * 1. DATABASE_PATH environment variable (for Electron or explicit override)
 * 2. Default: ~/factory-factory/data.db (development default)
 *
 * For Electron production, set DATABASE_PATH to app.getPath('userData')/data.db
 * before importing this module.
 */
function getDatabasePath(): string {
  if (process.env.DATABASE_PATH) {
    return expandEnvVars(process.env.DATABASE_PATH);
  }

  // Default development path - expand any env vars in BASE_DIR (e.g., $USER)
  const rawBaseDir = process.env.BASE_DIR;
  const baseDir = rawBaseDir ? expandEnvVars(rawBaseDir) : join(homedir(), 'factory-factory');
  return join(baseDir, 'data.db');
}

/**
 * Ensure the directory for the database file exists
 */
function ensureDatabaseDirectory(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function createPrismaClient(): PrismaClient {
  const databasePath = getDatabasePath();

  // Ensure directory exists
  ensureDatabaseDirectory(databasePath);

  // Create Prisma adapter with SQLite configuration
  // The adapter handles connection creation internally
  const adapter = new PrismaBetterSqlite3({
    url: databasePath,
  });

  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Get the current database path (useful for logging/debugging)
 */
export function getCurrentDatabasePath(): string {
  return getDatabasePath();
}
