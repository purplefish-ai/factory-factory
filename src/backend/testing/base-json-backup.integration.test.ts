import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { expectBackupWriterUnopened } from '@/backend/services/settings/resources/backup-writer.test-support';
import { adminRouter } from '@/backend/trpc/admin.trpc';
import type { Context } from '@/backend/trpc/trpc';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import full from '@/shared/testing/recovery-base-json-v8.fixture.json';
import fixed from '@/shared/testing/recovery-base-json-workspace-v8.fixture.json';
import { malformedWorkspaceJsonCases } from '@/shared/testing/recovery-json-storage.fixture';
import { Prisma, type PrismaClient } from '@prisma-gen/client';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  clearIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';
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
afterAll(async () => {
  await destroyIntegrationDatabase(source);
  await destroyIntegrationDatabase(destination);
});
beforeEach(async () => {
  await clearIntegrationDatabase(source.prisma);
  await clearIntegrationDatabase(destination.prisma);
  state.prisma = destination.prisma;
});
const physical = (prisma: PrismaClient) =>
  prisma.$queryRaw`SELECT id, typeof("creationMetadata") AS storage, json_type("creationMetadata") AS kind FROM "Workspace" ORDER BY id`;
it('roundtrips physical SQL NULL, JSON null and structured values through the public service', async () => {
  state.prisma = source.prisma;
  await source.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  const values = [
    Prisma.DbNull,
    Prisma.JsonNull,
    { nested: null },
    [null, 3],
    'text',
    7,
    false,
    Prisma.JsonNull,
    Prisma.JsonNull,
  ];
  const ids = [
    'sql',
    'json|reserved',
    '__proto__',
    'a|b',
    'string',
    'number',
    'boolean',
    'constructor',
    '',
  ];
  for (let i = 0; i < values.length; i++) {
    await source.prisma.workspace.create({
      data: { id: ids[i]!, projectId: 'p', name: `W${i}`, creationMetadata: values[i]! },
    });
  }
  // URLs are unique within a workspace, but may legitimately repeat across workspaces.
  for (const workspaceId of ['sql', '']) {
    await source.prisma.workspacePR.create({
      data: { workspaceId, url: 'https://github.com/o/r/pull/1', number: 1, state: 'OPEN' },
    });
  }
  const before = await physical(source.prisma);
  expect(before).toEqual(
    expect.arrayContaining([
      { id: 'sql', storage: 'null', kind: null },
      { id: '', storage: 'text', kind: 'null' },
      { id: '__proto__', storage: 'text', kind: 'object' },
    ])
  );
  const backup = await dataBackupService.exportData('test');
  expect(backup.data).toHaveProperty('recovery.baseJson', {
    version: 1,
    jsonStorage: ['', 'constructor', 'json|reserved'].map((id) => ({
      model: 'Workspace',
      identity: [id],
      field: 'creationMetadata',
    })),
  });
  state.prisma = destination.prisma;
  const result = await dataBackupService.importData(backup);
  expect(result.workspaces).toEqual({ imported: 9, skipped: 0 });
  expect(await physical(destination.prisma)).toEqual(before);
  expect(
    await destination.prisma.workspacePR.count({ where: { url: 'https://github.com/o/r/pull/1' } })
  ).toBe(2);
  for (const id of ids) {
    expect(
      (await destination.prisma.workspace.findUniqueOrThrow({ where: { id } })).creationMetadata
    ).toEqual(
      (await source.prisma.workspace.findUniqueOrThrow({ where: { id } })).creationMetadata
    );
  }
});
it.each(malformedWorkspaceJsonCases)(
  'rejects %s at public service and router before opening writer',
  async (_name, mutate) => {
    const file = structuredClone(fixed);
    mutate(file);
    await expectBackupWriterUnopened(async () => {
      await expect(
        Reflect.apply(dataBackupService.importData, dataBackupService, [file])
      ).rejects.toBeInstanceOf(ZodError);
      const caller = adminRouter.createCaller({
        appContext: { services: { dataBackupService } },
      } as unknown as Context);
      await expect(Reflect.apply(caller.importData, caller, [file])).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
    expect(await destination.prisma.workspace.count()).toBe(0);
  }
);
it('declares an empty section for all SQL NULL rows and restores explicit SQL NULL', async () => {
  state.prisma = source.prisma;
  await source.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await source.prisma.workspace.create({
    data: { id: 'sql', projectId: 'p', name: 'SQL', creationMetadata: Prisma.DbNull },
  });
  await source.prisma.workspacePR.create({
    data: {
      id: 'pr',
      workspaceId: 'sql',
      url: 'https://github.com/o/r/pull/1',
      observation: Prisma.DbNull,
    },
  });
  await source.prisma.agentSession.create({
    data: {
      id: 'session',
      workspaceId: 'sql',
      workflow: 'default',
      provider: 'CLAUDE',
      providerMetadata: Prisma.DbNull,
    },
  });
  const backup = await dataBackupService.exportData('test');
  expect(backup.meta).toHaveProperty('recovery.capabilities', { baseJson: 1 });
  expect(backup.data).toHaveProperty('recovery.baseJson', { version: 1, jsonStorage: [] });
  state.prisma = destination.prisma;
  await dataBackupService.importData(backup);
  expect(await physical(destination.prisma)).toEqual([{ id: 'sql', storage: 'null', kind: null }]);
  expect(
    await destination.prisma
      .$queryRaw`SELECT typeof("observation") AS storage, json_type("observation") AS kind FROM "WorkspacePR"`
  ).toEqual([{ storage: 'null', kind: null }]);
  expect(
    await destination.prisma
      .$queryRaw`SELECT typeof("providerMetadata") AS storage, json_type("providerMetadata") AS kind FROM "AgentSession"`
  ).toEqual([{ storage: 'null', kind: null }]);
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('captures rows and markers from the same readonly snapshot across an application commit', async () => {
  state.prisma = source.prisma;
  await source.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await source.prisma.workspace.create({
    data: { id: 'sql', projectId: 'p', name: 'SQL', creationMetadata: Prisma.DbNull },
  });
  await source.prisma.workspacePR.create({
    data: {
      id: 'pr',
      workspaceId: 'sql',
      url: 'https://github.com/o/r/pull/1',
      observation: Prisma.DbNull,
    },
  });
  await source.prisma.agentSession.create({
    data: {
      id: 'session',
      workspaceId: 'sql',
      workflow: 'default',
      provider: 'CLAUDE',
      providerMetadata: Prisma.DbNull,
    },
  });
  const reached = deferred();
  const committed = deferred();
  state.beforeAccounts = async () => {
    reached.resolve();
    await committed.promise;
  };
  const pending = dataBackupService.exportData('test');
  try {
    await reached.promise;
    await source.prisma.workspace.update({
      where: { id: 'sql' },
      data: { creationMetadata: Prisma.JsonNull },
    });
    await source.prisma.workspacePR.update({
      where: { id: 'pr' },
      data: { observation: Prisma.JsonNull },
    });
    await source.prisma.agentSession.update({
      where: { id: 'session' },
      data: { providerMetadata: Prisma.JsonNull },
    });
  } finally {
    committed.resolve();
    state.beforeAccounts = undefined;
  }
  const backup = await pending;
  expect(backup.data.workspaces[0]?.creationMetadata).toBeNull();
  expect(backup.data.workspaces[0]?.prs[0]?.observation).toBeNull();
  expect(backup.data.agentSessions[0]?.providerMetadata).toBeNull();
  expect(
    await source.prisma
      .$queryRaw`SELECT typeof("observation") AS storage, json_type("observation") AS kind FROM "WorkspacePR"`
  ).toEqual([{ storage: 'text', kind: 'null' }]);
  expect(
    await source.prisma
      .$queryRaw`SELECT typeof("providerMetadata") AS storage, json_type("providerMetadata") AS kind FROM "AgentSession"`
  ).toEqual([{ storage: 'text', kind: 'null' }]);
  expect(backup.data).toHaveProperty('recovery.baseJson.jsonStorage', []);
  expect(await physical(source.prisma)).toEqual([{ id: 'sql', storage: 'text', kind: 'null' }]);
  state.prisma = destination.prisma;
  await dataBackupService.importData(backup);
  expect(await physical(destination.prisma)).toEqual([{ id: 'sql', storage: 'null', kind: null }]);
  expect(
    await destination.prisma
      .$queryRaw`SELECT typeof("observation") AS storage, json_type("observation") AS kind FROM "WorkspacePR"`
  ).toEqual([{ storage: 'null', kind: null }]);
  expect(
    await destination.prisma
      .$queryRaw`SELECT typeof("providerMetadata") AS storage, json_type("providerMetadata") AS kind FROM "AgentSession"`
  ).toEqual([{ storage: 'null', kind: null }]);
});
it('leaves collision storage untouched, imports unrelated marked rows and reports actual repeated skips', async () => {
  await destination.prisma.project.create({
    data: {
      id: 'local',
      name: 'Local',
      slug: 'local',
      repoPath: '/local',
      worktreeBasePath: '/local/w',
    },
  });
  await destination.prisma.workspace.create({
    data: {
      id: 'root',
      projectId: 'local',
      name: 'Local workspace',
      creationMetadata: { local: null },
    },
  });
  const file = structuredClone(fixed);
  file.data.recovery.baseJson.jsonStorage.push({
    model: 'Workspace',
    identity: ['healthy'],
    field: 'creationMetadata',
  });
  const localBefore = await destination.prisma.workspace.findUniqueOrThrow({
    where: { id: 'root' },
  });
  const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [file]);
  expect(result.workspaces).toEqual({ imported: 1, skipped: 2 });
  expect(await destination.prisma.workspace.findUniqueOrThrow({ where: { id: 'root' } })).toEqual(
    localBefore
  );
  expect(await physical(destination.prisma)).toEqual([
    { id: 'healthy', storage: 'text', kind: 'null' },
    { id: 'root', storage: 'text', kind: 'object' },
  ]);
  expect(result.recovery.unreportedTotals).toBe('EMBEDDED_ROWS_AND_ACCOUNT_MAPPINGS');
  const repeated = await Reflect.apply(dataBackupService.importData, dataBackupService, [file]);
  expect(repeated.workspaces).toEqual({ imported: 0, skipped: 3 });
});
it('rolls back all three marked catalog writes when a later insert fails', async () => {
  const file = structuredClone(full);
  Object.assign(file.data.recovery.baseJson, {
    jsonStorage: [
      ...file.data.recovery.baseJson.jsonStorage,
      { model: 'WorkspacePR', identity: ['pr-root'], field: 'observation' },
      { model: 'AgentSession', identity: ['session'], field: 'providerMetadata' },
    ],
  });
  await destination.prisma.$executeRawUnsafe(
    "CREATE TRIGGER fail_terminal BEFORE INSERT ON TerminalSession BEGIN SELECT RAISE(ABORT, 'late write'); END"
  );
  try {
    await expect(
      Reflect.apply(dataBackupService.importData, dataBackupService, [file])
    ).rejects.toThrow(/terminalSession.create/);
    expect(await destination.prisma.project.count()).toBe(0);
    expect(await destination.prisma.workspace.count()).toBe(0);
    expect(await destination.prisma.agentSession.count()).toBe(0);
  } finally {
    await destination.prisma.$executeRawUnsafe('DROP TRIGGER fail_terminal');
  }
});

it('roundtrips PR and session SQL NULL versus JSON null at their existing insert sites', async () => {
  state.prisma = source.prisma;
  await source.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  await source.prisma.workspace.create({ data: { id: 'w', projectId: 'p', name: 'W' } });
  for (const [id, value] of [
    ['sql', Prisma.DbNull],
    ['json', Prisma.JsonNull],
    ['object', redObservation],
  ] as const) {
    await source.prisma.workspacePR.create({
      data: {
        id,
        workspaceId: 'w',
        url: `https://github.com/o/r/pull/${id}`,
        number: 1,
        state: 'OPEN',
        observation: value,
      },
    });
    await source.prisma.agentSession.create({
      data: {
        id,
        workspaceId: 'w',
        name: id,
        workflow: 'default',
        provider: 'CLAUDE',
        providerMetadata: id === 'object' ? { nested: null } : value,
      },
    });
  }
  const read = async (prisma: PrismaClient) => ({
    prs: await prisma.$queryRaw`SELECT id, typeof("observation") AS storage, json_type("observation") AS kind FROM "WorkspacePR" ORDER BY id`,
    sessions:
      await prisma.$queryRaw`SELECT id, typeof("providerMetadata") AS storage, json_type("providerMetadata") AS kind FROM "AgentSession" ORDER BY id`,
  });
  const expected = [
    { id: 'json', storage: 'text', kind: 'null' },
    { id: 'object', storage: 'text', kind: 'object' },
    { id: 'sql', storage: 'null', kind: null },
  ];
  expect(await read(source.prisma)).toEqual({ prs: expected, sessions: expected });
  const backup = await dataBackupService.exportData('test');
  expect(backup.meta).toHaveProperty('recovery.profile', 'base-json-1');
  state.prisma = destination.prisma;
  const result = await dataBackupService.importData(backup);
  expect(result.agentSessions).toEqual({ imported: 3, skipped: 0 });
  expect(await read(destination.prisma)).toEqual({ prs: expected, sessions: expected });
  expect(
    (await destination.prisma.workspacePR.findUniqueOrThrow({ where: { id: 'object' } }))
      .observation
  ).toEqual(redObservation);
  expect(
    (await destination.prisma.agentSession.findUniqueOrThrow({ where: { id: 'object' } }))
      .providerMetadata
  ).toEqual({ nested: null });
  expect(backup.data).toHaveProperty('recovery.baseJson.jsonStorage', [
    { model: 'WorkspacePR', identity: ['json'], field: 'observation' },
    { model: 'AgentSession', identity: ['json'], field: 'providerMetadata' },
  ]);
});

it.each(['missing', 'undefined'])(
  'rejects raw %s observations before any private writer',
  async (kind) => {
    const file = structuredClone(full);
    const pr = file.data.workspaces[0]!.prs[0]!;
    if (kind === 'missing') {
      Reflect.deleteProperty(pr, 'observation');
    } else {
      Object.assign(pr, { observation: undefined });
    }
    file.data.recovery.baseJson.jsonStorage = [];
    await expectBackupWriterUnopened(async () => {
      await expect(
        Reflect.apply(dataBackupService.importData, dataBackupService, [file])
      ).rejects.toBeInstanceOf(ZodError);
      const caller = adminRouter.createCaller({
        appContext: { services: { dataBackupService } },
      } as unknown as Context);
      await expect(Reflect.apply(caller.importData, caller, [file])).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
  }
);

it('preserves session scalar/array metadata and empty or reserved identities', async () => {
  state.prisma = source.prisma;
  await source.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/p', worktreeBasePath: '/w' },
  });
  await source.prisma.workspace.create({
    data: { id: '', projectId: 'p', name: 'W', creationMetadata: Prisma.DbNull },
  });
  const values = [
    ['', Prisma.JsonNull],
    ['__proto__', [null, 3]],
    ['a|b', 'text'],
    ['constructor', 7],
    ['false', false],
  ] as const;
  for (const [id, value] of values) {
    await source.prisma.agentSession.create({
      data: {
        id,
        workspaceId: '',
        workflow: 'default',
        provider: 'CLAUDE',
        providerMetadata:
          value === Prisma.JsonNull ? value : Array.isArray(value) ? [...value] : value,
      },
    });
  }
  const physicalSessions = (prisma: PrismaClient) =>
    prisma.$queryRaw`SELECT id, typeof("providerMetadata") AS storage, json_type("providerMetadata") AS kind FROM "AgentSession" ORDER BY id`;
  const before = await physicalSessions(source.prisma);
  expect(before).toEqual([
    { id: '', storage: 'text', kind: 'null' },
    { id: '__proto__', storage: 'text', kind: 'array' },
    { id: 'a|b', storage: 'text', kind: 'text' },
    { id: 'constructor', storage: 'integer', kind: 'integer' },
    { id: 'false', storage: 'text', kind: 'false' },
  ]);
  const backup = await dataBackupService.exportData('test');
  expect(backup.data).toHaveProperty('recovery.baseJson.jsonStorage', [
    { model: 'AgentSession', identity: [''], field: 'providerMetadata' },
  ]);
  state.prisma = destination.prisma;
  const result = await dataBackupService.importData(backup);
  expect(result.agentSessions).toEqual({ imported: 5, skipped: 0 });
  expect(await physicalSessions(destination.prisma)).toEqual(before);
  for (const [id] of values) {
    expect(
      (await destination.prisma.agentSession.findUniqueOrThrow({ where: { id } })).providerMetadata
    ).toEqual(
      (await source.prisma.agentSession.findUniqueOrThrow({ where: { id } })).providerMetadata
    );
  }
});

it('keeps all three local physical states on collisions and imports an unrelated marked graph', async () => {
  await destination.prisma.project.create({
    data: {
      id: 'local',
      name: 'Local',
      slug: 'local',
      repoPath: '/local',
      worktreeBasePath: '/local/w',
    },
  });
  await destination.prisma.workspace.create({
    data: { id: 'root', projectId: 'local', name: 'Local', creationMetadata: { local: null } },
  });
  await destination.prisma.workspacePR.create({
    data: {
      id: 'pr-root',
      workspaceId: 'root',
      url: 'https://github.com/local/r/pull/1',
      observation: Prisma.DbNull,
    },
  });
  await destination.prisma.agentSession.create({
    data: {
      id: 'session',
      workspaceId: 'root',
      workflow: 'local',
      provider: 'CLAUDE',
      providerMetadata: Prisma.JsonNull,
    },
  });
  const before = await destination.prisma.workspace.findUniqueOrThrow({
    where: { id: 'root' },
    include: { prs: true, agentSessions: true },
  });
  const file = structuredClone(full);
  file.data.agentSessions.push({
    ...file.data.agentSessions[0]!,
    id: 'healthy-session',
    workspaceId: 'healthy',
    workspacePrId: 'pr-healthy',
  });
  Object.assign(file.data.recovery.baseJson, {
    jsonStorage: [
      { model: 'Workspace', identity: ['root'], field: 'creationMetadata' },
      { model: 'Workspace', identity: ['healthy'], field: 'creationMetadata' },
      { model: 'WorkspacePR', identity: ['pr-root'], field: 'observation' },
      { model: 'WorkspacePR', identity: ['pr-healthy'], field: 'observation' },
      { model: 'AgentSession', identity: ['session'], field: 'providerMetadata' },
      { model: 'AgentSession', identity: ['healthy-session'], field: 'providerMetadata' },
    ],
  });
  const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [file]);
  expect(result.workspaces).toEqual({ imported: 1, skipped: 2 });
  expect(result.agentSessions).toEqual({ imported: 1, skipped: 1 });
  expect(
    await destination.prisma.workspace.findUniqueOrThrow({
      where: { id: 'root' },
      include: { prs: true, agentSessions: true },
    })
  ).toEqual(before);
  const read = () =>
    destination.prisma
      .$queryRaw`SELECT 'Workspace' AS model, id, typeof("creationMetadata") AS storage, json_type("creationMetadata") AS kind FROM "Workspace" UNION ALL SELECT 'WorkspacePR', id, typeof("observation"), json_type("observation") FROM "WorkspacePR" UNION ALL SELECT 'AgentSession', id, typeof("providerMetadata"), json_type("providerMetadata") FROM "AgentSession" ORDER BY model, id`;
  const expected = [
    { model: 'AgentSession', id: 'healthy-session', storage: 'text', kind: 'null' },
    { model: 'AgentSession', id: 'session', storage: 'text', kind: 'null' },
    { model: 'Workspace', id: 'healthy', storage: 'text', kind: 'null' },
    { model: 'Workspace', id: 'root', storage: 'text', kind: 'object' },
    { model: 'WorkspacePR', id: 'pr-healthy', storage: 'text', kind: 'null' },
    { model: 'WorkspacePR', id: 'pr-root', storage: 'null', kind: null },
  ];
  expect(await read()).toEqual(expected);
  const repeated = await Reflect.apply(dataBackupService.importData, dataBackupService, [file]);
  expect(repeated.workspaces).toEqual({ imported: 0, skipped: 3 });
  expect(repeated.agentSessions).toEqual({ imported: 0, skipped: 2 });
  expect(await read()).toEqual(expected);
});

it.each(['WorkspacePR', 'AgentSession'] as const)(
  'rejects a non-null %s marker target at service and router before opening the writer',
  async (model) => {
    const file = structuredClone(full);
    const pr = file.data.workspaces[0]!.prs[0]!;
    const session = file.data.agentSessions[0]!;
    if (model === 'WorkspacePR') {
      Object.assign(pr, { observation: redObservation });
    } else {
      Object.assign(session, { providerMetadata: { nested: null } });
    }
    expect(exportDataSchema.safeParse(file).success).toBe(true);
    const otherMarkers = structuredClone(file.data.recovery.baseJson.jsonStorage);
    const marker =
      model === 'WorkspacePR'
        ? { model, identity: [pr.id], field: 'observation' }
        : { model, identity: [session.id], field: 'providerMetadata' };
    Object.assign(file.data.recovery.baseJson, { jsonStorage: [...otherMarkers, marker] });
    await expectBackupWriterUnopened(async () => {
      await expect(
        Reflect.apply(dataBackupService.importData, dataBackupService, [file])
      ).rejects.toThrow(`Invalid ${model} JSON-null target`);
      const caller = adminRouter.createCaller({
        appContext: { services: { dataBackupService } },
      } as unknown as Context);
      await expect(Reflect.apply(caller.importData, caller, [file])).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
    file.data.recovery.baseJson.jsonStorage.pop();
    expect(file.data.recovery.baseJson.jsonStorage).toEqual(otherMarkers);
    expect(exportDataSchema.safeParse(file).success).toBe(true);
    expect(await destination.prisma.workspace.count()).toBe(0);
  }
);

it.each(['absent', 'empty'])(
  'accepts incoming full-profile flat PR aliases with %s prs but forbids borrowing a synthetic observation marker',
  async (prsShape) => {
    const file = structuredClone(full);
    const workspace = file.data.workspaces[2]!;
    const originalPR = workspace.prs[0]!;
    const otherMarkers = [
      ...file.data.recovery.baseJson.jsonStorage,
      { model: 'WorkspacePR', identity: ['pr-root'], field: 'observation' },
      { model: 'AgentSession', identity: ['session'], field: 'providerMetadata' },
    ];
    Object.assign(file.data.recovery.baseJson, {
      jsonStorage: [
        ...otherMarkers,
        { model: 'WorkspacePR', identity: [originalPR.id], field: 'observation' },
      ],
    });
    expect(exportDataSchema.safeParse(file).success).toBe(true);
    // This is an incoming compatibility contract; the current producer emits actual nested PRs.
    Object.assign(workspace, {
      prs: [],
      prUrl: originalPR.url,
      prNumber: originalPR.number,
      prState: originalPR.state,
    });
    if (prsShape === 'absent') {
      Reflect.deleteProperty(workspace, 'prs');
    }
    file.data.recovery.baseJson.jsonStorage.pop();
    expect(file.data.recovery.baseJson.jsonStorage).toEqual(otherMarkers);
    expect(exportDataSchema.safeParse(file).success).toBe(true);

    Object.assign(file.data.recovery.baseJson, {
      jsonStorage: [
        ...otherMarkers,
        { model: 'WorkspacePR', identity: ['legacy-pr-healthy'], field: 'observation' },
      ],
    });
    const invalid = exportDataSchema.safeParse(file);
    expect(invalid.success).toBe(false);
    if (invalid.success) {
      throw new Error('Expected invalid synthetic JSON-null marker');
    }
    const issues = invalid.error.issues.flatMap((issue) =>
      issue.code === 'invalid_union' ? issue.errors.flat() : [issue]
    );
    expect(issues).toContainEqual({
      code: 'custom',
      message: 'Invalid WorkspacePR JSON-null target',
      path: ['data', 'recovery', 'baseJson', 'jsonStorage', otherMarkers.length, 'identity'],
    });
    await expectBackupWriterUnopened(async () => {
      await expect(
        Reflect.apply(dataBackupService.importData, dataBackupService, [file])
      ).rejects.toThrow('Invalid WorkspacePR JSON-null target');
      const caller = adminRouter.createCaller({
        appContext: { services: { dataBackupService } },
      } as unknown as Context);
      await expect(Reflect.apply(caller.importData, caller, [file])).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
    expect(await destination.prisma.workspace.count()).toBe(0);
    file.data.recovery.baseJson.jsonStorage.pop();
    expect(file.data.recovery.baseJson.jsonStorage).toEqual(otherMarkers);
    expect(exportDataSchema.safeParse(file).success).toBe(true);
    const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [file]);
    expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
    expect(result.agentSessions).toEqual({ imported: 1, skipped: 0 });
    expect(result.recovery.manifest).toEqual(full.meta.recovery);
    expect(
      await destination.prisma.workspacePR.findUniqueOrThrow({ where: { id: 'legacy-pr-healthy' } })
    ).toMatchObject({
      workspaceId: 'healthy',
      url: originalPR.url,
      number: originalPR.number,
      state: originalPR.state,
    });
    expect(
      await destination.prisma.workspacePR.findUnique({ where: { id: originalPR.id } })
    ).toBeNull();
    expect(
      await destination.prisma
        .$queryRaw`SELECT typeof("observation") AS storage, json_type("observation") AS kind FROM "WorkspacePR" WHERE id = 'legacy-pr-healthy'`
    ).toEqual([{ storage: 'null', kind: null }]);
  }
);
