import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { dataBackupService } from '@/backend/orchestration/data-backup/data-backup.service';
import { captureWorkspaceRunResults } from '@/backend/orchestration/workspace-lifecycle/workspace-deletion.orchestrator';
import { workspaceDataService } from '@/backend/services/workspace';
import { exportDataSchema, type ExportData } from '@/shared/schemas/export-data.schema';
import type { PrismaClient } from '@prisma-gen/client';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';
import { publishedVersion4Backup, publishedVersion5Backup } from './legacy-backup.fixture';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
let source: ExportData;
const project = (id: string) => ({
  id,
  slug: id,
  name: id,
  repoPath: '/repo',
  worktreeBasePath: '/trees',
  githubOwner: 'o',
  githubRepo: 'r',
});
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  workspaceDataService.configureDeletionCapture(captureWorkspaceRunResults);
  for (const id of ['p', 'healthy-project']) {
    await db.prisma.project.create({ data: project(id) });
  }
  for (const id of ['root', 'child', 'healthy']) {
    await db.prisma.workspace.create({
      data: {
        id,
        projectId: id === 'healthy' ? 'healthy-project' : 'p',
        name: id,
        status: 'READY',
        parentWorkspaceId: id === 'child' ? 'root' : null,
        creationMetadata: { authored: id },
        conversationMetadata: {
          create: { requestId: `source-${id}`, title: `Source ${id}`, summary: 'Authored summary' },
        },
        prs: {
          create: { id: `pr-${id}`, url: `https://github.com/o/r/pull/${id === 'root' ? 1 : 2}` },
        },
      },
    });
  }
  await db.prisma.agentSession.create({
    data: {
      id: 'session',
      workspaceId: 'root',
      workflow: 'implement',
      provider: 'CLAUDE',
      status: 'RUNNING',
      providerProcessPid: 123,
    },
  });
  await db.prisma.terminalSession.create({
    data: { id: 'terminal', workspaceId: 'root', name: 'Terminal', status: 'RUNNING', pid: 456 },
  });
  source = await dataBackupService.exportData('identity-collisions');
  source.data.workspaces.sort((a, b) => Number(a.id !== 'child') - Number(b.id !== 'child'));
}, 30_000);
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.workspaceChildOrigin.deleteMany();
  await db.prisma.workspaceLaunchOrigin.deleteMany();
});
afterAll(async () => destroyIntegrationDatabase(db));
afterEach(() => vi.restoreAllMocks());

async function local() {
  await db.prisma.project.create({ data: project('local') });
  await db.prisma.workspace.create({
    data: {
      id: 'local',
      projectId: 'local',
      name: 'Local',
      creationMetadata: { local: true },
      runScript: { create: { status: 'RUNNING', pid: 789 } },
    },
  });
}
function snapshot() {
  return Promise.all([
    db.prisma.project.findMany({ where: { id: { in: ['local', 'p'] } }, orderBy: { id: 'asc' } }),
    db.prisma.workspace.findMany({
      where: { id: { in: ['local', 'root'] } },
      include: {
        runScript: true,
        prs: { include: { dedicatedSession: true } },
        prMonitoring: true,
        conversationMetadata: true,
      },
      orderBy: { id: 'asc' },
    }),
    db.prisma.agentSession.findMany({ orderBy: { id: 'asc' } }),
    db.prisma.terminalSession.findMany({ orderBy: { id: 'asc' } }),
    db.prisma.workspaceLaunchOrigin.findMany(),
    db.prisma.workspaceChildOrigin.findMany(),
  ]);
}
async function expectGroupSkipped(input: unknown = structuredClone(source)) {
  const before = await snapshot();
  const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [input]);
  expect(result.workspaces).toEqual({ imported: 1, skipped: 2 });
  expect(result.agentSessions).toEqual({ imported: 0, skipped: 1 });
  expect(result.terminalSessions).toEqual({ imported: 0, skipped: 1 });
  expect(result.inertTransforms.agentSessions).toBe(0);
  expect(result.inertTransforms.terminalSessions).toBe(0);
  expect(await db.prisma.workspace.findUnique({ where: { id: 'child' } })).toBeNull();
  expect(await db.prisma.workspace.findUnique({ where: { id: 'healthy' } })).not.toBeNull();
  // Only the compatible pre-existing project can also be in the incoming graph.
  const after = await snapshot();
  expect(after.slice(1)).toEqual(before.slice(1));
  expect(after[0].filter((p) => p.id === 'local')).toEqual(
    before[0].filter((p) => p.id === 'local')
  );
  return result;
}

