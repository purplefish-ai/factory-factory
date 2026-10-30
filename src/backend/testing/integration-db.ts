import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { TunedPrismaBetterSqlite3 } from '@/backend/lib/sqlite-adapter';
import { runMigrations } from '@/backend/migrate';
import type { PrismaClient } from '@prisma-gen/client';
import { PrismaClient as PrismaClientCtor } from '@prisma-gen/client';

const MIGRATIONS_PATH = join(process.cwd(), 'prisma', 'migrations');

export interface IntegrationDatabase {
  databasePath: string;
  prisma: PrismaClient;
  tempDir: string;
}

export async function createIntegrationDatabase(): Promise<IntegrationDatabase> {
  const tempDir = mkdtempSync(join(tmpdir(), 'ff-integration-'));
  const databasePath = join(tempDir, 'integration.db');

  runMigrations({
    databasePath,
    migrationsPath: MIGRATIONS_PATH,
    log: () => {
      // No-op in tests.
    },
  });

  process.env.DATABASE_PATH = databasePath;
  Reflect.deleteProperty(process.env, 'BASE_DIR');

  // The runtime DB module caches Prisma globally; clear both module and global caches
  // so each integration suite gets a fresh client bound to its own temp DB path.
  vi.resetModules();
  const adapter = new TunedPrismaBetterSqlite3({ url: databasePath });
  const prisma = new PrismaClientCtor({ adapter });
  (globalThis as { prismaGlobal?: PrismaClient }).prismaGlobal = prisma;
  await prisma.$connect();

  return {
    databasePath,
    prisma,
    tempDir,
  };
}

export async function clearIntegrationDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.terminalSession.deleteMany();
  await prisma.agentSession.deleteMany();
  await prisma.codexAccount.deleteMany();
  await prisma.codexAccount.create({
    data: { id: 'codex-native-default', label: 'Native default', kind: 'NATIVE_DEFAULT' },
  });
  await prisma.workspace.deleteMany();
  await prisma.project.deleteMany();
  await prisma.userSettings.deleteMany();
  await prisma.decisionLog.deleteMany();
}

export async function destroyIntegrationDatabase(db: IntegrationDatabase): Promise<void> {
  await db.prisma.$disconnect();
  (globalThis as { prismaGlobal?: PrismaClient }).prismaGlobal = undefined;
  rmSync(db.tempDir, { recursive: true, force: true });
}
