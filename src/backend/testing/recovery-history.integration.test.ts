import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import { Prisma, type PrismaClient } from '@prisma-gen/client';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing recovery test database');
    }
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

it('restores event/run/evaluation and source continuity proof while imported unresolved effects stay inert', async () => {
  const runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  const fixture = await createLedgerFixture(db, runtime);
  const eventId = await fixture.event();
  await db.prisma.codexAccount.upsert({
    where: { id: 'codex-native-default' },
    create: { id: 'codex-native-default', label: 'Native default', kind: 'NATIVE_DEFAULT' },
    update: {},
  });
  await fixture.admit(eventId, {
    executionConfig: { version: 1, provider: 'CODEX', model: 'default' },
  });
  await runtime.claimNextRun();
  const original = await db.prisma.agentRun.findFirstOrThrow();
  const originalTrigger = await db.prisma.agentTrigger.findUniqueOrThrow({
    where: { id: fixture.triggerId },
  });
  const definition = await db.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: original.agentDefinitionId },
  });
  if (!(original.reservedWorkspaceId && original.reservedSessionId && original.initialMessageId)) {
    throw new Error('Run reservation missing');
  }
  const execution = {
    version: 1,
    provider: 'CODEX',
    model: 'default',
    reasoningEffort: null,
    codexAccountId: 'codex-native-default',
    startupModePreset: 'non_interactive',
    accessMode: 'full-access',
    planModeEnabled: false,
  };
  await db.prisma.workspace.create({
    data: {
      id: original.reservedWorkspaceId,
      projectId: definition.projectId,
      name: 'Run workspace',
      status: 'READY',
      creationSource: 'EVENT_AGENT',
      creationMetadata: {
        version: 1,
        runId: original.id,
        reservedSessionId: original.reservedSessionId,
        initialMessageId: original.initialMessageId,
      },
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: original.reservedSessionId,
      workspaceId: original.reservedWorkspaceId,
      workflow: 'event-agent',
      provider: 'CODEX',
      codexAccountId: 'codex-native-default',
      model: 'default',
    },
  });
  await db.prisma.agentRun.update({
    where: { id: original.id },
    data: { workspaceId: original.reservedWorkspaceId, effectiveExecution: execution },
  });
  await db.prisma.workspaceLaunchOrigin.create({
    data: {
      runId: original.id,
      workspaceId: original.reservedWorkspaceId,
      projectId: definition.projectId,
      childHistoryVersion: 1,
    },
  });
  await db.prisma.workspaceChildOrigin.create({
    data: {
      parentWorkspaceId: original.reservedWorkspaceId,
      childWorkspaceId: 'retained-deleted-child',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'live-child',
      projectId: definition.projectId,
      parentWorkspaceId: original.reservedWorkspaceId,
      name: 'Live child',
      status: 'READY',
    },
  });
  await db.prisma.workspaceChildOrigin.create({
    data: {
      parentWorkspaceId: original.reservedWorkspaceId,
      childWorkspaceId: 'live-child',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await db.prisma.agentSessionLaunchOrigin.create({
    data: {
      runId: original.id,
      sessionId: original.reservedSessionId,
      workspaceId: original.reservedWorkspaceId,
      execution,
    },
  });
  await db.prisma.sessionLifecycleEvent.create({
    data: {
      id: 'interruption',
      workspaceId: original.reservedWorkspaceId,
      sessionId: original.reservedSessionId,
      kind: 'TURN_INTERRUPTED',
      reason: 'PROVIDER_ERROR',
      message: 'Retain interrupted-turn evidence',
      dedupeKey: 'interruption',
    },
  });
  await db.prisma.decisionLog.create({
    data: {
      id: 'decision',
      agentId: original.id,
      decision: 'Inspect before retry',
      reasoning: 'Delivery result unknown',
    },
  });

  await db.prisma.agentRun.update({
    where: { id: original.id },
    data: { launchPhase: 'DISPATCHING' },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { runId: original.id },
    data: {
      state: 'SENDING',
      sendingAt: new Date(),
      evidence: { version: 1, note: 'Provider result unknown' },
    },
  });
  const delivery = await db.prisma.agentInitialDelivery.findUniqueOrThrow({
    where: { runId: original.id },
  });
  const baselines = await db.prisma.agentSourceBaseline.findMany();
  const pages = await db.prisma.agentSourcePage.findMany();
  const backup = exportDataSchema.parse(
    JSON.parse(JSON.stringify(await dataBackupService.exportData('test')))
  );
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.workspaceLaunchOrigin.deleteMany();
  await db.prisma.workspaceChildOrigin.deleteMany();
  await db.prisma.agentSessionLaunchOrigin.deleteMany();
  await db.prisma.decisionLog.deleteMany();
  await db.prisma.project.deleteMany();
  await dataBackupService.importData(backup);
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: original.id } })
  ).toMatchObject({ workspaceId: original.reservedWorkspaceId, childHistoryVersion: 1 });
  expect(await db.prisma.workspaceChildOrigin.count()).toBe(2);
  expect(
    await db.prisma.workspaceChildOrigin.findUnique({
      where: {
        parentWorkspaceId_childWorkspaceId: {
          parentWorkspaceId: original.reservedWorkspaceId,
          childWorkspaceId: 'live-child',
        },
      },
    })
  ).toMatchObject({ createdAt: new Date('2026-01-01T00:00:00.000Z') });
  expect(await db.prisma.workspaceChildOrigin.findMany()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        parentWorkspaceId: original.reservedWorkspaceId,
        childWorkspaceId: 'retained-deleted-child',
      }),
    ])
  );
  expect(
    await db.prisma.agentTrigger.findUnique({ where: { id: fixture.triggerId } })
  ).toMatchObject({
    activationBoundary: originalTrigger.activationBoundary,
    activationState: 'PAUSED',
    isEnabled: false,
  });
  const restoredSession = await db.prisma.agentSession.findUniqueOrThrow({
    where: { id: original.reservedSessionId },
  });
  expect(restoredSession.codexAccountId).not.toBe('codex-native-default');
  // Operational FK uses a reauthentication profile; immutable launch proof keeps the source identity.
  expect(restoredSession.codexAccountId).not.toBe(execution.codexAccountId);
  expect(await db.prisma.agentRun.findUnique({ where: { id: original.id } })).toMatchObject({
    effectiveExecution: execution,
  });
  expect(
    await db.prisma.agentSessionLaunchOrigin.findUnique({ where: { runId: original.id } })
  ).toMatchObject({ sessionId: original.reservedSessionId, execution });
  expect(
    await db.prisma.sessionLifecycleEvent.findUnique({ where: { id: 'interruption' } })
  ).toMatchObject({ message: 'Retain interrupted-turn evidence' });
  expect(await db.prisma.decisionLog.findUnique({ where: { id: 'decision' } })).toMatchObject({
    reasoning: 'Delivery result unknown',
  });
  expect(await db.prisma.agentRun.findUnique({ where: { id: original.id } })).toMatchObject({
    status: 'CANCELLED',
    launchPhase: 'NEEDS_ATTENTION',
    reasonCode: 'IMPORTED_RUNNING_REQUIRES_REVIEW',
    eventId,
    definitionSnapshot: original.definitionSnapshot,
    triggerSnapshot: original.triggerSnapshot,
    input: original.input,
  });
  expect(
    await db.prisma.agentInitialDelivery.findUnique({ where: { runId: original.id } })
  ).toMatchObject({
    state: 'AMBIGUOUS',
    messageId: delivery.messageId,
    sendAttemptId: delivery.sendAttemptId,
    evidence: delivery.evidence,
    sendingAt: delivery.sendingAt,
  });
  expect(await db.prisma.agentEvaluation.findFirst()).toMatchObject({
    runId: original.id,
    eventId,
  });
  expect(await db.prisma.agentSourceBaseline.findMany()).toEqual(baselines);
  expect(await db.prisma.agentSourcePage.findMany()).toEqual(pages);
  expect(
    await db.prisma.agentSourceState.findUnique({ where: { connectionId: fixture.connectionId } })
  ).toMatchObject({ isReady: false });
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'DEFERRED', reason: 'EMPTY' });
  expect(
    await db.prisma.agentInitialDelivery.findUnique({ where: { runId: original.id } })
  ).toMatchObject({ state: 'AMBIGUOUS' });
});

