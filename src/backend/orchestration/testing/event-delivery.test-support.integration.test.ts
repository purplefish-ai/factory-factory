import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { preloadEventFixtureModules } from './event-delivery.test-support';

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('restores the database a suite had bound before preloading', async () => {
  const databasePath = process.env.DATABASE_PATH;
  await preloadEventFixtureModules();
  // Compare identities as booleans: printing a Prisma client overflows the stack.
  expect(globalThis.prismaGlobal === db.prisma).toBe(true);
  expect(process.env.DATABASE_PATH).toBe(databasePath);
  const { prisma } = await vi.importActual<typeof import('@/backend/db')>('@/backend/db');
  expect(prisma === db.prisma).toBe(true);
  await expect(prisma.project.count()).resolves.toBe(0);
}, 30_000);
