import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { userSettingsService } from '@/backend/services/settings';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { PrismaClient } from '@prisma-gen/client';
import { userSettingsRouter } from './user-settings.trpc';
import { voiceRouter } from './voice.trpc';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));

// Settings responses leave the encrypted Deepgram key out, so the voice
// procedures read it through the settings service's voice read. These run the
// real router, service and database to show writing, reporting and using the
// key still work end to end.
const cryptoService = {
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (ciphertext: string) => ciphertext.replace(/^encrypted:/, ''),
};
const services = { cryptoService, userSettingsQueryService: userSettingsService };
const voice = voiceRouter.createCaller(unsafeCoerce({ appContext: { services } }));
const settings = userSettingsRouter.createCaller(unsafeCoerce({ appContext: { services } }));

let db: IntegrationDatabase;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
}, 30_000);
beforeEach(async () => {
  await db.prisma.userSettings.deleteMany();
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

async function storedKey() {
  const row = await db.prisma.userSettings.findUniqueOrThrow({ where: { userId: 'default' } });
  return row.deepgramApiKeyEncrypted;
}

it('stores a saved key and reports it only as hasApiKey', async () => {
  const saved = await voice.updateConfig({ enabled: true, apiKey: 'dg_secret' });

  expect(saved).toMatchObject({ enabled: true, hasApiKey: true });
  expect(await storedKey()).toBe('encrypted:dg_secret');
  await expect(voice.getConfig()).resolves.toMatchObject({ enabled: true, hasApiKey: true });
  expect(JSON.stringify(await settings.get())).not.toContain('dg_secret');
});

it('keeps the stored key when the voice form saves without one', async () => {
  await voice.updateConfig({ enabled: true, apiKey: 'dg_secret' });

  const saved = await voice.updateConfig({ ttsSpeed: 1.25 });

  expect(saved).toMatchObject({ hasApiKey: true, ttsSpeed: 1.25 });
  expect(await storedKey()).toBe('encrypted:dg_secret');
});

it('reports no key on a first read', async () => {
  await expect(voice.getConfig()).resolves.toMatchObject({ enabled: false, hasApiKey: false });
});

it('mints a grant token with the stored key', async () => {
  await voice.updateConfig({ enabled: true, apiKey: 'dg_secret' });
  const fetchMock = vi.fn(async () =>
    Response.json({ access_token: 'grant-token', expires_in: 600 })
  );
  vi.stubGlobal('fetch', fetchMock);

  await expect(voice.mintGrantToken()).resolves.toEqual({
    accessToken: 'grant-token',
    expiresInSeconds: 600,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://api.deepgram.com/v1/auth/grant',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Token dg_secret' }),
    })
  );
});