it.each(['definition', 'connection'])(
  'skips dependents of a colliding automation parent: %s',
  async (kind) => {
    const runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
      '@/backend/services/agent-definition'
    );
    const fixture = await createLedgerFixture(db, runtime);
    await fixture.admit(await fixture.event());
    const sourceRun = await db.prisma.agentRun.findFirstOrThrow();
    const backup = exportDataSchema.parse(
      JSON.parse(JSON.stringify(await dataBackupService.exportData('test')))
    );
    await db.prisma.agentDefinition.deleteMany();
    await db.prisma.agentEvent.deleteMany();
    await db.prisma.agentConnection.deleteMany();
    await db.prisma.workspace.deleteMany();
    await db.prisma.project.deleteMany();
    await db.prisma.project.create({
      data: {
        id: 'local-project',
        name: 'Local',
        slug: 'local',
        repoPath: '/other-repo',
        worktreeBasePath: '/other-trees',
      },
    });
    if (kind === 'definition') {
      await db.prisma.agentDefinition.create({
        data: {
          id: fixture.definitionId,
          projectId: 'local-project',
          name: 'Local agent',
          instructions: 'Keep local instructions',
          isEnabled: true,
        },
      });
    } else {
      await db.prisma.agentConnection.create({
        data: {
          id: fixture.connectionId,
          provider: 'GITHUB',
          externalId: 'gh:local-repository',
          name: 'Local connection',
          isEnabled: true,
          credentialsEncrypted: 'SYNTHETIC_LOCAL_CREDENTIAL',
        },
      });
    }
    const result = await dataBackupService.importData(backup);
    expect(result.recovery.skipped).toEqual(
      expect.arrayContaining([
        {
          model: 'AgentTrigger',
          identity: fixture.triggerId,
          reason: 'CONFLICTING_IDENTITY_OR_PARENT',
        },
        { model: 'AgentRun', identity: sourceRun.id, reason: 'CONFLICTING_IDENTITY_OR_PARENT' },
      ])
    );
    expect(
      await db.prisma.agentTrigger.findUnique({ where: { id: fixture.triggerId } })
    ).toBeNull();
    expect(await db.prisma.agentRun.findUnique({ where: { id: sourceRun.id } })).toBeNull();
    if (kind === 'definition') {
      expect(
        await db.prisma.agentDefinition.findUnique({ where: { id: fixture.definitionId } })
      ).toMatchObject({
        projectId: 'local-project',
        instructions: 'Keep local instructions',
        isEnabled: true,
      });
    } else {
      expect(
        await db.prisma.agentConnection.findUnique({ where: { id: fixture.connectionId } })
      ).toMatchObject({
        externalId: 'gh:local-repository',
        isEnabled: true,
        credentialsEncrypted: 'SYNTHETIC_LOCAL_CREDENTIAL',
      });
    }
  }
);