it('creates reverse-order root/child graphs once and retains authored metadata and child origins', async () => {
  const result = await dataBackupService.importData(source);
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(result.agentSessions).toEqual({ imported: 1, skipped: 0 });
  expect(result.terminalSessions).toEqual({ imported: 1, skipped: 0 });
  expect(await db.prisma.workspace.findUnique({ where: { id: 'root' } })).toMatchObject({
    creationMetadata: { authored: 'root' },
  });
  const origins = await db.prisma.workspaceChildOrigin.findMany();
  expect(origins).toEqual([
    expect.objectContaining({ parentWorkspaceId: 'root', childWorkspaceId: 'child' }),
  ]);
  const repeated = await dataBackupService.importData(source);
  expect(repeated.workspaces).toEqual({ imported: 0, skipped: 3 });
  expect(repeated.agentSessions).toEqual({ imported: 0, skipped: 1 });
  expect(repeated.inertTransforms.agentSessions).toBe(0);
  expect(await db.prisma.workspaceChildOrigin.findMany()).toEqual(origins);
  await workspaceDataService.delete('child');
  expect(await db.prisma.workspace.findUnique({ where: { id: 'child' } })).toBeNull();
  expect(await db.prisma.workspaceChildOrigin.findMany()).toEqual(origins);
});

it('admits an exact compatible project without overwriting local secrets or names', async () => {
  await db.prisma.project.create({
    data: {
      ...project('p'),
      name: 'Local name',
      issueTrackerConfig: { linear: { apiKey: 'local-secret' } },
    },
  });
  const before = await db.prisma.project.findUnique({ where: { id: 'p' } });
  expect((await dataBackupService.importData(source)).workspaces).toEqual({
    imported: 3,
    skipped: 0,
  });
  expect(await db.prisma.project.findUnique({ where: { id: 'p' } })).toEqual(before);
});

it.each(['slug', 'repoPath', 'worktreeBasePath', 'githubOwner', 'githubRepo'] as const)(
  'excludes project identity mismatch in %s and its complete workspace group',
  async (field) => {
    await db.prisma.project.create({ data: { ...project('p'), [field]: 'different' } });
    const before = await db.prisma.project.findUnique({ where: { id: 'p' } });
    await expectGroupSkipped();
    expect(await db.prisma.project.findUnique({ where: { id: 'p' } })).toEqual(before);
  }
);
it('excludes a same-slug different-ID project', async () => {
  await db.prisma.project.create({ data: { ...project('local'), slug: 'p' } });
  await expectGroupSkipped();
  expect(await db.prisma.project.findUnique({ where: { id: 'p' } })).toBeNull();
});

