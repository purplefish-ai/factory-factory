import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';
import { workspaceDetailReadAccessor } from './workspace-detail-read.accessor';
import { workspaceAccessor } from './workspace.accessor';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));

// A ~360 KB base64 image, the size of one attachment on a live workspace.
const attachmentData = 'A'.repeat(360 * 1024);

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'p',
      name: 'P',
      slug: 'p',
      repoPath: '/tmp/p',
      worktreeBasePath: '/tmp/w',
      defaultBranch: 'trunk',
      startupScriptCommand: 'pnpm install',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'w',
      projectId: 'p',
      name: 'Attachments',
      status: 'READY',
      worktreePath: '/tmp/w/attachments',
      initOutput: 'installing...\n'.repeat(1000),
      creationMetadata: {
        initialPrompt: 'Describe this screenshot',
        initialAttachments: [
          { id: 'a', name: 'shot.png', type: 'image/png', size: 1, data: attachmentData },
        ],
      },
      agentSessions: {
        create: {
          id: 's',
          workflow: 'implement',
          provider: 'CLAUDE',
          providerMetadata: { configSnapshot: { blob: 'x'.repeat(4096) } },
        },
      },
    },
  });
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('reads workspace detail without creation metadata, init output or provider metadata', async () => {
  const full = await workspaceAccessor.findById('w');
  const detail = await workspaceDetailReadAccessor.findDetailById('w');

  expect(detail).toMatchObject({
    id: 'w',
    name: 'Attachments',
    worktreePath: '/tmp/w/attachments',
    initialPrompt: 'Describe this screenshot',
    agentSessions: [expect.objectContaining({ id: 's', workflow: 'implement' })],
  });
  expect(detail).not.toHaveProperty('creationMetadata');
  expect(detail).not.toHaveProperty('initOutput');
  expect(detail?.agentSessions[0]).not.toHaveProperty('providerMetadata');

  // Detail keeps every other field the full read returns.
  const {
    creationMetadata: _creationMetadata,
    initOutput: _initOutput,
    agentSessions: fullSessions,
    ...fullRest
  } = full!;
  const { initialPrompt: _initialPrompt, agentSessions: detailSessions, ...detailRest } = detail!;
  expect(detailRest).toEqual(fullRest);
  expect(detailSessions).toEqual(
    fullSessions.map(({ providerMetadata: _providerMetadata, ...session }) => session)
  );

  const fullBytes = JSON.stringify(full).length;
  const detailBytes = JSON.stringify(detail).length;
  expect(fullBytes).toBeGreaterThan(360 * 1024);
  expect(detailBytes).toBeLessThan(16 * 1024);
});

it('reads no initial prompt from metadata without one', async () => {
  await db.prisma.workspace.create({
    data: { id: 'bare', projectId: 'p', name: 'Bare', creationMetadata: { initialPrompt: 7 } },
  });
  await expect(workspaceDetailReadAccessor.findDetailById('bare')).resolves.toMatchObject({
    initialPrompt: null,
  });
  await expect(workspaceDetailReadAccessor.findDetailById('missing')).resolves.toBeNull();
});

it('reads the narrow worktree context and init status', async () => {
  await expect(workspaceDetailReadAccessor.findWorktreeContext('w')).resolves.toEqual({
    id: 'w',
    worktreePath: '/tmp/w/attachments',
    project: { defaultBranch: 'trunk' },
  });
  await expect(workspaceDetailReadAccessor.findWorktreeContext('missing')).resolves.toBeNull();

  const status = await workspaceDetailReadAccessor.findInitStatus('w');
  expect(status).toMatchObject({
    id: 'w',
    projectId: 'p',
    status: 'READY',
    worktreePath: '/tmp/w/attachments',
    initOutput: 'installing...\n'.repeat(1000),
    initRetryCount: 0,
    project: { startupScriptCommand: 'pnpm install', startupScriptPath: null },
  });
  expect(status).not.toHaveProperty('creationMetadata');
  await expect(workspaceDetailReadAccessor.findInitStatus('missing')).resolves.toBeNull();
});