it('preserves persisted JSON-null proof separately from SQL absence', async () => {
  const runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
    '@/backend/services/agent-definition'
  );
  const fixture = await createLedgerFixture(db, runtime);
  await fixture.admit(await fixture.event());
  await runtime.claimNextRun();
  const run = await db.prisma.agentRun.findFirstOrThrow();
  await db.prisma.agentRun.update({
    where: { id: run.id },
    data: {
      result: Prisma.JsonNull,
      effectiveExecution: Prisma.JsonNull,
      launchPreparation: Prisma.JsonNull,
    },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { runId: run.id },
    data: { state: 'SENDING', evidence: Prisma.JsonNull },
  });
  const backup = exportDataSchema.parse(await dataBackupService.exportData('test'));
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
  await dataBackupService.importData(backup);
  const storage = await db.prisma.$queryRaw(
    Prisma.sql`SELECT json_type(r.result) AS resultType, json_type(r.effectiveExecution) AS executionType, json_type(r.launchPreparation) AS preparationType, json_type(d.evidence) AS evidenceType, json_type(t.pendingActivation) AS pendingType FROM AgentRun r JOIN AgentInitialDelivery d ON d.runId = r.id JOIN AgentTrigger t ON t.id = r.triggerId WHERE r.id = ${run.id}`
  );
  expect(storage).toEqual([
    {
      resultType: 'null',
      executionType: 'null',
      preparationType: 'null',
      evidenceType: 'null',
      pendingType: null,
    },
  ]);
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'DEFERRED', reason: 'EMPTY' });
});
