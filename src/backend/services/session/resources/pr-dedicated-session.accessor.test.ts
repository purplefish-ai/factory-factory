import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { prDedicatedSessionAccessor } from '@/backend/services/session/resources/pr-dedicated-session.accessor';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

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
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'w',
      projectId: 'project',
      name: 'Workspace',
      status: 'READY',
      worktreePath: '/tmp/worktree',
      prs: {
        create: [
          { id: 'a', url: 'https://github.com/o/r/pull/1' },
          { id: 'b', url: 'https://github.com/o/r/pull/2' },
        ],
      },
      prMonitoring: { create: { enabled: true, deliveryMode: 'DEDICATED', bindingRevision: 4 } },
    },
  });
});
const input = {
  workspaceId: 'w',
  prId: 'a',
  provider: 'CLAUDE' as const,
  model: 'sonnet',
  maxSessions: 5,
  expectedBindingRevision: 4,
};
it('atomically creates one binding for concurrent wakes of the same PR', async () => {
  const results = await Promise.all([
    prDedicatedSessionAccessor.acquire(input),
    prDedicatedSessionAccessor.acquire(input),
  ]);
  expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'reused']);
  expect(await db.prisma.agentSession.count()).toBe(1);
  expect(await db.prisma.workspacePRDedicatedSession.count()).toBe(1);
});
it('enforces the shared workspace limit across independent PRs and human acquisition', async () => {
  const results = await Promise.all([
    prDedicatedSessionAccessor.acquire({ ...input, maxSessions: 1 }),
    prDedicatedSessionAccessor.acquire({ ...input, prId: 'b', maxSessions: 1 }),
    agentSessionAccessor.createWithinWorkspaceLimit({
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      model: 'sonnet',
      maxSessions: 1,
    }),
  ]);
  expect(results.filter((result) => result.outcome === 'created')).toHaveLength(1);
  expect(results.filter((result) => result.outcome === 'limit_reached')).toHaveLength(2);
  expect(await db.prisma.agentSession.count()).toBe(1);
});
it('reuses a cold saved identity despite different defaults and a full cap', async () => {
  const first = await prDedicatedSessionAccessor.acquire(input);
  if (first.outcome !== 'created') {
    throw new Error('Expected creation');
  }
  await db.prisma.agentSession.update({
    where: { id: first.session.id },
    data: { providerSessionId: 'saved', status: 'FAILED' },
  });
  const reused = await prDedicatedSessionAccessor.acquire({
    ...input,
    provider: 'CODEX',
    model: 'default',
    maxSessions: 0,
  });
  expect(reused).toMatchObject({
    outcome: 'reused',
    session: {
      id: first.session.id,
      provider: 'CLAUDE',
      providerSessionId: 'saved',
      status: 'FAILED',
    },
  });
});
it.each(['missing', 'detached', 'inactive', 'disabled', 'stale', 'stopped'] as const)(
  'does not acquire for %s ownership or monitoring',
  async (reason) => {
    if (reason === 'detached') {
      await db.prisma.workspacePR.update({ where: { id: 'a' }, data: { detachedAt: new Date() } });
    }
    if (reason === 'inactive') {
      await db.prisma.workspace.update({ where: { id: 'w' }, data: { status: 'ARCHIVED' } });
    }
    if (reason === 'disabled') {
      await db.prisma.workspacePRMonitoring.update({
        where: { workspaceId: 'w' },
        data: { enabled: false },
      });
    }
    if (reason === 'stopped') {
      await db.prisma.workspacePRMonitoring.update({
        where: { workspaceId: 'w' },
        data: { deliveryPauseReason: 'USER_STOPPED' },
      });
    }
    expect(
      await prDedicatedSessionAccessor.acquire({
        ...input,
        prId: reason === 'missing' ? 'missing' : 'a',
        expectedBindingRevision: reason === 'stale' ? 3 : 4,
      })
    ).toEqual({ outcome: 'unavailable' });
    expect(await db.prisma.agentSession.count()).toBe(0);
  }
);
it.each([3, 4, 5])(
  'rolls back acquisition when a stop advances at checkpoint %s',
  async (checkpoint) => {
    let checks = 0;
    expect(
      await prDedicatedSessionAccessor.acquire({ ...input, isCurrent: () => ++checks < checkpoint })
    ).toEqual({ outcome: 'unavailable' });
    expect(await db.prisma.agentSession.count()).toBe(0);
  }
);
it('clears a deleted session binding and acquires a new future recipient', async () => {
  const first = await prDedicatedSessionAccessor.acquire(input);
  if (first.outcome !== 'created') {
    throw new Error('Expected creation');
  }
  await db.prisma.agentSession.delete({ where: { id: first.session.id } });
  expect(
    await db.prisma.workspacePRDedicatedSession.findUnique({ where: { prId: 'a' } })
  ).toMatchObject({ sessionId: null });
  expect(await prDedicatedSessionAccessor.acquire(input)).toMatchObject({ outcome: 'created' });
});
it('restores nullable bindings and rejects foreign session workflow or PR ownership', async () => {
  expect(
    await db.prisma.$transaction((tx) =>
      prDedicatedSessionAccessor.restore(tx, { workspaceId: 'w', prId: 'a', sessionId: null })
    )
  ).toBe(true);
  await db.prisma.agentSession.create({
    data: {
      id: 'human',
      workspaceId: 'w',
      workflow: 'implement',
      provider: 'CLAUDE',
      model: 'sonnet',
      workspacePrId: 'a',
    },
  });
  expect(
    await db.prisma.$transaction((tx) =>
      prDedicatedSessionAccessor.restore(tx, { workspaceId: 'w', prId: 'a', sessionId: 'human' })
    )
  ).toBe(false);
  await db.prisma.agentSession.update({
    where: { id: 'human' },
    data: { workflow: 'pr-monitoring', workspacePrId: 'b' },
  });
  expect(
    await db.prisma.$transaction((tx) =>
      prDedicatedSessionAccessor.restore(tx, { workspaceId: 'w', prId: 'a', sessionId: 'human' })
    )
  ).toBe(false);
  expect(
    await db.prisma.$transaction((tx) =>
      prDedicatedSessionAccessor.restore(tx, { workspaceId: 'foreign', prId: 'a', sessionId: null })
    )
  ).toBe(false);
  await db.prisma.agentSession.update({ where: { id: 'human' }, data: { workspacePrId: 'a' } });
  expect(
    await db.prisma.$transaction((tx) =>
      prDedicatedSessionAccessor.restore(tx, { workspaceId: 'w', prId: 'a', sessionId: 'human' })
    )
  ).toBe(true);
  expect(await prDedicatedSessionAccessor.find({ workspaceId: 'w', prId: 'a' })).toMatchObject({
    id: 'human',
    workspacePrId: 'a',
  });
});
it('does not treat a detached PR binding as an active recipient', async () => {
  await prDedicatedSessionAccessor.acquire(input);
  await db.prisma.workspacePR.update({ where: { id: 'a' }, data: { detachedAt: new Date() } });
  expect(await prDedicatedSessionAccessor.find({ workspaceId: 'w', prId: 'a' })).toBeNull();
});

