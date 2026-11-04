import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { discoverProjectAgentSources } from '@/backend/orchestration/agent-sources.orchestrator';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import * as slackRecovery from '@/backend/services/agent-definition';
import { SlackConnectionService } from '@/backend/services/agent-definition';
import { expectBackupWriterUnopened } from '@/backend/services/settings/resources/backup-writer.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { adminRouter } from '@/backend/trpc/admin.trpc';
import type { Context } from '@/backend/trpc/trpc';
import { slackConnectionsRecoverySchema } from '@/shared/schemas/slack-connections-recovery.schema';
import periodicHistoryWire from '@/shared/testing/recovery-periodic-history-v8.fixture.json';
import slack from '@/shared/testing/recovery-slack-connections-v8.fixture.json';
import type { PrismaClient } from '@prisma-gen/client';
const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
let destination: IntegrationDatabase;
let db: IntegrationDatabase;
const request = vi.fn<typeof fetch>();
const crypto = {
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
  decrypt: vi.fn((value: string) => value.slice(10)),
};
const service = new SlackConnectionService(crypto, request);
const section = () => slackConnectionsRecoverySchema.parse(slack.data.recovery.slackConnections);
function identify(team: string) {
  request.mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        team_id: team,
        team: 'Company',
        user_id: 'U-bot',
        bot_id: 'B-bot',
      })
    )
  );
}
beforeEach(async () => {
  destination = await createIntegrationDatabase();
  db = destination;
  state.prisma = destination.prisma;
  request.mockReset();
  crypto.encrypt.mockClear();
  crypto.decrypt.mockClear();
}, 30_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await destroyIntegrationDatabase(destination);
}, 30_000);