it('retains skipped workspace runtime, metadata and complete local child-history proof', async () => {
  await local();
  await db.prisma.workspace.create({
    data: {
      id: 'root',
      projectId: 'local',
      name: 'Existing root',
      status: 'READY',
      creationMetadata: { local: true },
      runScript: { create: { status: 'RUNNING', pid: 4321 } },
    },
  });
  await db.prisma.agentSession.create({
    data: {
      id: 'local-root-session',
      workspaceId: 'root',
      provider: 'CLAUDE',
      workflow: 'implement',
      status: 'RUNNING',
      providerProcessPid: 5432,
      providerSessionId: 'local-provider',
    },
  });
  await db.prisma.terminalSession.create({
    data: {
      id: 'local-root-terminal',
      workspaceId: 'root',
      name: 'Local terminal',
      status: 'RUNNING',
      pid: 6543,
    },
  });
  await db.prisma.workspacePR.create({
    data: { id: 'local-root-pr', workspaceId: 'root', url: 'https://github.com/local/repo/pull/1' },
  });
  await db.prisma.workspacePRMonitoring.create({
    data: {
      workspaceId: 'root',
      enabled: true,
      recipientSessionId: 'local-root-session',
      bindingRevision: 9,
    },
  });
  await db.prisma.workspaceMetadata.create({
    data: {
      workspaceId: 'root',
      requestId: 'local-metadata',
      title: 'Local title',
      summary: 'Local summary',
    },
  });
  await db.prisma.workspaceChildOrigin.create({
    data: { parentWorkspaceId: 'root', childWorkspaceId: 'retained-deleted-child' },
  });
  await db.prisma.workspaceLaunchOrigin.create({
    data: { runId: 'local-run', workspaceId: 'root', projectId: 'local', childHistoryVersion: 1 },
  });
  await expectGroupSkipped();
});
it('excludes a globally colliding PR and its descendants', async () => {
  await local();
  await db.prisma.workspacePR.create({
    data: { id: 'pr-root', workspaceId: 'local', url: 'https://github.com/o/r/pull/99' },
  });
  await expectGroupSkipped();
});
it.each([
  { version: 5, format: 'compatible v5 union' },
  { version: 6, format: 'current v6' },
  { version: 7, format: 'current v7' },
])(
  'excludes a $format fallback PR collision and descendants while importing a healthy group',
  async ({ version }) => {
    const input = structuredClone(source);
    Reflect.set(input.meta, 'schemaVersion', version);
    const root = input.data.workspaces.find((workspace) => workspace.id === 'root')!;
    root.prs = [];
    expect(root.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(exportDataSchema.safeParse(input).success).toBe(true);
    await local();
    await db.prisma.workspacePR.create({
      data: {
        id: 'legacy-pr-root',
        workspaceId: 'local',
        url: 'https://github.com/local/repo/pull/99',
        title: 'Local fallback owner',
        revision: 7,
      },
    });
    await expectGroupSkipped(input);
    expect(await db.prisma.workspace.findUnique({ where: { id: 'root' } })).toBeNull();
  }
);

it.each([
  { version: 5, format: 'compatible v5 union' },
  { version: 6, format: 'current v6' },
  { version: 7, format: 'current v7' },
])('imports a $format fallback PR with its original identity and fields', async ({ version }) => {
  const input = structuredClone(source);
  Reflect.set(input.meta, 'schemaVersion', version);
  const root = input.data.workspaces.find((workspace) => workspace.id === 'root')!;
  Object.assign(root, {
    prs: [],
    prNumber: 42,
    prState: 'OPEN',
    prReviewState: 'CHANGES_REQUESTED',
    prCiStatus: 'FAILURE',
    ratchetState: 'MERGE_CONFLICT',
    prUpdatedAt: '2026-10-01T01:00:00.000Z',
    prCiFailedAt: '2026-10-01T02:00:00.000Z',
    prCiLastNotifiedAt: '2026-10-01T03:00:00.000Z',
    prReviewLastCheckedAt: '2026-10-01T04:00:00.000Z',
    prReviewLastCommentId: 'original-comment',
  });
  const result = await dataBackupService.importData(input);
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(await db.prisma.workspacePR.findMany({ where: { workspaceId: 'root' } })).toEqual([
    expect.objectContaining({
      id: 'legacy-pr-root',
      workspaceId: 'root',
      url: 'https://github.com/o/r/pull/1',
      number: 42,
      state: 'OPEN',
      reviewState: 'CHANGES_REQUESTED',
      ciStatus: 'FAILURE',
      hasMergeConflict: true,
      syncedAt: new Date('2026-10-01T01:00:00.000Z'),
      ciFailedAt: new Date('2026-10-01T02:00:00.000Z'),
      ciLastNotifiedAt: new Date('2026-10-01T03:00:00.000Z'),
      reviewLastCheckedAt: new Date('2026-10-01T04:00:00.000Z'),
      reviewLastCommentId: 'original-comment',
    }),
  ]);
});

it.each(['implement', 'pr-monitoring'])(
  'excludes a globally colliding %s session without borrowing its runtime',
  async (workflow) => {
    await local();
    await db.prisma.agentSession.create({
      data: {
        id: 'session',
        workspaceId: 'local',
        workflow,
        provider: 'CLAUDE',
        status: 'RUNNING',
        providerProcessPid: 4321,
      },
    });
    await expectGroupSkipped();
  }
);
it.each(['recipient', 'legacy', 'frozen', 'dedicated'] as const)(
  'excludes an existing referenced %s session but permits absent historical references',
  async (reference) => {
    const input = structuredClone(source);
    const root = input.data.workspaces.find((w) => w.id === 'root')!;
    if (reference === 'dedicated') {
      input.data.agentSessions[0] = {
        ...input.data.agentSessions[0]!,
        workflow: 'pr-monitoring',
        workspacePrId: 'pr-root',
      };
      root.prs[0]!.dedicatedSession = { sessionId: 'session' };
    } else {
      root.prMonitoring = {
        enabled: false,
        recipientSessionId: null,
        bindingRevision: 0,
        eventEpoch: 0,
        deliveryPauseReason: null,
        legacySessionIds: [],
        deliveryMode: 'MAIN',
        lastCheckedAt: null,
      };
      if (reference === 'recipient') {
        root.prMonitoring.recipientSessionId = 'historical';
      }
      if (reference === 'legacy') {
        root.prMonitoring.legacySessionIds = ['historical'];
      }
      if (reference === 'frozen') {
        root.prEvents = [
          {
            id: 'historical-event',
            workspaceId: 'root',
            prId: null,
            kind: 'MONITORING_ENABLED',
            deduplicationKey: 'historical',
            payload: {
              kind: 'MONITORING_ENABLED',
              workspaceId: 'root',
              bindingRevision: 0,
              replyToPrComments: false,
            },
            state: 'PENDING',
            attempts: 1,
            deliveryId: 'historical-receipt',
            deliverySessionId: 'historical',
            deliveryProvider: 'CLAUDE',
            deliveryProviderSessionId: 'provider',
            deliveryBindingRevision: 0,
            deliveryText: 'frozen',
            claimedAt: null,
            deliveredAt: null,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ];
      }
      expect(exportDataSchema.safeParse(input).success).toBe(true);
      expect((await dataBackupService.importData(input)).workspaces.imported).toBe(3);
      await clearIntegrationDatabase(db.prisma);
      await db.prisma.workspaceChildOrigin.deleteMany();
    }
    await local();
    await db.prisma.agentSession.create({
      data: {
        id: reference === 'dedicated' ? 'session' : 'historical',
        workspaceId: 'local',
        workflow: reference === 'dedicated' ? 'pr-monitoring' : 'implement',
        provider: 'CLAUDE',
        status: 'RUNNING',
        providerProcessPid: 4321,
      },
    });
    if (reference === 'dedicated') {
      await db.prisma.workspacePR.create({
        data: {
          id: 'foreign-dedicated-pr',
          workspaceId: 'local',
          url: 'https://github.com/local/repo/pull/1',
        },
      });
      await db.prisma.agentSession.update({
        where: { id: 'session' },
        data: { workspacePrId: 'foreign-dedicated-pr' },
      });
      await db.prisma.workspacePRDedicatedSession.create({
        data: { prId: 'foreign-dedicated-pr', sessionId: 'session' },
      });
    }
    await expectGroupSkipped(input);
  }
);
it('skips a terminal-ID collision independently of an otherwise eligible graph', async () => {
  await local();
  await db.prisma.terminalSession.create({
    data: { id: 'terminal', workspaceId: 'local', name: 'Local', status: 'RUNNING', pid: 789 },
  });
  const before = await db.prisma.terminalSession.findUnique({ where: { id: 'terminal' } });
  const result = await dataBackupService.importData(source);
  expect(result.workspaces.imported).toBe(3);
  expect(result.terminalSessions).toEqual({ imported: 0, skipped: 1 });
  expect(result.inertTransforms.terminalSessions).toBe(0);
  expect(await db.prisma.terminalSession.findUnique({ where: { id: 'terminal' } })).toEqual(before);
});

it.each([4, 5, 6, 7] as const)(
  'imports supported v%s root/child graphs in adverse order and skips the complete repeated graph',
  async (version) => {
    const input =
      version === 4
        ? publishedVersion4Backup()
        : version === 5
          ? publishedVersion5Backup()
          : structuredClone(source);
    input.meta.schemaVersion = version;
    input.data.workspaces.sort((a, b) => Number(a.id !== 'child') - Number(b.id !== 'child'));
    expect(exportDataSchema.safeParse(input).success).toBe(true);
    const first = await Reflect.apply(dataBackupService.importData, dataBackupService, [input]);
    expect(first.workspaces).toEqual({ imported: 3, skipped: 0 });
    expect(first.agentSessions).toEqual({ imported: 1, skipped: 0 });
    const repeated = await Reflect.apply(dataBackupService.importData, dataBackupService, [input]);
    expect(repeated.workspaces).toEqual({ imported: 0, skipped: 3 });
    expect(repeated.agentSessions).toEqual({ imported: 0, skipped: 1 });
    expect(repeated.inertTransforms.agentSessions).toBe(0);
  }
);

it('excludes the whole group when an imported session collides in a later chunk of over 1,000 IDs', async () => {
  const input = structuredClone(source);
  input.data.agentSessions = Array.from({ length: 1101 }, (_, index) => ({
    ...source.data.agentSessions[0]!,
    id: `large-session-${index}`,
  }));
  await local();
  await db.prisma.agentSession.create({
    data: {
      id: 'large-session-1100',
      workspaceId: 'local',
      provider: 'CLAUDE',
      workflow: 'implement',
      status: 'RUNNING',
      providerProcessPid: 123,
    },
  });
  const before = await snapshot();
  const result = await dataBackupService.importData(input);
  expect(result.workspaces).toEqual({ imported: 1, skipped: 2 });
  expect(result.agentSessions).toEqual({ imported: 0, skipped: 1101 });
  expect(result.inertTransforms.agentSessions).toBe(0);
  expect((await snapshot()).slice(1)).toEqual(before.slice(1));
});

it('never attaches sessions or terminals whose file workspace is absent to an existing local workspace', async () => {
  await local();
  const input = structuredClone(source);
  input.data.workspaces = input.data.workspaces.filter((w) => w.id === 'healthy');
  input.data.agentSessions[0]!.workspaceId = 'local';
  input.data.terminalSessions[0]!.workspaceId = 'local';
  const before = await snapshot();
  const result = await dataBackupService.importData(input);
  expect(result.workspaces).toEqual({ imported: 1, skipped: 0 });
  expect(result.agentSessions).toEqual({ imported: 0, skipped: 1 });
  expect(result.terminalSessions).toEqual({ imported: 0, skipped: 1 });
  expect(result.inertTransforms.agentSessions).toBe(0);
  expect(result.inertTransforms.terminalSessions).toBe(0);
  expect((await snapshot()).slice(1)).toEqual(before.slice(1));
});

async function expectPublishedV5Baseline() {
  const input = publishedVersion5Backup();
  const root = input.data.workspaces.find((w) => w.id === 'root')!;
  expect(root).not.toHaveProperty('prUrl');
  expect(root.ratchetActivePrId).toBe('pr-root');
  expect(root.prs[0]!.ratchet.dispatchSnapshotKey).toBe('historical-dispatch');
  expect(input.data.agentSessions[0]!.workspacePrId).toBe('pr-root');
  const parsed = exportDataSchema.parse(input);
  const normalized = parsed.data.workspaces.find((w) => w.id === 'root')!;
  expect(parsed.meta.schemaVersion).toBe(6);
  expect(normalized.prUrl).toBeNull();
  expect(normalized.prs[0]).not.toHaveProperty('ratchet');
  expect(normalized.prMonitoring).toMatchObject({
    legacySessionIds: ['session'],
    deliveryPauseReason: 'LEGACY_FIXER',
  });
  const result = await Reflect.apply(dataBackupService.importData, dataBackupService, [input]);
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(result.agentSessions).toEqual({ imported: 1, skipped: 0 });
  expect(result.terminalSessions).toEqual({ imported: 1, skipped: 0 });
  expect(await db.prisma.workspacePR.findUnique({ where: { id: 'pr-root' } })).toMatchObject({
    workspaceId: 'root',
    number: 1,
  });
  expect(await db.prisma.workspacePR.findUnique({ where: { id: 'legacy-pr-root' } })).toBeNull();
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'session' } })).toMatchObject({
    workspacePrId: 'pr-root',
  });
  expect(
    await db.prisma.workspacePRDiscovery.findUnique({ where: { workspaceId: 'root' } })
  ).toMatchObject({ retryCount: 2 });
  expect(
    await db.prisma.workspacePRMonitoring.findUnique({ where: { workspaceId: 'root' } })
  ).toMatchObject({
    enabled: false,
    legacySessionIds: ['session'],
    deliveryPauseReason: 'LEGACY_FIXER',
  });
  expect(await db.prisma.workspacePRDedicatedSession.count()).toBe(0);
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.workspaceChildOrigin.deleteMany();
  await db.prisma.workspaceLaunchOrigin.deleteMany();
}

