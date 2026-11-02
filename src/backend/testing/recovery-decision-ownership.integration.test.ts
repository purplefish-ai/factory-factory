import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { configService } from '@/backend/services/config.service';
import { decisionLogService, readRecoveryOwnerConflicts } from '@/backend/services/decision-log';
import type { PrismaClient } from '@prisma-gen/client';
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
let source: IntegrationDatabase;
let target: IntegrationDatabase;
type Owner = 'session' | 'run' | 'definition';
async function installation(db: IntegrationDatabase, prefix: string) {
  await db.prisma.project.create({
    data: {
      id: `${prefix}-project`,
      name: prefix,
      slug: prefix,
      repoPath: `/${prefix}`,
      worktreeBasePath: `/${prefix}-trees`,
    },
  });
  await db.prisma.workspace.create({
    data: { id: `${prefix}-workspace`, projectId: `${prefix}-project`, name: prefix },
  });
}
function use(db: IntegrationDatabase) {
  database.prisma = db.prisma;
  vi.mocked(configService.getBaseDir).mockReturnValue(db.tempDir);
}
beforeEach(async () => {
  source = await createIntegrationDatabase();
  target = await createIntegrationDatabase();
  vi.spyOn(configService, 'getBaseDir');
  await installation(source, 'source');
  await installation(target, 'target');
  use(source);
}, 30_000);
afterEach(async () => {
  await destroyIntegrationDatabase(source);
  await destroyIntegrationDatabase(target);
});
async function createOwner(db: IntegrationDatabase, kind: Owner, prefix: string, id = 'shared') {
  if (kind === 'session') {
    return db.prisma.agentSession.create({
      data: {
        id,
        workspaceId: `${prefix}-workspace`,
        workflow: 'default',
        model: 'default',
        provider: 'CODEX',
      },
    });
  }
  const definition = await db.prisma.agentDefinition.create({
    data: {
      id: kind === 'definition' ? id : `${prefix}-definition`,
      projectId: `${prefix}-project`,
      name: 'Agent',
      instructions: 'retained',
    },
  });
  if (kind === 'definition') {
    return definition;
  }
  return db.prisma.agentRun.create({
    data: {
      id,
      agentDefinitionId: definition.id,
      idempotencyKey: `${prefix}-run`,
      definitionSnapshot: {},
      input: {},
      status: 'COMPLETED',
    },
  });
}
async function readOwners(db: IntegrationDatabase) {
  return {
    sessions: await db.prisma.agentSession.findMany({ where: { id: 'shared' } }),
    runs: await db.prisma.agentRun.findMany({ where: { id: 'shared' } }),
    definitions: await db.prisma.agentDefinition.findMany({ where: { id: 'shared' } }),
  };
}
function decision() {
  return source.prisma.decisionLog.create({
    data: {
      id: 'source-decision',
      agentId: 'shared',
      decision: 'retained',
      reasoning: 'source owner history',
    },
  });
}
async function dependent(kind: Owner) {
  if (kind === 'session') {
    await source.prisma.sessionLifecycleEvent.create({
      data: {
        id: 'dependent',
        workspaceId: 'source-workspace',
        sessionId: 'shared',
        kind: 'SESSION_STOPPED',
        reason: 'USER_STOP',
        message: 'source stopped',
        dedupeKey: 'source-stop',
      },
    });
    return 'SessionLifecycleEvent';
  }
  if (kind === 'run') {
    await source.prisma.agentInitialDelivery.create({
      data: {
        id: 'dependent',
        runId: 'shared',
        sendAttemptId: 'send',
        messageId: 'message',
        state: 'FINISHED',
      },
    });
    return 'AgentInitialDelivery';
  }
  await source.prisma.agentTrigger.create({
    data: {
      id: 'dependent',
      agentDefinitionId: 'shared',
      type: 'SCHEDULE',
      description: 'source trigger',
      config: {},
    },
  });
  return 'AgentTrigger';
}
const collisions: [Owner, Owner][] = [
  ['session', 'definition'],
  ['session', 'run'],
  ['run', 'session'],
  ['run', 'definition'],
  ['definition', 'session'],
  ['definition', 'run'],
];
it.each(collisions)(
  'does not attach imported %s history to a destination-only %s with the same ID',
  async (sourceKind, targetKind) => {
    await createOwner(source, sourceKind, 'source');
    await decision();
    const dependentModel = await dependent(sourceKind);
    const backup = await dataBackupService.exportData('test');
    await createOwner(target, targetKind, 'target');
    const before = await readOwners(target);
    const localDecision = await target.prisma.decisionLog.create({
      data: {
        id: 'target-decision',
        agentId: 'shared',
        decision: 'local',
        reasoning: 'untouched local history',
      },
    });
    use(target);
    const historyBefore = await decisionLogService.findByAgentId('shared');
    const result = await dataBackupService.importData(backup);
    expect(await decisionLogService.findByAgentId('shared')).toEqual(historyBefore);
    const after = await readOwners(target);
    const targetKey =
      targetKind === 'session' ? 'sessions' : targetKind === 'run' ? 'runs' : 'definitions';
    const sourceKey =
      sourceKind === 'session' ? 'sessions' : sourceKind === 'run' ? 'runs' : 'definitions';
    expect(after[targetKey]).toEqual(before[targetKey]);
    expect(after[sourceKey]).toHaveLength(0);
    if (sourceKind === 'session') {
      expect(result.agentSessions).toEqual({ imported: 0, skipped: 1 });
      expect(result.recovery.skipped).toContainEqual({
        model: 'AgentSession',
        identity: 'shared',
        reason: 'CONFLICTING_IDENTITY_OR_PARENT',
      });
    } else {
      expect(result.recovery.skipped).toContainEqual({
        model: sourceKind === 'run' ? 'AgentRun' : 'AgentDefinition',
        identity: 'shared',
        reason: 'CONFLICTING_IDENTITY_OR_PARENT',
      });
    }
    expect(await target.prisma.decisionLog.findMany()).toEqual([localDecision]);
    expect(result.recovery.models).toContainEqual({
      model: dependentModel,
      imported: 0,
      skipped: 1,
    });
    expect(result.recovery.models).toContainEqual({
      model: 'DecisionLog',
      imported: 0,
      skipped: 1,
    });
    expect(result.recovery.skipped).toContainEqual({
      model: 'DecisionLog',
      identity: 'source-decision',
      reason: 'CONFLICTING_IDENTITY_OR_PARENT',
    });
  }
);
it.each(['session', 'run', 'definition'] as const)(
  'retains unambiguous imported %s decision history',
  async (kind) => {
    await createOwner(source, kind, 'source');
    const retained = await decision();
    const backup = await dataBackupService.exportData('test');
    use(target);
    const result = await dataBackupService.importData(backup);
    expect(await target.prisma.decisionLog.findMany()).toEqual([retained]);
    expect(result.recovery.models).toContainEqual({
      model: 'DecisionLog',
      imported: 1,
      skipped: 0,
    });
  }
);
it('retains genuinely deleted owner provenance when no destination owner can claim it', async () => {
  const retained = await decision();
  const backup = await dataBackupService.exportData('test');
  use(target);
  const result = await dataBackupService.importData(backup);
  expect(await readOwners(target)).toEqual({ sessions: [], runs: [], definitions: [] });
  expect(await target.prisma.decisionLog.findMany()).toEqual([retained]);
  expect(result.recovery.models).toContainEqual({ model: 'DecisionLog', imported: 1, skipped: 0 });
});

