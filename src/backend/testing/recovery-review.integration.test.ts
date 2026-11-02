import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { configService } from '@/backend/services/config.service';
import { type PrismaClient } from '@prisma-gen/client';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing test DB');
    }
    return database.prisma;
  },
}));
let db: IntegrationDatabase;
beforeEach(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  vi.spyOn(configService, 'getBaseDir').mockReturnValue(db.tempDir);
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Recovery',
      slug: 'recovery',
      repoPath: '/test',
      worktreeBasePath: '/test-trees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'workspace', projectId: 'project', name: 'Recovery' },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'session',
      workspaceId: 'workspace',
      workflow: 'default',
      model: 'default',
      provider: 'CODEX',
    },
  });
}, 30_000);
afterEach(async () => {
  await destroyIntegrationDatabase(db);
});

it('never admits an imported matched decision after reenable and evaluation worker restart', async () => {
  const runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  const { createLedgerFixture } = await vi.importActual<
    typeof import('@/backend/services/agent-definition/resources/testing/agent-ledger.test-support')
  >('@/backend/services/agent-definition/resources/testing/agent-ledger.test-support');
  const fixture = await createLedgerFixture(db, runtime);
  const eventId = await fixture.event();
  await fixture.evaluation(eventId);
  const original = await db.prisma.agentEvaluation.findFirstOrThrow();
  expect(original).toMatchObject({ status: 'MATCHED', runId: null });
  const backup = await dataBackupService.exportData('test');
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await dataBackupService.importData(backup);
  await db.prisma.agentDefinition.updateMany({ data: { isEnabled: true } });
  await db.prisma.agentConnection.updateMany({ data: { isEnabled: true } });
  await db.prisma.agentTrigger.updateMany({ data: { isEnabled: true, activationState: 'ACTIVE' } });
  await db.prisma.agentSourceState.updateMany({ data: { isReady: true } });
  for (let i = 0; i < 2; i++) {
    const evaluator = new runtime.AgentEventEvaluationService({
      resolveExecution: () => Promise.reject(new Error('Imported decision must remain held')),
    });
    await evaluator.evaluatePendingEvents(new AbortController().signal);
  }
  expect(await db.prisma.agentRun.count()).toBe(0);
  expect(await db.prisma.agentEvaluation.findUnique({ where: { id: original.id } })).toMatchObject({
    status: 'SKIPPED',
    reasonCode: 'IMPORTED_MATCHED_REQUIRES_REVIEW',
    configurationSnapshot: original.configurationSnapshot,
    classifier: original.classifier,
    explanation: expect.stringContaining(original.explanation),
  });
});
it('does not attach imported decisions to a colliding local session but retains deleted-session history', async () => {
  await db.prisma.decisionLog.createMany({
    data: [
      {
        id: 'foreign-decision',
        agentId: 'session',
        decision: 'source decision',
        reasoning: 'source reasoning',
      },
      {
        id: 'deleted-decision',
        agentId: 'deleted-session',
        decision: 'retained decision',
        reasoning: 'retained reasoning',
      },
    ],
  });
  const backup = await dataBackupService.exportData('test');
  await db.prisma.decisionLog.deleteMany();
  // The local session survives and must not receive history from the skipped source session.
  await dataBackupService.importData(backup);
  expect(await db.prisma.decisionLog.findUnique({ where: { id: 'foreign-decision' } })).toBeNull();
  expect(
    await db.prisma.decisionLog.findUnique({ where: { id: 'deleted-decision' } })
  ).toMatchObject({ reasoning: 'retained reasoning' });
});
it('skips colliding lifecycle deduplication identities without aborting other additive history', async () => {
  const row = {
    workspaceId: 'workspace',
    sessionId: 'deleted-session',
    kind: 'TURN_INTERRUPTED' as const,
    reason: 'PROVIDER_ERROR' as const,
    message: 'retained interruption',
    dedupeKey: 'same-effect',
  };
  await db.prisma.sessionLifecycleEvent.create({ data: { ...row, id: 'source-event' } });
  const backup = await dataBackupService.exportData('test');
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.sessionLifecycleEvent.deleteMany();
  // Retained events can outlive their session, while the workspace FK remains local.
  await db.prisma.project.create({
    data: {
      id: 'local-project',
      name: 'Local',
      slug: 'local',
      repoPath: '/local',
      worktreeBasePath: '/local-trees',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'old-local-workspace', projectId: 'local-project', name: 'Local' },
  });
  await db.prisma.sessionLifecycleEvent.create({
    data: { ...row, id: 'local-event', workspaceId: 'old-local-workspace', message: 'keep local' },
  });
  const result = await dataBackupService.importData(backup);
  expect(result.recovery.skipped).toContainEqual({
    model: 'SessionLifecycleEvent',
    identity: 'source-event',
    reason: 'CONFLICTING_IDENTITY_OR_PARENT',
  });
  expect(await db.prisma.project.count()).toBe(2);
  expect(await db.prisma.sessionLifecycleEvent.findMany()).toEqual([
    expect.objectContaining({ id: 'local-event', message: 'keep local' }),
  ]);
});

