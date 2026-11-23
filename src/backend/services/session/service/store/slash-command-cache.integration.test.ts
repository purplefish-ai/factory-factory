import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { userSettingsService } from '@/backend/services/settings';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';
import { slashCommandCacheService } from './slash-command-cache.service';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

// The settings read leaves the cache out, so the cache keeps its own read.
it('stores and reads provider commands outside the settings read', async () => {
  await slashCommandCacheService.setCachedCommands('CLAUDE', [
    { name: '/review', description: 'Review' },
  ]);
  await slashCommandCacheService.setCachedCommands('CODEX', [
    { name: '/status', description: 'Status', argumentHint: ' [verbose] ' },
  ]);

  await expect(slashCommandCacheService.getCachedCommands('CLAUDE')).resolves.toEqual([
    { name: '/review', description: 'Review' },
  ]);
  await expect(slashCommandCacheService.getCachedCommands('CODEX')).resolves.toEqual([
    { name: '/status', description: 'Status', argumentHint: '[verbose]' },
  ]);
  expect(await userSettingsService.get()).not.toHaveProperty('cachedSlashCommands');
});