it.each(collisions)(
  'reserves a destination %s/%s namespace even when both histories are empty',
  async (sourceKind, targetKind) => {
    await createOwner(source, sourceKind, 'source');
    const backup = await dataBackupService.exportData('test');
    await createOwner(target, targetKind, 'target');
    const before = await readOwners(target);
    use(target);
    expect(await decisionLogService.findByAgentId('shared')).toEqual([]);
    await dataBackupService.importData(backup);
    expect(await readOwners(target)).toEqual(before);
    expect(await decisionLogService.findByAgentId('shared')).toEqual([]);
  }
);
it.each(['session', 'run', 'definition'] as const)(
  'does not let an imported %s adopt orphaned local decision history',
  async (kind) => {
    await createOwner(source, kind, 'source');
    const backup = await dataBackupService.exportData('test');
    const local = await target.prisma.decisionLog.create({
      data: { id: 'orphan', agentId: 'shared', decision: 'old', reasoning: 'deleted local owner' },
    });
    use(target);
    expect(await decisionLogService.findByAgentId('shared')).toEqual([local]);
    const result = await dataBackupService.importData(backup);
    expect(await readOwners(target)).toEqual({ sessions: [], runs: [], definitions: [] });
    expect(await decisionLogService.findByAgentId('shared')).toEqual([local]);
    if (kind === 'session') {
      expect(result.agentSessions).toEqual({ imported: 0, skipped: 1 });
      expect(result.recovery.skipped).toContainEqual({
        model: 'AgentSession',
        identity: 'shared',
        reason: 'CONFLICTING_IDENTITY_OR_PARENT',
      });
    } else {
      expect(result.recovery.skipped).toContainEqual({
        model: kind === 'run' ? 'AgentRun' : 'AgentDefinition',
        identity: 'shared',
        reason: 'CONFLICTING_IDENTITY_OR_PARENT',
      });
    }
  }
);
it('does not create a new ambiguous cross-kind namespace or its dependent run', async () => {
  await createOwner(source, 'session', 'source');
  await createOwner(source, 'definition', 'source');
  await source.prisma.agentRun.create({
    data: {
      id: 'dependent',
      agentDefinitionId: 'shared',
      idempotencyKey: 'dependent',
      definitionSnapshot: {},
      input: {},
      status: 'COMPLETED',
    },
  });
  const backup = await dataBackupService.exportData('test');
  use(target);
  const result = await dataBackupService.importData(backup);
  expect(await readOwners(target)).toEqual({ sessions: [], runs: [], definitions: [] });
  expect(await target.prisma.agentRun.findUnique({ where: { id: 'dependent' } })).toBeNull();
  expect(result.recovery.models).toContainEqual({
    model: 'AgentDefinition',
    imported: 0,
    skipped: 1,
  });
  expect(result.recovery.models).toContainEqual({ model: 'AgentRun', imported: 0, skipped: 1 });
});

