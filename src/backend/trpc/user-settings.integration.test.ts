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
// The encrypted Deepgram key is a secret the browser never needs (voice
// settings report only `hasApiKey`), so the payload never carries it either.
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

const encryptedDeepgramKey = 'iv:tag:encrypted-deepgram-key';

it('types the client-facing settings without the slash-command cache or Deepgram key', () => {
  expectTypeOf<SettingsOutputs['get']>().not.toHaveProperty('cachedSlashCommands');
  expectTypeOf<SettingsOutputs['update']>().not.toHaveProperty('cachedSlashCommands');
  expectTypeOf<SettingsOutputs['get']>().not.toHaveProperty('deepgramApiKeyEncrypted');
  expectTypeOf<SettingsOutputs['update']>().not.toHaveProperty('deepgramApiKeyEncrypted');
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

async function seedSettingsWithDeepgramKey() {
  await db.prisma.userSettings.create({
    data: {
      userId: 'default',
      voiceModeEnabled: true,
      deepgramApiKeyEncrypted: encryptedDeepgramKey,
    },
  });
}

async function storedDeepgramKey() {
  const row = await db.prisma.userSettings.findUniqueOrThrow({ where: { userId: 'default' } });
  return row.deepgramApiKeyEncrypted;
}

function expectNoDeepgramKey(payload: object) {
  expect(payload).not.toHaveProperty('deepgramApiKeyEncrypted');
  expect(JSON.stringify(payload)).not.toContain(encryptedDeepgramKey);
}

it('leaves the Deepgram key out of the settings query when one is stored', async () => {
  await seedSettingsWithDeepgramKey();

  const settings = await caller.get();

  expectNoDeepgramKey(settings);
  expect(settings.voiceModeEnabled).toBe(true);
});

it('leaves the Deepgram key out of the settings created on first read', async () => {
  const settings = await caller.get();

  expectNoDeepgramKey(settings);
  expect(settings.userId).toBe('default');
});

it('leaves the Deepgram key out of an update that sets it, and stores it', async () => {
  const updated = await userSettingsService.update({
    voiceModeEnabled: true,
    deepgramApiKeyEncrypted: encryptedDeepgramKey,
  });

  expectNoDeepgramKey(updated);
  expect(await storedDeepgramKey()).toBe(encryptedDeepgramKey);
});

it('keeps the stored Deepgram key through an unrelated settings update', async () => {
  await seedSettingsWithDeepgramKey();

  const updated = await caller.update({ playSoundOnComplete: false });

  expectNoDeepgramKey(updated);
  expect(updated.playSoundOnComplete).toBe(false);
  expect(await storedDeepgramKey()).toBe(encryptedDeepgramKey);
});

it('leaves the Deepgram key out of the workspace order update result', async () => {
  await seedSettingsWithDeepgramKey();

  const updated = await userSettingsService.updateWorkspaceOrder('project-1', ['ws-1']);

  expectNoDeepgramKey(updated);
  expect(await storedDeepgramKey()).toBe(encryptedDeepgramKey);
});

it('reads the stored Deepgram key through the voice settings read', async () => {
  await seedSettingsWithDeepgramKey();

  await expect(userSettingsService.getVoiceSettings()).resolves.toEqual({
    voiceModeEnabled: true,
    deepgramApiKeyEncrypted: encryptedDeepgramKey,
    voiceTtsModel: 'flux-haley-en',
    voiceTtsSpeed: 1,
    voiceUtteranceEndMs: 1000,
    voiceBargeInSustainedMs: 16,
  });
});

it('creates the default settings on a first voice settings read', async () => {
  await expect(userSettingsService.getVoiceSettings()).resolves.toMatchObject({
    voiceModeEnabled: false,
    deepgramApiKeyEncrypted: null,
    voiceTtsModel: 'flux-haley-en',
  });
  expect(await db.prisma.userSettings.count()).toBe(1);
});

it('reads only the current turn limit, including an unlimited setting', async () => {
  await seedSettingsWithCache();
  const read = vi.spyOn(db.prisma.userSettings, 'findUnique');
  try {
    await expect(userSettingsService.getTurnLimitMinutes()).resolves.toBeNull();
    await userSettingsService.update({ turnLimitMinutes: 30 });
    await expect(userSettingsService.getTurnLimitMinutes()).resolves.toBe(30);
    expect(read.mock.calls).toEqual([
      [{ where: { userId: 'default' }, select: { turnLimitMinutes: true } }],
      [{ where: { userId: 'default' }, select: { turnLimitMinutes: true } }],
    ]);
  } finally {
    read.mockRestore();
  }
});

it('creates default settings on the first turn limit read', async () => {
  await expect(userSettingsService.getTurnLimitMinutes()).resolves.toBeNull();
  await expect(
    db.prisma.userSettings.findUnique({ where: { userId: 'default' } })
  ).resolves.toMatchObject({ turnLimitMinutes: null, defaultSessionProvider: 'CLAUDE' });
});
