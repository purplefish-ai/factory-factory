import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { configService } from '@/backend/services/config.service';
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
    const result = await dataBackupService.importData(backup);
    const after = await readOwners(target);
    const targetKey =
      targetKind === 'session' ? 'sessions' : targetKind === 'run' ? 'runs' : 'definitions';
    const sourceKey =
      sourceKind === 'session' ? 'sessions' : sourceKind === 'run' ? 'runs' : 'definitions';
    expect(after[targetKey]).toEqual(before[targetKey]);
    expect(after[sourceKey]).toHaveLength(1);
    expect(await target.prisma.decisionLog.findMany()).toEqual([localDecision]);
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
