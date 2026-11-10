import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';
import { agentSessionAccessor } from './agent-session.accessor';
import { prDedicatedSessionAccessor } from './pr-dedicated-session.accessor';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));

// Session reads run per message and on polls; none of them may load the
// workspace's base64 attachments or startup log.
const providerMetadata = { configSnapshot: { blob: 'x'.repeat(64 * 1024) } };

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
      status: 'READY',
      worktreePath: '/tmp/w/w',
      defaultSessionProvider: 'CODEX',
      initOutput: 'installing...\n'.repeat(3000),
      creationMetadata: { initialAttachments: [{ data: 'A'.repeat(2 * 1024 * 1024) }] },
      agentSessions: {
        create: { id: 's', workflow: 'implement', provider: 'CLAUDE', providerMetadata },
      },
      prs: {
        create: {
          id: 'pr',
          url: 'https://github.com/o/r/pull/1',
          observation: { reviews: [{ body: 'r'.repeat(64 * 1024) }] },
        },
      },
    },
  });
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('joins only the workspace fields session reads use', async () => {
  const session = await agentSessionAccessor.findById('s');

  expect(session?.workspace).toEqual({
    status: 'READY',
    worktreePath: '/tmp/w/w',
    initErrorMessage: null,
  });
  expect(session?.providerMetadata).toEqual(providerMetadata);
});

it('lists workspace sessions without provider metadata', async () => {
  const sessions = await agentSessionAccessor.findByWorkspaceId('w');

  expect(sessions).toEqual([expect.objectContaining({ id: 's', workflow: 'implement' })]);
  expect(sessions[0]).not.toHaveProperty('providerMetadata');
});

it('reads only the provider default of a PR-dedicated session workspace', async () => {
  await expect(
    prDedicatedSessionAccessor.findWorkspace({ workspaceId: 'w', prId: 'pr' })
  ).resolves.toEqual({ defaultSessionProvider: 'CODEX' });
  await expect(
    prDedicatedSessionAccessor.findWorkspace({ workspaceId: 'w', prId: 'missing' })
  ).resolves.toBeNull();
});
