import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { Prisma, PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({
  prisma: undefined as PrismaClient | undefined,
  scanned: [] as string[],
}));
function prisma() {
  if (!state.prisma) {
    throw new Error('Missing test database');
  }
  return state.prisma;
}
vi.mock('@/backend/db', () => ({
  get prisma() {
    return prisma();
  },
}));
vi.mock('@/backend/services/session', () => ({
  sessionDataService: {
    findAgentSessionsByWorkspaceId: (workspaceId: string) => {
      state.scanned.push(workspaceId);
      return prisma().agentSession.findMany({ where: { workspaceId } });
    },
    findAgentSessionById: (id: string) => prisma().agentSession.findUnique({ where: { id } }),
    findClosedSessionsByWorkspaceId: (workspaceId: string, take: number) =>
      prisma().closedSession.findMany({ where: { workspaceId }, take }),
  },
  // Simulates the real retirement: the fixer row becomes a closed transcript.
  sessionLifecycleService: {
    stopSession: async (sessionId: string) => {
      const session = await prisma().agentSession.delete({ where: { id: sessionId } });
      await prisma().closedSession.create({ data: closedSession(session.workspaceId, sessionId) });
    },
  },
}));

import { retireLegacyRatchetSessions } from './pr-monitoring-cutover.orchestrator';
import { createPRMonitoringTestServices } from './testing/pr-monitoring-services.test-support';

function closedSession(workspaceId: string, sessionId: string) {
  return {
    workspaceId,
    sessionId,
    workflow: 'ratchet',
    provider: 'CLAUDE' as const,
    model: 'sonnet',
    transcriptPath: `${sessionId}.json`,
    startedAt: new Date(0),
  };
}

let db: IntegrationDatabase;
async function seed(
  id: string,
  monitoring: Omit<Prisma.WorkspacePRMonitoringUncheckedCreateInput, 'workspaceId'>,
  workflows: string[] = ['implement']
) {
  await db.prisma.workspace.create({
    data: { id, projectId: 'project', name: id, status: 'ARCHIVED' },
  });
  await db.prisma.workspacePRMonitoring.create({
    data: { workspaceId: id, bindingRevision: 5, ...monitoring },
  });
  for (const [index, workflow] of workflows.entries()) {
    await db.prisma.agentSession.create({
      data: {
        id: `${id}-${workflow}-${index}`,
        workspaceId: id,
        workflow,
        provider: 'CLAUDE',
        model: 'sonnet',
      },
    });
  }
}
async function monitoring(workspaceId: string) {
  const row = await db.prisma.workspacePRMonitoring.findUniqueOrThrow({ where: { workspaceId } });
  return { bindingRevision: row.bindingRevision, deliveryPauseReason: row.deliveryPauseReason };
}

beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
  // No-op rows: nothing retained, no legacy fence, and no live fixer.
  await seed('noop', {});
  await seed('noop-explicit', { legacySessionIds: [] });
  await seed('user-stopped', { deliveryPauseReason: 'USER_STOPPED' });
  // Rows that still need the cutover.
  await seed('retained', { legacySessionIds: ['old-fixer'] });
  await db.prisma.closedSession.create({ data: closedSession('retained', 'old-fixer') });
  await seed('fenced', { deliveryPauseReason: 'LEGACY_FIXER' });
  await seed('fenced-stopped', { deliveryPauseReason: 'LEGACY_FIXER_USER_STOPPED' });
  await seed('live', {}, ['implement', 'ratchet']);
  await seed('missing', { legacySessionIds: ['gone'] });
  await seed('corrupt', { legacySessionIds: { bad: true } });
}, 30_000);
afterAll(async () => {
  if (db) {
    await destroyIntegrationDatabase(db);
  }
});

it('retires legacy fixers without visiting rows that cannot need retirement', async () => {
  const result = await retireLegacyRatchetSessions(createPRMonitoringTestServices());

  expect(result.retired).toBe(1);
  expect([...result.blockedWorkspaceIds].sort()).toEqual(['corrupt', 'missing']);
  expect([...state.scanned].sort()).toEqual([
    'corrupt',
    'fenced',
    'fenced-stopped',
    'live',
    'missing',
    'retained',
  ]);
  expect(await monitoring('noop')).toEqual({ bindingRevision: 5, deliveryPauseReason: null });
  expect(await monitoring('noop-explicit')).toEqual({
    bindingRevision: 5,
    deliveryPauseReason: null,
  });
  expect(await monitoring('user-stopped')).toEqual({
    bindingRevision: 5,
    deliveryPauseReason: 'USER_STOPPED',
  });
  expect(await monitoring('retained')).toEqual({ bindingRevision: 5, deliveryPauseReason: null });
  expect(await monitoring('fenced')).toEqual({ bindingRevision: 6, deliveryPauseReason: null });
  expect(await monitoring('fenced-stopped')).toEqual({
    bindingRevision: 6,
    deliveryPauseReason: 'USER_STOPPED',
  });
  expect(await monitoring('live')).toEqual({ bindingRevision: 7, deliveryPauseReason: null });
  expect(await db.prisma.agentSession.count({ where: { workflow: 'ratchet' } })).toBe(0);
  expect(await monitoring('missing')).toEqual({
    bindingRevision: 6,
    deliveryPauseReason: 'LEGACY_FIXER',
  });
  expect(await monitoring('corrupt')).toEqual({
    bindingRevision: 6,
    deliveryPauseReason: 'LEGACY_FIXER',
  });
});

it('converges so a second startup only revisits retained or still-blocked rows', async () => {
  state.scanned = [];
  const result = await retireLegacyRatchetSessions(createPRMonitoringTestServices());

  expect(result.retired).toBe(0);
  expect([...result.blockedWorkspaceIds].sort()).toEqual(['corrupt', 'missing']);
  expect([...state.scanned].sort()).toEqual(['corrupt', 'missing', 'retained']);
});
