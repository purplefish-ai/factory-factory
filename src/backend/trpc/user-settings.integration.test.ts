import type { inferRouterOutputs } from '@trpc/server';
import { afterAll, beforeAll, beforeEach, expect, expectTypeOf, it, vi } from 'vitest';
import { userSettingsService } from '@/backend/services/settings';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { PrismaClient } from '@prisma-gen/client';
import { userSettingsRouter } from './user-settings.trpc';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));

// The settings query runs on every page load, often over a phone connection.
// The slash-command cache is read only by the backend; the browser gets slash
// commands from the chat socket, so the settings payload never carries it.
const cachedSlashCommands = {
  version: 2,
  global: {
    CLAUDE: Array.from({ length: 400 }, (_, index) => ({
      name: `/command-${index}`,
      description: 'd'.repeat(200),
    })),
  },
};

let db: IntegrationDatabase;
const caller = userSettingsRouter.createCaller(
  unsafeCoerce({ appContext: { services: { userSettingsQueryService: userSettingsService } } })
);

beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
beforeEach(async () => {
  await db.prisma.userSettings.deleteMany();
});
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

type SettingsOutputs = inferRouterOutputs<typeof userSettingsRouter>;

it('types the client-facing settings without the slash-command cache', () => {
  expectTypeOf<SettingsOutputs['get']>().not.toHaveProperty('cachedSlashCommands');
  expectTypeOf<SettingsOutputs['update']>().not.toHaveProperty('cachedSlashCommands');
  expectTypeOf<SettingsOutputs['get']>().toHaveProperty('preferredIde');
});

async function seedSettingsWithCache() {
  await db.prisma.userSettings.create({ data: { userId: 'default', cachedSlashCommands } });
}

async function storedCache() {
  const row = await db.prisma.userSettings.findUniqueOrThrow({ where: { userId: 'default' } });
  return row.cachedSlashCommands;
}

it('leaves the slash-command cache out of the settings query', async () => {
  await seedSettingsWithCache();

  const settings = await caller.get();

  expect(settings).not.toHaveProperty('cachedSlashCommands');
  expect(settings).toMatchObject({ userId: 'default', preferredIde: 'cursor' });
  expect(JSON.stringify(settings).length).toBeLessThan(2048);
});

it('leaves the slash-command cache out of the settings created on first read', async () => {
  const settings = await caller.get();

  expect(settings).not.toHaveProperty('cachedSlashCommands');
  expect(settings.userId).toBe('default');
});

it('leaves the slash-command cache out of the update result and keeps it stored', async () => {
  await seedSettingsWithCache();

  const updated = await caller.update({ playSoundOnComplete: false });

  expect(updated).not.toHaveProperty('cachedSlashCommands');
  expect(updated.playSoundOnComplete).toBe(false);
  expect(await storedCache()).toEqual(cachedSlashCommands);
});

it('leaves the slash-command cache out of an update that creates the settings', async () => {
  const updated = await caller.update({ preferredIde: 'vscode' });

  expect(updated).not.toHaveProperty('cachedSlashCommands');
  expect(updated.preferredIde).toBe('vscode');
});