it('excludes published v5 explicit PR collisions after proving raw migration', async () => {
  await expectPublishedV5Baseline();
  await local();
  await db.prisma.workspacePR.create({
    data: { id: 'pr-root', workspaceId: 'local', url: 'https://github.com/local/repo/pull/99' },
  });
  await expectGroupSkipped(publishedVersion5Backup());
});

it('preserves published v5 nested PR identity and fields after proving raw migration', async () => {
  await expectPublishedV5Baseline();
  const input = publishedVersion5Backup();
  const pr = input.data.workspaces.find((w) => w.id === 'root')!.prs[0]!;
  Object.assign(pr, {
    number: 42,
    reviewState: 'CHANGES_REQUESTED',
    ciStatus: 'FAILURE',
    hasMergeConflict: true,
    syncedAt: '2026-10-01T01:00:00.000Z',
    ciFailedAt: '2026-10-01T02:00:00.000Z',
    ciLastNotifiedAt: '2026-10-01T03:00:00.000Z',
    reviewLastCheckedAt: '2026-10-01T04:00:00.000Z',
    reviewLastCommentId: 'original-comment',
  });
  expect(
    (await Reflect.apply(dataBackupService.importData, dataBackupService, [input])).workspaces
      .imported
  ).toBe(3);
  expect(await db.prisma.workspacePR.findUnique({ where: { id: 'pr-root' } })).toMatchObject({
    id: 'pr-root',
    workspaceId: 'root',
    url: 'https://github.com/o/r/pull/1',
    number: 42,
    state: 'OPEN',
    reviewState: 'CHANGES_REQUESTED',
    ciStatus: 'FAILURE',
    hasMergeConflict: true,
    syncedAt: new Date('2026-10-01T01:00:00.000Z'),
    ciFailedAt: new Date('2026-10-01T02:00:00.000Z'),
    ciLastNotifiedAt: new Date('2026-10-01T03:00:00.000Z'),
    reviewLastCheckedAt: new Date('2026-10-01T04:00:00.000Z'),
    reviewLastCommentId: 'original-comment',
  });
  expect(await db.prisma.workspacePRDedicatedSession.count()).toBe(0);
});

