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

async function clear() {
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.agentEvent.deleteMany();
  await db.prisma.agentConnection.deleteMany();
  await db.prisma.workspaceLaunchOrigin.deleteMany();
  await db.prisma.workspaceChildOrigin.deleteMany();
  await db.prisma.workspace.deleteMany();
  await db.prisma.project.deleteMany();
}
it('rejects forged model coverage values before opening the import transaction', async () => {
  const backup = await dataBackupService.exportData('test');
  backup.meta.recovery!.models.Project = {
    category: 'secret',
    handling: 'included',
    reason: 'Everything is backed up',
  };
  await clear();
  const transaction = vi.spyOn(db.prisma, '$transaction');
  await expect(dataBackupService.importData(backup)).rejects.toThrow(/coverage/);
  expect(transaction).not.toHaveBeenCalled();
});
it('rejects a grandchild graph with a validation error before any destination writes', async () => {
  const backup = await dataBackupService.exportData('test');
  const parent = backup.data.workspaces[0]!;
  backup.data.workspaces.push(
    { ...parent, id: 'child', parentWorkspaceId: parent.id },
    { ...parent, id: 'grandchild', parentWorkspaceId: 'child' }
  );
  await clear();
  const transaction = vi.spyOn(db.prisma, '$transaction');
  await expect(dataBackupService.importData(backup)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(transaction).not.toHaveBeenCalled();
});
it.each(['reservedWorkspaceId', 'workspaceId'] as const)(
  'rejects launch origins contradicting retained run %s',
  async (field) => {
    await db.prisma.workspace.create({
      data: { id: 'other-workspace', projectId: 'project', name: 'Other' },
    });
    await db.prisma.agentDefinition.create({
      data: { id: 'definition', projectId: 'project', name: 'Agent', instructions: 'go' },
    });
    await db.prisma.agentRun.create({
      data: {
        id: 'run',
        agentDefinitionId: 'definition',
        idempotencyKey: 'run',
        workspaceId: 'workspace',
        reservedWorkspaceId: 'workspace',
        definitionSnapshot: {},
        input: {},
        status: 'COMPLETED',
      },
    });
    await db.prisma.workspace.update({
      where: { id: 'workspace' },
      data: {
        creationSource: 'EVENT_AGENT',
        creationMetadata: {
          version: 1,
          runId: 'run',
          reservedSessionId: 'session',
          initialMessageId: 'message',
        },
      },
    });
    await db.prisma.workspaceLaunchOrigin.create({
      data: {
        runId: 'run',
        workspaceId: 'workspace',
        projectId: 'project',
        childHistoryVersion: 1,
      },
    });
    const backup = await dataBackupService.exportData('test');
    backup.data.durable!.agentRun[0]![field] = 'other-workspace';
    await clear();
    await expect(dataBackupService.importData(backup)).rejects.toThrow(/reservation|run workspace/);
    expect(await db.prisma.project.count()).toBe(0);
  }
);
it('does not attach a skipped session decision to an imported run sharing its ID', async () => {
  await db.prisma.agentDefinition.create({
    data: { id: 'definition', projectId: 'project', name: 'Agent', instructions: 'go' },
  });
  await db.prisma.agentRun.create({
    data: {
      id: 'session',
      agentDefinitionId: 'definition',
      idempotencyKey: 'run',
      definitionSnapshot: {},
      input: {},
      status: 'COMPLETED',
    },
  });
  await db.prisma.decisionLog.create({
    data: {
      id: 'decision',
      agentId: 'session',
      decision: 'retained',
      reasoning: 'source session history',
    },
  });
  const backup = await dataBackupService.exportData('test');
  await db.prisma.agentDefinition.deleteMany();
  await db.prisma.decisionLog.deleteMany();
  const result = await dataBackupService.importData(backup);
  expect(await db.prisma.agentRun.count()).toBe(1);
  expect(await db.prisma.decisionLog.count()).toBe(0);
  expect(result.recovery.skipped).toContainEqual({
    model: 'DecisionLog',
    identity: 'decision',
    reason: 'CONFLICTING_IDENTITY_OR_PARENT',
  });
});
it.each(['provider', 'order'] as const)(
  'skips a duplicate event %s identity without rolling back unrelated recovery',
  async (kind) => {
    await db.prisma.agentConnection.create({
      data: { id: 'connection', provider: 'GITHUB', externalId: 'source', name: 'Source' },
    });
    await db.prisma.agentSourceState.create({
      data: {
        connectionId: 'connection',
        lastSourceOrder: kind === 'order' ? 1 : 0,
        cursor: {
          version: 1,
          provider: 'GITHUB',
          committedHeadEventId: kind === 'order' ? 'provider-first' : null,
          scan: null,
        },
      },
    });
    const now = new Date();
    await db.prisma.agentEvent.create({
      data: {
        id: 'first',
        connectionId: 'connection',
        providerEventId: 'provider-first',
        sourceOrder: kind === 'order' ? 1 : null,
        payload: {},
        occurredAt: now,
        observedAt: now,
        payloadExpiresAt: now,
        identityExpiresAt: now,
      },
    });
    const backup = await dataBackupService.exportData('test');
    const first = backup.data.durable!.agentEvent[0]!;
    backup.data.durable!.agentEvent.push({
      ...first,
      id: 'second',
      providerEventId: kind === 'order' ? 'provider-second' : first.providerEventId,
    });
    await clear();
    const result = await dataBackupService.importData(backup);
    expect(result.projects.imported).toBe(1);
    expect(await db.prisma.agentEvent.findMany()).toEqual([
      expect.objectContaining({ id: 'first' }),
    ]);
    expect(result.recovery.skipped).toContainEqual({
      model: 'AgentEvent',
      identity: 'second',
      reason: 'CONFLICTING_IDENTITY_OR_PARENT',
    });
  }
);

it('accepts historical coverage reason wording without trusting it as the current policy', async () => {
  const backup = await dataBackupService.exportData('test');
  const reason = backup.meta.recovery!.models.Project!.reason;
  backup.meta.recovery!.models.Project!.reason = 'Earlier v8 release wording';
  await clear();
  await dataBackupService.importData(backup);
  expect((await dataBackupService.exportData('test')).meta.recovery!.models.Project!.reason).toBe(
    reason
  );
});