it('discards forged unfinished validation progress while retaining checkpoint heads and verification evidence', async () => {
  await db.prisma.agentConnection.create({
    data: { id: 'source', provider: 'GITHUB', externalId: 'proof', name: 'proof' },
  });
  await db.prisma.agentSourceState.create({ data: { connectionId: 'source', lastSourceOrder: 1 } });
  await db.prisma.agentSourceCheckpoint.create({
    data: {
      connectionId: 'source',
      scanId: 'scan',
      status: 'INDEXED',
      nextOrdinal: 1,
      entryCount: 1,
      executableCount: 1,
      verifiedCount: 1,
      verification: { retained: 'evidence' },
      headEventId: 'head',
      boundaryKnown: true,
      initialSourceOrder: 0,
      sourceOrder: 1,
    },
  });
  await db.prisma.agentSourceHead.create({
    data: {
      connectionId: 'source',
      scanId: 'scan',
      providerEventId: 'head',
      position: 0,
      precedingEventCount: 0,
    },
  });
  await db.prisma.agentSourcePage.create({
    data: {
      id: 'marker',
      connectionId: 'source',
      scanId: 'scan',
      ordinal: 0,
      phase: 'FINALIZED',
      requestPage: 1,
      sourceOrder: 1,
      evidence: { ids: ['head'], entries: [] },
    },
  });
  const backup = await dataBackupService.exportData('test');
  const durable = backup.data.durable!;
  durable.agentSourceCheckpoint[0]!.validationCursor = {
    version: 2,
    revision: durable.agentSourceState[0]!.authorityRevision,
    phase: 'BASELINES',
    scanId: 'zzzz',
    position: 999,
    baselineId: 'zzzz',
    headCount: 1,
    boundaryWitnessed: true,
  };
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await dataBackupService.importData(backup);
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
    status: 'INDEXED',
    validationCursor: null,
    verification: { retained: 'evidence' },
  });
  expect(await db.prisma.agentSourceHead.count()).toBe(1);
});

