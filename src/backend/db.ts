import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma-gen/client';
import { getDatabasePath } from './lib/env';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

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
