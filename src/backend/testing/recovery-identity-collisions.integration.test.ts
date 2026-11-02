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

it.each(['reservedWorkspaceId', 'reservedSessionId', 'initialMessageId'] as const)(
  'skips a run whose retained %s is owned by a different local run without aborting unrelated history',
  async (field) => {
    await db.prisma.agentDefinition.create({
      data: { id: 'source-definition', projectId: 'project', name: 'Source', instructions: 'go' },
    });
    await db.prisma.agentRun.create({
      data: {
        id: 'source-run',
        agentDefinitionId: 'source-definition',
        idempotencyKey: 'source',
        [field]: 'retained-reservation',
        status: 'COMPLETED',
        definitionSnapshot: {},
        input: {},
      },
    });
    await db.prisma.decisionLog.create({
      data: {
        id: 'unrelated-decision',
        agentId: 'deleted-session',
        decision: 'keep',
        reasoning: 'retained history',
      },
    });
    const backup = await dataBackupService.exportData('test');
    await db.prisma.agentDefinition.deleteMany();
    await db.prisma.decisionLog.deleteMany();
    await db.prisma.workspace.deleteMany();
    await db.prisma.project.deleteMany();
    await db.prisma.project.create({
      data: {
        id: 'local-project',
        name: 'Local',
        slug: 'local',
        repoPath: '/local',
        worktreeBasePath: '/local-trees',
      },
    });
    await db.prisma.agentDefinition.create({
      data: {
        id: 'local-definition',
        projectId: 'local-project',
        name: 'Local',
        instructions: 'keep local',
      },
    });
    const local = await db.prisma.agentRun.create({
      data: {
        id: 'local-run',
        agentDefinitionId: 'local-definition',
        idempotencyKey: 'local',
        [field]: 'retained-reservation',
        definitionSnapshot: {},
        input: {},
      },
    });
    const result = await dataBackupService.importData(backup);
    expect(await db.prisma.agentRun.findUnique({ where: { id: 'source-run' } })).toBeNull();
    expect(await db.prisma.agentRun.findUnique({ where: { id: 'local-run' } })).toEqual(local);
    expect(await db.prisma.decisionLog.count()).toBe(1);
    expect(result.recovery.skipped).toContainEqual({
      model: 'AgentRun',
      identity: 'source-run',
      reason: 'CONFLICTING_IDENTITY_OR_PARENT',
    });
  }
);
it.each(['page', 'baseline'])(
  'skips a complete source graph on a globally colliding %s identity',
  async (kind) => {
    const runtime = await vi.importActual<typeof import('@/backend/services/agent-definition')>(
      '@/backend/services/agent-definition'
    );
    const { createLedgerFixture } = await vi.importActual<
      typeof import('@/backend/services/agent-definition/resources/testing/agent-ledger.test-support')
    >('@/backend/services/agent-definition/resources/testing/agent-ledger.test-support');
    const fixture = await createLedgerFixture(db, runtime);
    await fixture.admit(await fixture.event());
    const backup = await dataBackupService.exportData('test');
    const durable = backup.data.durable!;
    const collision =
      kind === 'page' ? durable.agentSourcePage[0]!.id : durable.agentSourceBaseline[0]!.id;
    expect(durable.agentSourceCheckpoint.length).toBeGreaterThan(0);
    expect(durable.agentSourceHead.length).toBeGreaterThan(0);
    await db.prisma.agentDefinition.deleteMany();
    await db.prisma.agentEvent.deleteMany();
    await db.prisma.agentConnection.deleteMany();
    await db.prisma.workspace.deleteMany();
    await db.prisma.project.deleteMany();
    await db.prisma.agentConnection.create({
      data: {
        id: 'local-connection',
        provider: 'GITHUB',
        externalId: 'local',
        name: 'Local',
        sourceState: { create: {} },
      },
    });
    if (kind === 'page') {
      await db.prisma.agentSourcePage.create({
        data: {
          id: collision,
          connectionId: 'local-connection',
          scanId: 'local',
          ordinal: 0,
          phase: 'CAPTURE',
          requestPage: 1,
          evidence: { ids: [], entries: [] },
        },
      });
    } else {
      await db.prisma.agentSourceBaseline.create({
        data: {
          id: collision,
          connectionId: 'local-connection',
          headEventId: null,
          sourceOrder: 0,
        },
      });
    }
    const localState = await db.prisma.agentSourceState.findUnique({
      where: { connectionId: 'local-connection' },
    });
    const result = await dataBackupService.importData(backup);
    expect(result.projects.imported).toBe(1);
    expect(
      await db.prisma.agentConnection.findUnique({ where: { id: fixture.connectionId } })
    ).toBeNull();
    expect(
      await db.prisma.agentSourceState.findUnique({ where: { connectionId: 'local-connection' } })
    ).toEqual(localState);
    expect(
      await db.prisma.agentSourcePage.count({ where: { connectionId: fixture.connectionId } })
    ).toBe(0);
    expect(
      await db.prisma.agentSourceBaseline.count({ where: { connectionId: fixture.connectionId } })
    ).toBe(0);
    expect(await db.prisma.agentSourceCheckpoint.count()).toBe(0);
    expect(await db.prisma.agentSourceHead.count()).toBe(0);
    expect(await db.prisma.agentEvent.count()).toBe(0);
    expect(await db.prisma.agentTrigger.count()).toBe(0);
    expect(await db.prisma.agentRun.count()).toBe(0);
    expect(await db.prisma.agentEvaluation.count()).toBe(0);
    expect(result.recovery.skipped).toContainEqual({
      model: 'AgentConnection',
      identity: fixture.connectionId,
      reason: 'CONFLICTING_IDENTITY_OR_PARENT',
    });
    const proofModel = kind === 'page' ? 'AgentSourcePage' : 'AgentSourceBaseline';
    expect(result.recovery.skipped).toContainEqual({
      model: proofModel,
      identity: collision,
      reason: 'EXISTING_IDENTITY',
    });
  }
);
