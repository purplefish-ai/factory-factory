import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup/data-backup.service';
import * as runtime from '@/backend/services/agent-definition';
import * as recovery from '@/backend/services/agent-definition/resources/agent-definition-recovery';
import { createLedgerFixture } from '@/backend/services/agent-definition/resources/testing/agent-ledger.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  clearIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { AgentIssueEventPage } from '@/shared/agent-source';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import fixed from '@/shared/testing/recovery-automation-definitions-v8.fixture.json';
import { Prisma, type PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({
  prisma: undefined as PrismaClient | undefined,
  beforeAccounts: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
vi.mock('@/backend/services/codex-accounts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/backend/services/codex-accounts')>();
  return {
    ...original,
    exportCodexAccountMetadata: async (tx?: Prisma.TransactionClient) => {
      await state.beforeAccounts?.();
      return original.exportCodexAccountMetadata(tx);
    },
  };
});
let source: IntegrationDatabase;
let destination: IntegrationDatabase;
beforeAll(async () => {
  source = await createIntegrationDatabase();
  destination = await createIntegrationDatabase();
}, 30_000);
beforeEach(async () => {
  for (const db of [source, destination]) {
    await db.prisma.agentDefinition.deleteMany();
    await db.prisma.agentEvent.deleteMany();
    await db.prisma.agentConnection.deleteMany();
    await clearIntegrationDatabase(db.prisma);
  }
  state.prisma = destination.prisma;
});
afterAll(async () => {
  await destroyIntegrationDatabase(source);
  await destroyIntegrationDatabase(destination);
});

async function author() {
  state.prisma = source.prisma;
  const project = await source.prisma.project.create({
    data: {
      id: 'authored-project',
      name: 'Authored',
      slug: 'authored',
      repoPath: '/repo',
      worktreeBasePath: '/worktrees',
    },
  });
  const workspace = await source.prisma.workspace.create({
    data: { name: 'Author', projectId: project.id },
  });
  const service = new runtime.AgentProposalService();
  const proposal = await service.propose({
    workspaceId: workspace.id,
    specification: {
      name: 'Authored body',
      instructions: 'Keep literal token=instruction-sentinel prose.\nSecond line.',
      executionConfig: {
        version: 1,
        provider: 'CODEX',
        model: 'custom-model',
        reasoningEffort: 'high',
      },
      triggers: [
        {
          id: 'original-event',
          type: 'SCHEDULE',
          description: 'Original daily event',
          config: { version: 1, cadence: 'DAILY' },
        },
      ],
    },
  });
  const accepted = await service.create({
    workspaceId: workspace.id,
    proposalId: proposal.id,
    revision: proposal.revision,
    specification: proposal.specification,
  });
  const input = { projectId: project.id, agentId: accepted.agentDefinitionId! };
  const management = new runtime.AgentManagementService();
  const evidence = {
    project: { id: project.id, githubOwner: null, githubRepo: null },
    connections: [],
    sourceNames: {},
  };
  const before = await management.get(input);
  await management.updateSaved(
    {
      ...input,
      expectedManagementRevision: before.managementRevision,
      specification: {
        ...before.specification!,
        instructions: `${before.instructions}\nEdited through owner.`,
      },
    },
    evidence
  );
  await source.prisma.agentConnection.create({
    data: {
      id: 'credential-source',
      provider: 'SLACK',
      externalId: 'workspace-source',
      name: 'Secret source',
      credentialsEncrypted: 'structured-credential-sentinel',
    },
  });
  return { input, management, evidence };
}

it('roundtrips actual proposal/create/edit bodies then publicly inspects and explicitly authors fresh paused events', async () => {
  const authored = await author();
  const sourceRow = await source.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: authored.input.agentId },
  });
  const sourceTriggers = await source.prisma.agentTrigger.findMany();
  expect(sourceTriggers).toHaveLength(1);
  expect(await source.prisma.agentProposal.count()).toBe(1);
  const file = await dataBackupService.exportData('actual-owner');
  expect(JSON.stringify(file)).not.toContain('structured-credential-sentinel');
  expect(JSON.stringify(file)).toContain('token=instruction-sentinel');
  state.prisma = destination.prisma;
  const result = await dataBackupService.importData(file);
  expect(result.recovery.automationDefinitions).toEqual({
    model: 'AgentDefinition',
    imported: 1,
    skipped: 0,
    sourceEnabled: 0,
    restoredDisabled: 1,
    reasons: { EXISTING_IDENTITY: 0, INCOMPLETE_DEPENDENCY: 0 },
  });
  expect(
    await destination.prisma.agentDefinition.findUniqueOrThrow({ where: { id: sourceRow.id } })
  ).toEqual({ ...sourceRow, isEnabled: false });
  expect(
    await source.prisma.agentDefinition.findUniqueOrThrow({ where: { id: sourceRow.id } })
  ).toEqual(sourceRow);
  for (const count of [
    await destination.prisma.agentTrigger.count(),
    await destination.prisma.agentEvent.count(),
    await destination.prisma.agentEvaluation.count(),
    await destination.prisma.agentRun.count(),
    await destination.prisma.agentProposal.count(),
  ]) {
    expect(count).toBe(0);
  }
  expect(await destination.prisma.agentConnection.findMany()).toEqual([
    expect.objectContaining({
      id: 'credential-source',
      provider: 'SLACK',
      externalId: 'workspace-source',
      name: 'Secret source',
      isEnabled: false,
      credentialsEncrypted: null,
    }),
  ]);
  const reexport = await dataBackupService.exportData('disabled-truth');
  // Validated intent is activation authority and is never exported.
  const { validatedIntent: _sourceIntent, ...exportedRow } = sourceRow;
  expect(reexport.data).toHaveProperty('recovery.automationDefinitions.definitions', [
    {
      ...exportedRow,
      isEnabled: false,
      createdAt: sourceRow.createdAt.toISOString(),
      updatedAt: sourceRow.updatedAt.toISOString(),
    },
  ]);
  const inspected = await authored.management.get(authored.input);
  expect(inspected).toMatchObject({
    instructions: sourceRow.instructions,
    executionConfig: sourceRow.executionConfig,
    specification: null,
    configuredTriggers: [],
    retainedTriggers: [],
  });
  expect((await authored.management.list({ projectId: sourceRow.projectId })).items).toMatchObject([
    { id: sourceRow.id },
  ]);
  const replacement = await authored.management.updateSaved(
    {
      ...authored.input,
      expectedManagementRevision: inspected.managementRevision,
      specification: {
        name: inspected.name,
        instructions: inspected.instructions,
        executionConfig: inspected.executionConfig,
        triggers: [
          { type: 'SCHEDULE', description: 'New event', config: { version: 1, cadence: 'DAILY' } },
        ],
      },
    },
    authored.evidence
  );
  expect(replacement.configuredTriggers).toHaveLength(1);
  expect(replacement.configuredTriggers[0]).toMatchObject({
    isEnabled: false,
    activationState: 'PAUSED',
  });
  expect(sourceTriggers.map((row) => row.id)).not.toContain(replacement.configuredTriggers[0]!.id);
  expect(await destination.prisma.agentProposal.count()).toBe(0);
});