it('bounds namespace queries to 200 supplied IDs and groups retained decision identities', async () => {
  await createOwner(source, 'session', 'source');
  const backup = await dataBackupService.exportData('test');
  const template = backup.data.agentSessions[0]!;
  const ids = Array.from({ length: 201 }, (_, index) => `candidate-${index}`);
  backup.data.agentSessions = ids.map((id) => ({ ...template, id }));
  await target.prisma.decisionLog.createMany({
    data: [
      { id: 'first', agentId: 'candidate-0', decision: 'one', reasoning: 'old' },
      { id: 'repeated', agentId: 'candidate-0', decision: 'two', reasoning: 'old' },
      { id: 'last', agentId: 'candidate-200', decision: 'last', reasoning: 'old' },
      { id: 'unrelated', agentId: 'not-in-package', decision: 'unrelated', reasoning: 'old' },
    ],
  });
  await target.prisma.$transaction(async (tx) => {
    const sessions = vi.spyOn(tx.agentSession, 'findMany');
    const runs = vi.spyOn(tx.agentRun, 'findMany');
    const definitions = vi.spyOn(tx.agentDefinition, 'findMany');
    const decisions = vi.spyOn(tx.decisionLog, 'groupBy');
    expect(await readRecoveryOwnerConflicts(tx, backup.data)).toEqual(
      new Set(['candidate-0', 'candidate-200'])
    );
    for (const query of [sessions, runs, definitions]) {
      expect(query.mock.calls.map(([args]) => args?.where)).toEqual([
        { id: { in: ids.slice(0, 200) } },
        { id: { in: ids.slice(200) } },
      ]);
    }
    expect(decisions.mock.calls).toEqual([
      [{ by: ['agentId'], where: { agentId: { in: ids.slice(0, 200) } } }],
      [{ by: ['agentId'], where: { agentId: { in: ids.slice(200) } } }],
    ]);
  });
});