it('replays unfinished verification instead of skipping contradictory retained pages using imported progress', async () => {
  const runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  const { createLedgerFixture } = await vi.importActual<
    typeof import('@/backend/services/agent-definition/resources/testing/agent-ledger.test-support')
  >('@/backend/services/agent-definition/resources/testing/agent-ledger.test-support');
  const fixture = await createLedgerFixture(db, runtime);
  const connectionId = fixture.connectionId;
  await db.prisma.agentSourceState.update({
    where: { connectionId },
    data: { cursor: { version: 1, provider: 'GITHUB', committedHeadEventId: 'A', scan: null } },
  });
  await db.prisma.agentSourceCheckpoint.create({
    data: {
      connectionId,
      scanId: 'forged',
      status: 'BUILDING',
      nextOrdinal: 3,
      entryCount: 2,
      executableCount: 0,
      verifiedCount: 2,
      verification: {
        version: 1,
        nextPage: 2,
        resumePage: 1,
        resumeCount: 0,
        seekingOverlap: false,
      },
      headEventId: 'A',
      boundaryKnown: true,
      initialSourceOrder: 0,
      sourceOrder: 0,
    },
  });
  await db.prisma.agentSourceHead.createMany({
    data: ['A', 'B'].map((providerEventId, position) => ({
      connectionId,
      scanId: 'forged',
      providerEventId,
      position,
      precedingEventCount: 0,
    })),
  });
  await db.prisma.agentSourcePage.createMany({
    data: [
      {
        id: 'capture',
        connectionId,
        scanId: 'forged',
        ordinal: 0,
        phase: 'CAPTURE',
        requestPage: 1,
        nextPage: null,
        evidence: {
          ids: ['A', 'B'],
          entries: [
            { providerEventId: 'A', eventId: null },
            { providerEventId: 'B', eventId: null },
          ],
        },
      },
      {
        id: 'verify1',
        connectionId,
        scanId: 'forged',
        ordinal: 1,
        phase: 'VERIFY',
        requestPage: 1,
        nextPage: 2,
        evidence: { ids: ['A'], entries: [] },
      },
      {
        id: 'verify2',
        connectionId,
        scanId: 'forged',
        ordinal: 2,
        phase: 'VERIFY',
        requestPage: 2,
        nextPage: null,
        evidence: { ids: ['X', 'B'], entries: [] },
      },
      {
        id: 'final',
        connectionId,
        scanId: 'forged',
        ordinal: 3,
        phase: 'FINALIZED',
        requestPage: 1,
        nextPage: null,
        sourceOrder: 0,
        evidence: { ids: ['A'], entries: [] },
      },
    ],
  });
  const backup = await dataBackupService.exportData('test');
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await dataBackupService.importData(backup);
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({
    status: 'BUILDING',
    nextOrdinal: 0,
    entryCount: 0,
    executableCount: 0,
    verifiedCount: 0,
    verification: null,
    validationCursor: null,
    headEventId: 'A',
    boundaryKnown: true,
    previousBoundaryEventId: null,
    initialSourceOrder: 0,
    sourceOrder: 0,
  });
  expect(
    await db.prisma
      .$queryRaw`SELECT json_type(verification) AS verificationType, json_type(validationCursor) AS cursorType FROM AgentSourceCheckpoint WHERE scanId = 'forged'`
  ).toEqual([{ verificationType: null, cursorType: null }]);
  expect(await db.prisma.agentSourceHead.count()).toBe(2);
  expect(await db.prisma.agentSourcePage.count()).toBe(4);
  await db.prisma.agentDefinition.updateMany({ data: { isEnabled: true } });
  await db.prisma.agentConnection.updateMany({ data: { isEnabled: true } });
  await db.prisma.agentTrigger.updateMany({ data: { isEnabled: true, activationState: 'ACTIVE' } });
  const source = new runtime.AgentSourcePollService(
    {
      getRepositoryIdentity: () => Promise.resolve({ id: 'repo-1', name: 'org/repo' }),
      listIssueEvents: () => Promise.reject(new Error('No provider reads required')),
      classifyError: () => 'unknown',
    },
    () => 0
  );
  for (let tick = 0; tick < 5; tick++) {
    await source.pollCycle(new AbortController().signal);
  }
  expect(await db.prisma.agentSourceCheckpoint.findFirst()).toMatchObject({ status: 'INVALID' });
  expect(await db.prisma.agentSourcePage.count()).toBe(4);
  expect(await db.prisma.agentSourceHead.count()).toBe(2);
});