it('preserves archived and exhausted revision bodies without promising ordinary editability', async () => {
  const input = structuredClone(fixed);
  input.data.projects[0]!.isArchived = true;
  input.data.recovery.automationDefinitions.definitions[0]!.definitionRevision = 2_147_483_647;
  input.data.recovery.automationDefinitions.definitions[0]!.managementRevision = 2_147_483_647;
  await dataBackupService.importData(exportDataSchema.parse(input));
  const row = await destination.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: 'body-definition' },
  });
  expect(row).toMatchObject({
    definitionRevision: 2_147_483_647,
    managementRevision: 2_147_483_647,
    isEnabled: false,
  });
  expect(
    await destination.prisma.project.findUniqueOrThrow({ where: { id: row.projectId } })
  ).toMatchObject({ isArchived: true });
});

it('uses new projects only, preserves occupied local enabled identities and associations, and counts source evidence', async () => {
  const local = await createLedgerFixture(destination, runtime);
  const before = await destination.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: local.definitionId },
  });
  const trigger = await destination.prisma.agentTrigger.findUniqueOrThrow({
    where: { id: local.triggerId },
  });
  const connection = await destination.prisma.agentConnection.update({
    where: { id: local.connectionId },
    data: { credentialsEncrypted: 'local-secret' },
  });
  const input = structuredClone(fixed);
  const project = input.data.projects[0]!;
  await destination.prisma.project.create({
    data: {
      ...project,
      id: 'slug-collision',
      issueProvider: 'GITHUB',
      issueTrackerConfig: Prisma.DbNull,
      createdAt: new Date(project.createdAt),
      updatedAt: new Date(project.updatedAt),
    },
  });
  input.data.projects.push({ ...project, id: 'healthy-project', slug: 'healthy-project' });
  const row = input.data.recovery.automationDefinitions.definitions[0]!;
  input.data.recovery.automationDefinitions.definitions = [
    { ...row, id: local.definitionId },
    { ...row, id: 'missing-parent' },
    { ...row, id: 'same-name-a', projectId: 'healthy-project' },
    { ...row, id: 'same-name-b', projectId: 'healthy-project' },
  ];
  const result = await dataBackupService.importData(exportDataSchema.parse(input));
  expect(result.recovery.automationDefinitions).toEqual({
    model: 'AgentDefinition',
    imported: 2,
    skipped: 2,
    sourceEnabled: 4,
    restoredDisabled: 2,
    reasons: { EXISTING_IDENTITY: 1, INCOMPLETE_DEPENDENCY: 1 },
  });
  expect(
    await destination.prisma.agentDefinition.findUniqueOrThrow({ where: { id: before.id } })
  ).toEqual(before);
  expect(
    await destination.prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id } })
  ).toEqual(trigger);
  expect(
    await destination.prisma.agentConnection.findUniqueOrThrow({ where: { id: connection.id } })
  ).toEqual(connection);
  expect(
    (await dataBackupService.importData(exportDataSchema.parse(input))).recovery
      .automationDefinitions
  ).toMatchObject({
    imported: 0,
    skipped: 4,
    reasons: { EXISTING_IDENTITY: 3, INCOMPLETE_DEPENDENCY: 1 },
  });
});