it('emits only explicit PR identities when a flat URL and foreign fallback ID also exist', async () => {
  await local();
  await db.prisma.workspacePR.create({
    data: {
      id: 'legacy-pr-root',
      workspaceId: 'local',
      url: 'https://github.com/local/repo/pull/99',
    },
  });
  const before = await snapshot();
  expect((await dataBackupService.importData(source)).workspaces.imported).toBe(3);
  expect(await db.prisma.workspacePR.findMany({ where: { workspaceId: 'root' } })).toEqual([
    expect.objectContaining({ id: 'pr-root' }),
  ]);
  const after = await snapshot();
  expect(after[1].find((w) => w.id === 'local')).toEqual(before[1].find((w) => w.id === 'local'));
});

function expectSkipDiagnostics(output: string[], id: string, reason: string) {
  expect(
    output.some((line) => line.includes(`"${id}"`) && line.includes(`"reason":"${reason}"`))
  ).toBe(true);
}
function captureWarnings() {
  const output: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    output.push(String(message));
  });
  return output;
}
it('explains PR group and child/session/terminal skips without disclosing authored content', async () => {
  await local();
  await db.prisma.workspacePR.create({
    data: {
      id: 'pr-root',
      workspaceId: 'local',
      url: 'https://github.com/private-secret/repo/pull/99',
    },
  });
  const input = structuredClone(source);
  input.data.workspaces.find((w) => w.id === 'root')!.creationMetadata = {
    secret: 'authored-secret-sentinel',
  };
  const output = captureWarnings();
  await expectGroupSkipped(input);
  expectSkipDiagnostics(output, 'root', 'pr-id-collision');
  expectSkipDiagnostics(output, 'child', 'parent-not-admitted');
  expectSkipDiagnostics(output, 'session', 'workspace-not-imported');
  expectSkipDiagnostics(output, 'terminal', 'workspace-not-imported');
  expect(output.join('\n')).not.toMatch(/private-secret|authored-secret-sentinel|https:\/\//);
});

it.each(['missing', 'incompatible', 'slug'] as const)(
  'explains %s project exclusions and orphan session/terminal skips',
  async (kind) => {
    const input = structuredClone(source);
    if (kind === 'missing') {
      input.data.projects = input.data.projects.filter((p) => p.id !== 'p');
      input.data.agentSessions[0]!.workspaceId = 'absent-workspace';
      input.data.terminalSessions[0]!.workspaceId = 'absent-workspace';
    } else {
      await db.prisma.project.create({
        data:
          kind === 'slug'
            ? { ...project('local'), slug: 'p' }
            : { ...project('p'), repoPath: '/private-secret-path' },
      });
    }
    const before = await db.prisma.project.findMany();
    const output = captureWarnings();
    const result = await dataBackupService.importData(input);
    expect(result.workspaces).toEqual({ imported: 1, skipped: 2 });
    expect(result.agentSessions).toEqual({ imported: 0, skipped: 1 });
    expect(result.terminalSessions).toEqual({ imported: 0, skipped: 1 });
    expect(await db.prisma.workspace.findUnique({ where: { id: 'healthy' } })).not.toBeNull();
    for (const p of before) {
      expect(await db.prisma.project.findUnique({ where: { id: p.id } })).toEqual(p);
    }
    expectSkipDiagnostics(output, 'root', 'project-unavailable');
    expectSkipDiagnostics(output, 'session', 'workspace-not-imported');
    expectSkipDiagnostics(output, 'terminal', 'workspace-not-imported');
    if (kind !== 'missing') {
      expectSkipDiagnostics(
        output,
        'p',
        kind === 'slug' ? 'project-slug-collision' : 'incompatible-project-identity'
      );
    }
    expect(output.join('\n')).not.toContain('/private-secret-path');
  }
);

it('explains an independent terminal collision while preserving its local owner', async () => {
  await local();
  await db.prisma.terminalSession.create({
    data: { id: 'terminal', workspaceId: 'local', name: 'Local', status: 'RUNNING', pid: 789 },
  });
  const before = await db.prisma.terminalSession.findUnique({ where: { id: 'terminal' } });
  const output = captureWarnings();
  const result = await dataBackupService.importData(source);
  expect(result.workspaces.imported).toBe(3);
  expect(result.terminalSessions).toEqual({ imported: 0, skipped: 1 });
  expect(await db.prisma.terminalSession.findUnique({ where: { id: 'terminal' } })).toEqual(before);
  expectSkipDiagnostics(output, 'terminal', 'terminal-id-collision');
});