it('imports global Slack metadata independently, skips projects, and preserves reconnected local authority on repeat', async () => {
  const raw = structuredClone(slack);
  await destination.prisma.project.create({
    data: {
      id: raw.data.projects[0]!.id,
      name: 'Local',
      slug: raw.data.projects[0]!.slug,
      repoPath: '/local',
      worktreeBasePath: '/local-worktrees',
    },
  });
  const first = await Reflect.apply(dataBackupService.importData, dataBackupService, [raw]);
  expect(first.projects).toEqual({ imported: 0, skipped: raw.data.projects.length });
  expect(first.recovery.slackConnections).toEqual({
    model: 'AgentConnection',
    imported: 2,
    skipped: 0,
    sourceEnabled: 1,
    restoredDisabled: 2,
    reasons: { EXISTING_IDENTITY: 0 },
  });
  const id = 'slack-recovered-enabled';
  await destination.prisma.agentConnection.update({
    where: { id },
    data: { isEnabled: true, credentialsEncrypted: 'manual-local-cipher' },
  });
  const localDefinition = await destination.prisma.agentDefinition.create({
    data: {
      id: 'healthy-local-definition',
      projectId: raw.data.projects[0]!.id,
      name: 'Healthy local',
      instructions: 'Local body',
      isEnabled: true,
    },
  });
  const trigger = await destination.prisma.agentTrigger.create({
    data: {
      id: 'healthy-local-trigger',
      agentDefinitionId: localDefinition.id,
      connectionId: id,
      type: 'SLACK_MESSAGE',
      description: 'Healthy local trigger',
      config: { version: 1, channelIds: ['C-local'] },
      isEnabled: true,
      activationState: 'ACTIVE',
      activationGeneration: 1,
    },
  });
  const before = await destination.prisma.agentConnection.findMany({ orderBy: { id: 'asc' } });
  const repeated = await Reflect.apply(dataBackupService.importData, dataBackupService, [raw]);
  expect(repeated.recovery.slackConnections).toEqual({
    model: 'AgentConnection',
    imported: 0,
    skipped: 2,
    sourceEnabled: 1,
    restoredDisabled: 0,
    reasons: { EXISTING_IDENTITY: 2 },
  });
  expect(await destination.prisma.agentConnection.findMany({ orderBy: { id: 'asc' } })).toEqual(
    before
  );
  expect(
    await destination.prisma.agentTrigger.findUniqueOrThrow({ where: { id: trigger.id } })
  ).toEqual(trigger);
  expect(
    await destination.prisma.agentDefinition.findUniqueOrThrow({
      where: { id: localDefinition.id },
    })
  ).toEqual(localDefinition);
  const exported = await dataBackupService.exportData('test');
  expect(exported.data).toHaveProperty('recovery.slackConnections.connections', [
    expect.objectContaining({ id: 'slack-recovered-disabled', isEnabled: false }),
    expect.objectContaining({ id: 'slack-recovered-enabled', isEnabled: true }),
  ]);
  expect(JSON.stringify(exported)).not.toContain('manual-local-cipher');
});
it('imports global-only Slack metadata with zero projects and emits typed zero report for an empty section', async () => {
  const raw = structuredClone(slack);
  raw.data.projects = [];
  raw.data.workspaces = [];
  raw.data.agentSessions = [];
  raw.data.terminalSessions = [];
  raw.data.codexAccounts = [];
  raw.data.userSettings = null;
  raw.data.recovery.baseJson.jsonStorage = [];
  raw.data.recovery.periodicConfig.tasks = [];
  raw.data.recovery.periodicHistory.executions = [];
  raw.data.recovery.periodicHistory.jsonStorage = [];
  raw.data.recovery.automationDefinitions.definitions = [];
  const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [raw]);
  expect(result.projects).toEqual({ imported: 0, skipped: 0 });
  expect(result.recovery.slackConnections).toEqual({
    model: 'AgentConnection',
    imported: 2,
    skipped: 0,
    sourceEnabled: 1,
    restoredDisabled: 2,
    reasons: { EXISTING_IDENTITY: 0 },
  });
  raw.data.recovery.slackConnections.connections = [];
  expect(
    (await Reflect.apply(dataBackupService.importData, dataBackupService, [raw])).recovery
      .slackConnections
  ).toEqual({
    model: 'AgentConnection',
    imported: 0,
    skipped: 0,
    sourceEnabled: 0,
    restoredDisabled: 0,
    reasons: { EXISTING_IDENTITY: 0 },
  });
});
it('observes a successful Slack insert in the writer transaction before a later row failure rolls all domains back', async () => {
  const before = await destination.prisma.agentConnection.create({
    data: {
      id: 'healthy-slack',
      provider: 'SLACK',
      externalId: 'T-local',
      name: 'Healthy',
      isEnabled: true,
      credentialsEncrypted: 'local-cipher',
    },
  });
  await destination.prisma.$executeRawUnsafe(
    "CREATE TRIGGER fail_second_slack BEFORE INSERT ON AgentConnection WHEN NEW.id = 'slack-recovered-disabled' BEGIN SELECT RAISE(ABORT, 'late Slack insertion'); END"
  );
  let witnessed = false;
  const original = slackRecovery.restoreSlackConnectionsRecovery;
  const restore = vi
    .spyOn(slackRecovery, 'restoreSlackConnectionsRecovery')
    .mockImplementation(async (tx, plan) => {
      const first = plan.slice(0, 1);
      const result = await original(tx, first);
      expect(result.imported).toBe(1);
      expect(
        await tx.agentConnection.findUniqueOrThrow({ where: { id: first[0]!.row.id } })
      ).toMatchObject({ isEnabled: false, credentialsEncrypted: null });
      witnessed = true;
      return original(tx, plan.slice(1));
    });
  try {
    await expect(
      Reflect.apply(dataBackupService.importData, dataBackupService, [slack])
    ).rejects.toThrow(/agentConnection.create/);
    expect(witnessed).toBe(true);
    expect(await destination.prisma.agentConnection.findMany()).toEqual([before]);
    expect(await destination.prisma.project.count()).toBe(0);
    expect(await destination.prisma.workspace.count()).toBe(0);
    expect(await destination.prisma.agentDefinition.count()).toBe(0);
  } finally {
    restore.mockRestore();
    await destination.prisma.$executeRawUnsafe('DROP TRIGGER fail_second_slack');
  }
});
it.each(
  (
    [
      [
        'missing section',
        (input: typeof slack) => Reflect.deleteProperty(input.data.recovery, 'slackConnections'),
        'Slack profile sections do not match',
        undefined,
      ],
      [
        'credential property',
        (input: typeof slack) =>
          Object.assign(input.data.recovery.slackConnections.connections[0]!, {
            credentialsEncrypted: undefined,
          }),
        'credentialsEncrypted',
        undefined,
      ],
      [
        'duplicate workspace',
        (input: typeof slack) => {
          input.data.recovery.slackConnections.connections[1]!.externalId =
            input.data.recovery.slackConnections.connections[0]!.externalId;
        },
        'Duplicate Slack connection identity',
        undefined,
      ],
      ...(
        [
          ['space-only blank workspace', '   '],
          ['tab/newline-only blank workspace', '\t\n'],
          ['Unicode-whitespace-only blank workspace', '\u2003\u00a0'],
        ] as const
      ).map(
        ([name, externalId]) =>
          [
            name,
            (input: typeof slack) => {
              input.data.recovery.slackConnections.connections[0]!.externalId = externalId;
            },
            'Workspace ID must not be blank',
            ['data', 'recovery', 'slackConnections', 'connections', 0, 'externalId'],
          ] as const
      ),
    ] as const
  ).flatMap(([name, mutate, message, expectedPath]) =>
    (['service', 'router'] as const).map(
      (boundary) => [name, boundary, mutate, message, expectedPath] as const
    )
  )
)(
  'rejects malformed Slack %s via %s before opening the writer',
  async (_name, boundary, mutate, message, expectedPath) => {
    const input = structuredClone(slack);
    mutate(input);
    const caller = adminRouter.createCaller({
      appContext: { services: { dataBackupService } },
    } as unknown as Context);
    await expectBackupWriterUnopened(async () => {
      if (boundary === 'service') {
        const serviceImport = Reflect.apply(dataBackupService.importData, dataBackupService, [
          input,
        ]);
        await expect(serviceImport).rejects.toThrow(message);
        if (expectedPath) {
          expectBlankWorkspaceFailure(
            await serviceImport.catch((error: unknown) => error),
            expectedPath
          );
        }
      } else {
        const routerImport = Reflect.apply(caller.importData, caller, [input]);
        await expect(routerImport).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringContaining(message),
        });
        if (expectedPath) {
          const error = await routerImport.catch((failure: unknown) => failure);
          expect(error).toBeInstanceOf(TRPCError);
          if (error instanceof TRPCError) {
            expectBlankWorkspaceFailure(error.cause, expectedPath);
          }
        }
      }
    });
  }
);
it('admits global connection identities before the first import insert without per-row occupancy lookups', async () => {
  const planOriginal = slackRecovery.planSlackConnectionsRecovery;
  let inspected = false;
  const pendingSpies: Array<{ mockRestore(): void }> = [];
  const plan = vi
    .spyOn(slackRecovery, 'planSlackConnectionsRecovery')
    .mockImplementation(async (tx, section) => {
      const occupancy = vi.spyOn(tx.agentConnection, 'findMany');
      const projects = vi.spyOn(tx.project, 'create');
      const connections = vi.spyOn(tx.agentConnection, 'create');
      const perRow = vi.spyOn(tx.agentConnection, 'findUnique');
      pendingSpies.push(occupancy, projects, connections, perRow);
      expect(projects).not.toHaveBeenCalled();
      expect(connections).not.toHaveBeenCalled();
      const result = await planOriginal(tx, section);
      expect(occupancy).toHaveBeenCalledExactlyOnceWith({
        select: { id: true, provider: true, externalId: true },
      });
      expect(perRow).not.toHaveBeenCalled();
      expect(projects).not.toHaveBeenCalled();
      expect(connections).not.toHaveBeenCalled();
      inspected = true;
      return result;
    });
  try {
    const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [slack]);
    expect(inspected).toBe(true);
    expect(result.recovery.slackConnections?.imported).toBe(2);
  } finally {
    plan.mockRestore();
    for (const spy of pendingSpies) {
      spy.mockRestore();
    }
  }
});
it('restores disconnected identities, excludes readiness, and requires explicit same-team reconnect with a healthy-local control', async () => {
  identify('T-healthy');
  const healthy = await service.connect({ botToken: 'xoxb-healthy' });
  const local = await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: healthy.id } });
  const input = section();
  await Reflect.apply(dataBackupService.importData, dataBackupService, [slack]);
  request.mockClear();
  expect(await service.list()).toEqual(
    expect.arrayContaining(
      input.connections.map((row) =>
        expect.objectContaining({
          id: row.id,
          workspaceId: row.externalId,
          isEnabled: false,
          hasCredentials: false,
        })
      )
    )
  );
  const importedId = input.connections[0]!.id;
  await expect(service.channels(importedId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(request).not.toHaveBeenCalled();
  const services = {
    slackConnectionService: service,
    githubCLIService: { getAgentRepository: vi.fn() },
    agentProposalService: { saveGitHubConnection: vi.fn() },
  };
  const project = { id: 'p', name: 'P', isArchived: false, githubOwner: null, githubRepo: null };
  const sources = await discoverProjectAgentSources(project, {}, services);
  expect(JSON.stringify(sources)).not.toContain(importedId);
  expect(JSON.stringify(sources)).toContain(healthy.id);
  await expect(
    discoverProjectAgentSources(project, { connectionId: importedId }, services)
  ).rejects.toThrow('Slack source not found');
  request.mockResolvedValue(
    new Response(
      JSON.stringify({
        ok: true,
        channels: [{ id: 'C-healthy', name: 'healthy', is_member: true, is_archived: false }],
        response_metadata: { next_cursor: '' },
      })
    )
  );
  expect(await service.channels(healthy.id)).toMatchObject({ channels: [{ id: 'C-healthy' }] });
  const imported = await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: importedId } });
  identify('T-different');
  await service.connect({ botToken: 'xoxb-different' });
  expect(await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: importedId } })).toEqual(
    imported
  );
  identify(input.connections[0]!.externalId);
  expect(await service.connect({ botToken: 'xoxb-new-manual' })).toMatchObject({
    id: importedId,
    isEnabled: true,
    hasCredentials: true,
  });
  expect(
    await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: importedId } })
  ).toMatchObject({ credentialsEncrypted: 'encrypted:xoxb-new-manual' });
  expect(await db.prisma.agentConnection.findUniqueOrThrow({ where: { id: healthy.id } })).toEqual(
    local
  );
});

