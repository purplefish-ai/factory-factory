import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { periodicTaskAccessor } from '@/backend/services/periodic-task/resources/periodic-task.accessor';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import fixed from '@/shared/testing/recovery-periodic-config-v8.fixture.json';
import type { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
}, 30_000);
afterEach(() => vi.useRealTimers());
afterAll(async () => destroyIntegrationDatabase(db));

it('cannot reserve a past-due configuration imported disabled through the public backup service', async () => {
  await dataBackupService.importData(exportDataSchema.parse(fixed));
  const task = await db.prisma.periodicTask.findUniqueOrThrow({
    where: { id: 'scheduled-maintenance' },
  });
  expect(task.isEnabled).toBe(false);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
  expect(task.nextRunAt.getTime()).toBeLessThan(Date.now());
  expect(await periodicTaskAccessor.reserveExecutionAndMarkDispatched(task.id)).toBeNull();
  expect(await db.prisma.periodicTaskExecution.count()).toBe(0);
  expect(await db.prisma.periodicTask.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
});
