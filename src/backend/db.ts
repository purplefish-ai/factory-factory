import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma-gen/client';
import { configService } from './services/config.service';

declare global {
  var prismaGlobal: PrismaClient | undefined;
}

const globalForPrisma = globalThis;

/**
 * Ensure the directory for the database file exists
 */
function ensureDatabaseDirectory(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to create database directory "${dir}": ${message}. ` +
          'Check that you have write permissions or set DATABASE_PATH to a writable location.'
      );
    }
  }
}

function createPrismaClient(): PrismaClient {
  const databasePath = configService.getDatabasePath();

  // Ensure directory exists
  ensureDatabaseDirectory(databasePath);

  // Create Prisma adapter with SQLite configuration
  // Note: The adapter expects a raw file path, not a file: URL
  // (getDatabaseUrl() with file: prefix is for Prisma CLI configuration)
  const adapter = new PrismaBetterSqlite3({
    url: databasePath,
  });

  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prismaGlobal ?? createPrismaClient();

if (!configService.isProduction()) {
  globalForPrisma.prismaGlobal = prisma;
}

/**
 * Get the current database path (useful for logging/debugging)
 */
export function getCurrentDatabasePath(): string {
  return configService.getDatabasePath();
}