it('preserves inherited periodic links, physical JSON nulls, historical execution and definition bodies under the cumulative profile', async () => {
  const definition = {
    ...slack.data.recovery.automationDefinitions.definitions[0]!,
    projectId: periodicHistoryWire.data.projects[0]!.id,
  };
  const raw = {
    ...periodicHistoryWire,
    meta: slack.meta,
    data: {
      ...periodicHistoryWire.data,
      recovery: {
        ...periodicHistoryWire.data.recovery,
        automationDefinitions: { version: 1, definitions: [definition] },
        slackConnections: slack.data.recovery.slackConnections,
      },
    },
  };
  const imported = await Reflect.apply(dataBackupService.importData, dataBackupService, [raw]);
  expect(imported.recovery.slackConnections).toEqual({
    model: 'AgentConnection',
    imported: 2,
    skipped: 0,
    sourceEnabled: 1,
    restoredDisabled: 2,
    reasons: { EXISTING_IDENTITY: 0 },
  });
  expect(
    await destination.prisma.workspace.findUniqueOrThrow({ where: { id: 'root' } })
  ).toMatchObject({ periodicTaskId: 'scheduled-maintenance' });
  expect(
    await destination.prisma.periodicTask.findUniqueOrThrow({
      where: { id: 'scheduled-maintenance' },
    })
  ).toMatchObject({ isEnabled: false });
  expect(
    await destination.prisma.periodicTaskExecution.findUniqueOrThrow({
      where: { id: 'literal-history-running' },
    })
  ).toMatchObject({ status: 'FAILED', launchSnapshot: null });
  expect(
    await destination.prisma.agentDefinition.findUniqueOrThrow({ where: { id: definition.id } })
  ).toMatchObject({ instructions: definition.instructions, isEnabled: false });
  expect(
    await destination.prisma
      .$queryRaw`SELECT json_type("creationMetadata") AS kind FROM "Workspace" WHERE id = 'root'`
  ).toEqual([{ kind: 'null' }]);
  const exported = await dataBackupService.exportData('test');
  expect(exported.data).toHaveProperty(
    'recovery.baseJson',
    periodicHistoryWire.data.recovery.baseJson
  );
  expect(exported.data).toHaveProperty('recovery.slackConnections.connections', [
    expect.objectContaining({ id: 'slack-recovered-disabled', isEnabled: false }),
    expect.objectContaining({ id: 'slack-recovered-enabled', isEnabled: false }),
  ]);
});

