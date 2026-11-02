import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { configService } from '@/backend/services/config.service';
import { getClosedSessionArchiveKey } from '@/backend/services/session/service/lifecycle/closed-session-identity';
import { closedSessionTranscriptSchema } from '@/shared/schemas/closed-session-transcript.schema';
import { Prisma, type PrismaClient } from '@prisma-gen/client';
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
async function roundtrip() {
  const backup = await dataBackupService.exportData('test');
  await db.prisma.chatIntent.deleteMany();
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await dataBackupService.importData(backup);
  return backup;
}
it('retains complete ordered prompt attempts, original submitted settings and frozen provider identity without enqueueing', async () => {
  const settings = {
    selectedModel: 'original',
    reasoningEffort: null,
    thinkingEnabled: false,
    planModeEnabled: false,
  };
  const submitted = {
    id: 'message',
    text: 'original request',
    timestamp: '2026-01-01T00:00:00.000Z',
    settings,
  };
  const members = [
    { messageId: 'message', owner: 'human', message: submitted },
    {
      messageId: 'external',
      owner: 'external',
      message: { ...submitted, id: 'external', text: 'background' },
    },
  ];
  const providerIdentity = {
    provider: 'CODEX',
    providerSessionId: 'conversation',
    codexAccountId: 'original-external-account',
  };
  await db.prisma.promptDispatchAttempt.create({
    data: {
      id: 'attempt',
      sessionId: 'session',
      members,
      content: 'frozen prompt',
      effectiveSettings: { ...settings, selectedModel: 'later' },
      providerIdentity,
      sendGeneration: 19,
      status: 'uncertain',
      evidence: 'provider result unavailable',
    },
  });
  await db.prisma.chatIntent.create({
    data: {
      id: 42,
      sessionId: 'session',
      messageId: 'message',
      fingerprint: createHash('sha256')
        .update(JSON.stringify({ ...submitted, timestamp: undefined }))
        .digest('hex'),
      submitted,
      desired: { ...settings, selectedModel: 'later' },
      revision: 3,
      status: 'uncertain',
      attemptId: 'attempt',
    },
  });
  await db.prisma.chatIntent.create({
    data: {
      id: 43,
      sessionId: 'session',
      messageId: 'waiting',
      fingerprint: createHash('sha256')
        .update(JSON.stringify({ ...submitted, id: 'waiting', timestamp: undefined }))
        .digest('hex'),
      submitted: { ...submitted, id: 'waiting' },
      desired: settings,
      status: 'queued',
    },
  });
  await roundtrip();
  expect(
    await db.prisma.promptDispatchAttempt.findUnique({ where: { id: 'attempt' } })
  ).toMatchObject({
    members,
    providerIdentity,
    sendGeneration: 19,
    status: 'uncertain',
    evidence: 'provider result unavailable',
  });
  expect(await db.prisma.chatIntent.findUnique({ where: { id: 42 } })).toMatchObject({
    submitted,
    desired: { ...settings, selectedModel: 'later' },
    revision: 3,
    status: 'uncertain',
    attemptId: 'attempt',
  });
  expect(await db.prisma.chatIntent.count({ where: { status: 'queued' } })).toBe(0);
  expect(await db.prisma.chatIntent.findUnique({ where: { id: 43 } })).toMatchObject({
    status: 'failed',
  });
});
it('retains checkpoint heads, verification cursor, authority revision and issued baseline IDs exactly', async () => {
  await db.prisma.agentConnection.create({
    data: { id: 'connection', provider: 'GITHUB', externalId: 'github:test', name: 'source' },
  });
  await db.prisma.agentSourceState.create({
    data: {
      connectionId: 'connection',
      lastSourceOrder: 1,
      cursor: { version: 1, after: 'head' },
    },
  });
  await db.prisma.agentSourceCheckpoint.create({
    data: {
      connectionId: 'connection',
      scanId: 'scan',
      status: 'COMPLETE',
      nextOrdinal: 2,
      entryCount: 1,
      executableCount: 1,
      verifiedCount: 1,
      verification: { version: 1, seen: ['head'] },
      validationCursor: { revision: 0 },
      headEventId: 'head',
      boundaryKnown: true,
      sourceOrder: 1,
      initialSourceOrder: 0,
    },
  });
  await db.prisma.agentSourceHead.create({
    data: {
      connectionId: 'connection',
      scanId: 'scan',
      providerEventId: 'head',
      position: 0,
      precedingEventCount: 0,
    },
  });
  await db.prisma.agentSourceBaseline.create({
    data: {
      id: 'issued-baseline',
      connectionId: 'connection',
      headEventId: 'head',
      sourceOrder: 1,
    },
  });
  await db.prisma.agentSourceCheckpoint.create({
    data: {
      connectionId: 'connection',
      scanId: 'pending-scan',
      verification: Prisma.JsonNull,
      validationCursor: Prisma.DbNull,
    },
  });
  await db.prisma.agentSourcePage.create({
    data: {
      id: 'source-marker',
      connectionId: 'connection',
      scanId: 'scan',
      ordinal: 1,
      phase: 'FINALIZED',
      requestPage: 1,
      sourceOrder: 1,
      evidence: { ids: ['head'], entries: [] },
    },
  });
  const checkpoint = await db.prisma.agentSourceCheckpoint.findMany();
  const heads = await db.prisma.agentSourceHead.findMany();
  const state = await db.prisma.agentSourceState.findUniqueOrThrow({
    where: { connectionId: 'connection' },
  });
  const baselines = await db.prisma.agentSourceBaseline.findMany();
  await roundtrip();
  expect(await db.prisma.agentSourceCheckpoint.findMany()).toEqual(checkpoint);
  expect(
    await db.prisma
      .$queryRaw`SELECT json_type(verification) AS verificationType, json_type(validationCursor) AS cursorType FROM AgentSourceCheckpoint WHERE scanId = 'pending-scan'`
  ).toEqual([{ verificationType: null, cursorType: null }]);

  expect(await db.prisma.agentSourceHead.findMany()).toEqual(heads);
  expect(await db.prisma.agentSourceBaseline.findMany()).toEqual(baselines);
  expect(
    await db.prisma.agentSourceState.findUnique({ where: { connectionId: 'connection' } })
  ).toMatchObject({ ...state, isReady: false });
});
it('retains atomic expired context markers and expiry time without inventing live context', async () => {
  await db.prisma.agentDefinition.create({
    data: {
      id: 'definition',
      projectId: 'project',
      name: 'Definition',
      instructions: 'current instructions',
    },
  });
  const expiredAt = '2026-01-01T00:00:00.000Z';
  const marker = { version: 1, state: 'EXPIRED', expiredAt };
  await db.prisma.agentRun.create({
    data: {
      id: 'run',
      agentDefinitionId: 'definition',
      idempotencyKey: 'run',
      status: 'COMPLETED',
      launchPhase: 'FINISHED',
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
      contextExpiredAt: new Date(expiredAt),
      definitionSnapshot: marker,
      triggerSnapshot: marker,
      input: marker,
    },
  });
  await roundtrip();
  expect(await db.prisma.agentRun.findUnique({ where: { id: 'run' } })).toMatchObject({
    contextExpiredAt: new Date(expiredAt),
    definitionSnapshot: marker,
    triggerSnapshot: marker,
    input: marker,
    status: 'COMPLETED',
  });
});
it('rejects malformed frozen prompt membership atomically before importing workspace rows', async () => {
  const backup = await dataBackupService.exportData('test');
  if (!backup.data.durable) {
    throw new Error('Missing durable snapshot');
  }
  backup.data.durable.chatIntent.push({
    id: 12,
    sessionId: 'session',
    messageId: 'dangling',
    fingerprint: 'hash',
    submitted: {
      id: 'dangling',
      text: 'original',
      timestamp: new Date().toISOString(),
      settings: {
        selectedModel: null,
        reasoningEffort: null,
        thinkingEnabled: false,
        planModeEnabled: false,
      },
    },
    desired: {
      selectedModel: null,
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
    revision: 0,
    status: 'uncertain',
    attemptId: 'missing-attempt',
    createdAt: new Date().toISOString(),
  });
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(
    /missing or foreign frozen dispatch membership/
  );
  expect(await db.prisma.project.count()).toBe(0);
});
it('rejects a half-expired context instead of recreating executable-looking history', async () => {
  await db.prisma.agentDefinition.create({
    data: {
      id: 'definition',
      projectId: 'project',
      name: 'Definition',
      instructions: 'current instructions',
    },
  });
  const marker = { version: 1, state: 'EXPIRED', expiredAt: '2026-01-01T00:00:00.000Z' };
  await db.prisma.agentRun.create({
    data: {
      id: 'run',
      agentDefinitionId: 'definition',
      idempotencyKey: 'run',
      status: 'COMPLETED',
      launchPhase: 'FINISHED',
      definitionRevision: 1,
      triggerRevision: 1,
      activationGeneration: 1,
      contextExpiredAt: null,
      definitionSnapshot: marker,
      triggerSnapshot: marker,
      input: marker,
    },
  });
  await expect(dataBackupService.exportData('test')).rejects.toThrow(/Expired context/);
});

it.each(['PENDING', 'COMPLETE'])(
  'roundtrips retained %s archive database bytes without a file cache through full logical recovery',
  async (archiveState) => {
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const completedAt = new Date('2026-01-02T00:00:00.000Z');
    const transcript = JSON.stringify({
      version: 1,
      sessionId: 'session',
      workspaceId: 'workspace',
      metadata: {
        name: null,
        workflow: 'default',
        provider: 'CODEX',
        model: 'default',
        codexAccountId: 'frozen-source-account',
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      },
      messages: [
        {
          id: 'first',
          source: 'user',
          timestamp: startedAt.toISOString(),
          order: 0,
          text: 'visible first',
          providerPrompt: [
            { type: 'text', text: 'exact combined provider prompt' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'eA==' } },
          ],
        },
        {
          id: 'second',
          source: 'user',
          timestamp: startedAt.toISOString(),
          order: 1,
          text: 'visible second',
          providerPrompt: null,
        },
      ],
    });
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const transcriptHash = digest(transcript);
    const transcriptPath = `closed-sessions/${digest('workspace')}/archive.${transcriptHash}.json`;
    await db.prisma.closedSession.create({
      data: {
        id: 'archive',
        sessionId: 'session',
        workspaceId: 'workspace',
        workflow: 'default',
        provider: 'CODEX',
        model: 'default',
        startedAt,
        completedAt,
        archiveKey: getClosedSessionArchiveKey({
          workspaceId: 'workspace',
          sessionId: 'session',
          provider: 'CODEX',
          codexAccountId: 'frozen-source-account',
          startedAt,
          messages: closedSessionTranscriptSchema.parse(JSON.parse(transcript)).messages,
        }),
        archiveState,
        pendingTranscript: transcript,
        transcriptHash,
        transcriptPath,
      },
    });
    const backup = await roundtrip();
    expect(backup.data.archives?.entries[0]?.transcript).toBe(transcript);
    expect(await db.prisma.closedSession.findUnique({ where: { id: 'archive' } })).toMatchObject({
      archiveState: 'COMPLETE',
      pendingTranscript: null,
      transcriptHash,
      transcriptPath,
    });
    expect(await readFile(join(db.tempDir, transcriptPath), 'utf8')).toBe(transcript);
    expect((await dataBackupService.exportData('test')).data.archives).toEqual(
      backup.data.archives
    );
  }
);
it('rejects contradictory COMPLETE source proof despite a forged completed validation cursor', async () => {
  await db.prisma.agentConnection.create({
    data: { id: 'connection', provider: 'GITHUB', externalId: 'github:proof', name: 'source' },
  });
  await db.prisma.agentSourceState.create({
    data: { connectionId: 'connection', lastSourceOrder: 1 },
  });
  await db.prisma.agentSourceCheckpoint.create({
    data: {
      connectionId: 'connection',
      scanId: 'scan',
      status: 'COMPLETE',
      entryCount: 1,
      executableCount: 1,
      verifiedCount: 1,
      nextOrdinal: 1,
      headEventId: 'head',
      sourceOrder: 1,
      initialSourceOrder: 0,
      boundaryKnown: true,
    },
  });
  await db.prisma.agentSourceHead.create({
    data: {
      connectionId: 'connection',
      scanId: 'scan',
      providerEventId: 'head',
      position: 0,
      precedingEventCount: 0,
    },
  });
  await db.prisma.agentSourcePage.create({
    data: {
      id: 'marker',
      connectionId: 'connection',
      scanId: 'scan',
      ordinal: 0,
      phase: 'FINALIZED',
      requestPage: 1,
      sourceOrder: 1,
      evidence: { ids: ['head'], entries: [] },
    },
  });
  await db.prisma.agentSourceBaseline.create({
    data: { id: 'baseline', connectionId: 'connection', headEventId: 'head', sourceOrder: 1 },
  });
  const backup = await dataBackupService.exportData('test');
  const durable = backup.data.durable!;
  durable.agentSourceBaseline[0]!.sourceOrder = 0;
  durable.agentSourceCheckpoint[0]!.validationCursor = {
    revision: durable.agentSourceState[0]!.authorityRevision,
    phase: 'BASELINES',
    scanId: 'zzzz',
    position: 999,
    baselineId: 'zzzz',
    headCount: 1,
  };
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await expect(dataBackupService.importData(backup)).rejects.toThrow(/source proof/i);
  expect(await db.prisma.project.count()).toBe(0);
  expect(await db.prisma.agentSourceCheckpoint.count()).toBe(0);
});
it('preserves real compacted source proofs and permanent baseline answers without capture pages', async () => {
  const runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  const { createLedgerFixture } = await vi.importActual<
    typeof import('@/backend/services/agent-definition/resources/testing/agent-ledger.test-support')
  >('@/backend/services/agent-definition/resources/testing/agent-ledger.test-support');
  const fixture = await createLedgerFixture(db, runtime);
  let feed: import('@/shared/agent-source').AgentIssueEventPage['events'] = [];
  const signal = new AbortController().signal;
  const source = new runtime.AgentSourcePollService(
    {
      getRepositoryIdentity: async () => ({ id: 'repo-1', name: 'org/repo' }),
      listIssueEvents: async () => ({ events: feed, nextPage: null }),
      classifyError: () => 'unknown',
    },
    () => 10
  );
  const initial = await source.prepareBaseline(fixture.connectionId, signal);
  feed = [{ providerEventId: 'control-middle', payload: null }];
  const pending = await source.prepareBaseline(fixture.connectionId, signal);
  feed = [
    { providerEventId: 'control-new', payload: null },
    { providerEventId: 'label-new', payload: fixture.github('label-new').payload },
    { providerEventId: 'control-middle', payload: null },
    { providerEventId: 'label-old', payload: fixture.github('label-old').payload },
    { providerEventId: 'control-old', payload: null },
  ];
  for (let i = 0; i < 7; i++) {
    await source.pollCycle(signal);
  }
  expect(await db.prisma.agentSourcePage.count({ where: { phase: { not: 'FINALIZED' } } })).toBe(0);
  const initialAnswer = await source.getBaseline(fixture.connectionId, initial.id);
  const pendingAnswer = await source.getBaseline(fixture.connectionId, pending.id);
  const checkpoints = await db.prisma.agentSourceCheckpoint.findMany();
  const backup = await dataBackupService.exportData('test');
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await dataBackupService.importData(backup);
  expect(await db.prisma.agentSourceCheckpoint.findMany()).toEqual(checkpoints);
  expect(await source.getBaseline(fixture.connectionId, initial.id)).toEqual(initialAnswer);
  expect(await source.getBaseline(fixture.connectionId, pending.id)).toEqual(pendingAnswer);
  feed = [{ providerEventId: 'control-old', payload: null }];
  await expect(source.prepareBaseline(fixture.connectionId, signal)).rejects.toThrow(
    'active or starting trigger'
  );
  await db.prisma.agentDefinition.updateMany({ data: { isEnabled: true } });
  await db.prisma.agentConnection.updateMany({ data: { isEnabled: true } });
  await db.prisma.agentTrigger.updateMany({ data: { isEnabled: true, activationState: 'ACTIVE' } });
  expect((await source.prepareBaseline(fixture.connectionId, signal)).boundary?.sourceOrder).toBe(
    0
  );
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'DEFERRED', reason: 'EMPTY' });
});