it.each(['id', 'compatible'] as const)(
  'does not borrow an existing %s Project parent',
  async (kind) => {
    const project = fixed.data.projects[0]!;
    await destination.prisma.project.create({
      data: {
        ...project,
        name: kind === 'id' ? 'Different owner data' : project.name,
        issueProvider: 'GITHUB',
        issueTrackerConfig: Prisma.DbNull,
        createdAt: new Date(project.createdAt),
        updatedAt: new Date(project.updatedAt),
      },
    });
    expect(
      (await dataBackupService.importData(exportDataSchema.parse(fixed))).recovery
        .automationDefinitions
    ).toMatchObject({
      imported: 0,
      skipped: 1,
      sourceEnabled: 1,
      restoredDisabled: 0,
      reasons: { EXISTING_IDENTITY: 0, INCOMPLETE_DEPENDENCY: 1 },
    });
  }
);

it('reads over 1000 actual occupied target IDs unfiltered and completes the plan before the first project write', async () => {
  const local = await destination.prisma.project.create({
    data: {
      name: 'Local',
      slug: 'local',
      repoPath: '/local',
      worktreeBasePath: '/local/w',
    },
  });
  await destination.prisma.agentDefinition.createMany({
    data: Array.from({ length: 1002 }, (_, i) => ({
      id: `occupied-${i}`,
      projectId: local.id,
      name: 'Local',
      instructions: 'Local',
    })),
  });
  const original = recovery.planAutomationDefinitionsRecovery;
  let observed = false;
  const spy = vi
    .spyOn(recovery, 'planAutomationDefinitionsRecovery')
    .mockImplementation(async (tx, section, ids) => {
      const read = vi.spyOn(tx.agentDefinition, 'findMany');
      try {
        expect(await tx.project.count({ where: { id: 'body-project' } })).toBe(0);
        const plan = await original(tx, section, ids);
        expect(read).toHaveBeenCalledExactlyOnceWith({ select: { id: true } });
        expect(await read.mock.results[0]!.value).toHaveLength(1002);
        expect(await tx.project.count({ where: { id: 'body-project' } })).toBe(0);
        observed = true;
        return plan;
      } finally {
        read.mockRestore();
      }
    });
  try {
    const input = structuredClone(fixed);
    input.data.recovery.automationDefinitions.definitions.push({
      ...input.data.recovery.automationDefinitions.definitions[0]!,
      id: 'healthy-after-full-plan',
    });
    input.data.recovery.automationDefinitions.definitions[0]!.id = 'occupied-1001';
    expect(
      (await dataBackupService.importData(exportDataSchema.parse(input))).recovery
        .automationDefinitions
    ).toMatchObject({ imported: 1, skipped: 1, reasons: { EXISTING_IDENTITY: 1 } });
    expect(observed).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('rolls back base projects and definitions after actual/planned parent disagreement', async () => {
  const original = recovery.planAutomationDefinitionsRecovery;
  const spy = vi
    .spyOn(recovery, 'planAutomationDefinitionsRecovery')
    .mockImplementation(async (...args) => {
      const plan = await original(...args);
      plan[0]!.dependenciesAvailable = false;
      return plan;
    });
  try {
    await expect(dataBackupService.importData(exportDataSchema.parse(fixed))).rejects.toThrow(
      'dependencies disagree with admission'
    );
    expect(await destination.prisma.project.count()).toBe(0);
    expect(await destination.prisma.agentDefinition.count()).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

it('rolls back the entire import after late settings insertion observes an actually inserted definition', async () => {
  await author();
  await source.prisma.userSettings.create({ data: {} });
  const file = await dataBackupService.exportData('rollback');
  state.prisma = destination.prisma;
  await destination.prisma.$executeRawUnsafe(
    "CREATE TRIGGER fail_after_definition BEFORE INSERT ON UserSettings WHEN EXISTS (SELECT 1 FROM AgentDefinition WHERE projectId = 'authored-project') BEGIN SELECT RAISE(ABORT, 'observed actual definition insertion'); END"
  );
  try {
    await expect(dataBackupService.importData(file)).rejects.toThrow(/userSettings.create/);
    expect(await destination.prisma.project.count()).toBe(0);
    expect(await destination.prisma.workspace.count()).toBe(0);
    expect(await destination.prisma.agentDefinition.count()).toBe(0);
    expect(await destination.prisma.userSettings.count()).toBe(0);
  } finally {
    await destination.prisma.$executeRawUnsafe('DROP TRIGGER fail_after_definition');
  }
});

it('exports one complete earlier readonly snapshot while a concurrent body/preferences/revision edit commits', async () => {
  const authored = await author();
  const old = await source.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: authored.input.agentId },
  });
  await source.prisma.$queryRaw`PRAGMA journal_mode = WAL`;
  let committed = false;
  state.beforeAccounts = async () => {
    await source.prisma.agentDefinition.update({
      where: { id: old.id },
      data: {
        instructions: 'Concurrent new body',
        executionConfig: { version: 1, provider: 'CLAUDE' },
        definitionRevision: old.definitionRevision + 1,
        managementRevision: old.managementRevision + 1,
        updatedAt: new Date('2026-11-03T17:00:00.000Z'),
      },
    });
    committed = true;
  };
  try {
    const file = await dataBackupService.exportData('snapshot');
    expect(committed).toBe(true);
    const { validatedIntent: _oldIntent, ...exported } = old;
    expect(file.data).toHaveProperty('recovery.automationDefinitions.definitions', [
      {
        ...exported,
        createdAt: old.createdAt.toISOString(),
        updatedAt: old.updatedAt.toISOString(),
      },
    ]);
    expect(
      await source.prisma.agentDefinition.findUniqueOrThrow({ where: { id: old.id } })
    ).toMatchObject({
      instructions: 'Concurrent new body',
      executionConfig: { version: 1, provider: 'CLAUDE' },
      definitionRevision: old.definitionRevision + 1,
      managementRevision: old.managementRevision + 1,
      updatedAt: new Date('2026-11-03T17:00:00.000Z'),
    });
  } finally {
    state.beforeAccounts = undefined;
  }
});

it('rejects unsupported stored preferences visibly on public export', async () => {
  await dataBackupService.importData(exportDataSchema.parse(fixed));
  await destination.prisma.agentDefinition.update({
    where: { id: 'body-definition' },
    data: { executionConfig: { version: 1, env: {} } },
  });
  await expect(dataBackupService.exportData('unsupported')).rejects.toThrow('Unrecognized key');
});

it('keeps imported definitions absent from source/evaluation/claim work while healthy local runtime progresses', async () => {
  const local = await createLedgerFixture(destination, runtime);
  await dataBackupService.importData(exportDataSchema.parse(fixed));
  const imported = await destination.prisma.agentDefinition.findUniqueOrThrow({
    where: { id: 'body-definition' },
  });
  expect(
    await destination.prisma.agentTrigger.count({ where: { agentDefinitionId: imported.id } })
  ).toBe(0);
  const feed: AgentIssueEventPage['events'] = [{ providerEventId: 'runtime-B', payload: null }];
  const poll = new runtime.AgentSourcePollService(
    {
      getRepositoryIdentity: async () => ({ id: 'repo-1', name: 'org/repo' }),
      listIssueEvents: async () => ({ events: feed, nextPage: null }),
      classifyError: () => 'rate_limit',
    },
    () => 10
  );
  const signal = new AbortController().signal;
  await poll.prepareBaseline(local.connectionId, signal);
  feed.unshift({ providerEventId: 'runtime-C', payload: local.github('runtime-C').payload });
  await poll.pollCycle(signal);
  const evaluate = new runtime.AgentEventEvaluationService({
    resolveExecution: async () => ({ version: 1, provider: 'CLAUDE', model: 'sonnet' }),
  });
  await evaluate.evaluatePendingEvents(signal);
  expect(
    await destination.prisma.agentEvaluation.count({
      where: { agentDefinitionId: local.definitionId },
    })
  ).toBeGreaterThan(0);
  expect(await runtime.claimNextRun()).toMatchObject({ status: 'CLAIMED' });
  for (const count of [
    await destination.prisma.agentEvaluation.count({ where: { agentDefinitionId: imported.id } }),
    await destination.prisma.agentRun.count({ where: { agentDefinitionId: imported.id } }),
  ]) {
    expect(count).toBe(0);
  }
  expect(
    await destination.prisma.agentDefinition.findUniqueOrThrow({ where: { id: imported.id } })
  ).toEqual(imported);
});

it.each(['name', 'instructions'] as const)(
  'fails public export visibly for unsupported stored blank %s without mutation',
  async (field) => {
    await dataBackupService.importData(exportDataSchema.parse(fixed));
    const row = await destination.prisma.agentDefinition.update({
      where: { id: 'body-definition' },
      data: { [field]: ' \n\t' },
    });
    await expect(dataBackupService.exportData('unsupported-blank')).rejects.toMatchObject({
      name: 'ZodError',
      issues: [
        {
          code: 'custom',
          path: ['definitions', 0, field],
          message: 'Definition text must not be blank',
        },
      ],
    });
    expect(
      await destination.prisma.agentDefinition.findUniqueOrThrow({ where: { id: row.id } })
    ).toEqual(row);
  }
);