function expectBlankWorkspaceFailure(error: unknown, path: readonly (string | number)[]) {
  expect(error).toBeInstanceOf(ZodError);
  if (error instanceof ZodError) {
    const issues = error.issues.flatMap((issue) =>
      issue.code === 'invalid_union' ? issue.errors.flat() : [issue]
    );
    expect(issues).toContainEqual({
      code: 'custom',
      path,
      message: 'Workspace ID must not be blank',
    });
  }
}

it('fails current export for a stored blank Slack workspace identity without mutating the row', async () => {
  const before = await destination.prisma.agentConnection.create({
    data: {
      id: 'unsupported-blank-workspace',
      provider: 'SLACK',
      externalId: '\t \n',
      name: 'Stored blank identity',
      isEnabled: false,
      credentialsEncrypted: null,
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
      updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    },
  });
  const exporting = dataBackupService.exportData('unsupported-blank-identity');
  await expect(exporting).rejects.toThrow('Workspace ID must not be blank');
  expectBlankWorkspaceFailure(await exporting.catch((error: unknown) => error), [
    'connections',
    0,
    'externalId',
  ]);
  expect(
    await destination.prisma.agentConnection.findUniqueOrThrow({ where: { id: before.id } })
  ).toEqual(before);
  expect(request).not.toHaveBeenCalled();
});

