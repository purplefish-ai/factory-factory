import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';
import { terminalSessionAccessor } from './terminal-session.accessor';

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
  await db.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'w',
      projectId: 'p',
      name: 'W',
      initOutput: 'installing...\n'.repeat(3000),
      creationMetadata: { initialAttachments: [{ data: 'A'.repeat(2 * 1024 * 1024) }] },
      terminalSessions: { create: { id: 't', name: 'shell' } },
    },
  });
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('joins the workspace without its startup log or creation metadata', async () => {
  const session = await terminalSessionAccessor.findById('t');

  expect(session).toMatchObject({ id: 't', workspace: { id: 'w', name: 'W' } });
  expect(session?.workspace).not.toHaveProperty('initOutput');
  expect(session?.workspace).not.toHaveProperty('creationMetadata');
  expect(JSON.stringify(session).length).toBeLessThan(16 * 1024);
});