it('serializes actual adapter transactions across different workspace acquisition queues', async () => {
  await db.prisma.workspace.create({
    data: {
      id: 'other',
      projectId: 'project',
      name: 'Other',
      status: 'READY',
      worktreePath: '/tmp/other',
      prs: { create: { id: 'other-pr', url: 'https://github.com/o/r/pull/3' } },
      prMonitoring: { create: { enabled: true, deliveryMode: 'DEDICATED', bindingRevision: 4 } },
    },
  });
  const result = await Promise.all([
    prDedicatedSessionAccessor.acquire(input),
    prDedicatedSessionAccessor.acquire({ ...input, workspaceId: 'other', prId: 'other-pr' }),
  ]);
  expect(result.map((item) => item.outcome)).toEqual(['created', 'created']);
  expect(await db.prisma.agentSession.count()).toBe(2);
  expect(await db.prisma.workspacePRDedicatedSession.count()).toBe(2);
});
it.each([false, true])(
  'rejects empty restored session ID even when an ordinary empty ID exists: %s',
  async (existing) => {
    if (existing) {
      await db.prisma.agentSession.create({
        data: {
          id: '',
          workspaceId: 'w',
          workflow: 'implement',
          provider: 'CLAUDE',
          model: 'sonnet',
        },
      });
    }
    expect(
      await db.prisma.$transaction((tx) =>
        prDedicatedSessionAccessor.restore(tx, {
          workspaceId: 'w',
          prId: 'a',
          sessionId: '',
        })
      )
    ).toBe(false);
    expect(await db.prisma.workspacePRDedicatedSession.count()).toBe(0);
  }
);