it('persists and reexports meaningful padded workspace identities and raw metadata without normalization', async () => {
  const input = structuredClone(slack);
  const reserved = {
    ...input.data.recovery.slackConnections.connections[0]!,
    id: '__proto__',
    externalId: ' T:padded-one ',
    name: ' ',
  };
  const empty = {
    ...input.data.recovery.slackConnections.connections[1]!,
    id: '',
    externalId: ' T:padded-two ',
    name: ' padded ',
  };
  input.data.recovery.slackConnections.connections = [reserved, empty];
  const imported = await Reflect.apply(dataBackupService.importData, dataBackupService, [input]);
  expect(imported.recovery.slackConnections).toEqual({
    model: 'AgentConnection',
    imported: 2,
    skipped: 0,
    sourceEnabled: 1,
    restoredDisabled: 2,
    reasons: { EXISTING_IDENTITY: 0 },
  });
  expect(await destination.prisma.agentConnection.findMany({ orderBy: { id: 'asc' } })).toEqual(
    [empty, reserved].map((row) => ({
      ...row,
      isEnabled: false,
      credentialsEncrypted: null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }))
  );
  const reexported = await dataBackupService.exportData('preserve-padded-identity');
  expect(reexported.data).toHaveProperty('recovery.slackConnections', {
    version: 1,
    connections: [
      { ...empty, isEnabled: false },
      { ...reserved, isEnabled: false },
    ],
  });
  expect(request).not.toHaveBeenCalled();
});
