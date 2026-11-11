import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { dataBackupService } from '@/backend/orchestration/data-backup/data-backup.service';
import { redObservation } from '@/shared/pr-monitoring.test-helpers';
import { exportDataSchema, type ExportData } from '@/shared/schemas/export-data.schema';
import type { PrismaClient } from '@prisma-gen/client';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from './integration-db';
import { publishedVersion4Backup, publishedVersion5Backup } from './legacy-backup.fixture';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined, reads: 0 }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    state.reads++;
    if (!state.prisma) {
      throw new Error('Missing database');
    }
    return state.prisma;
  },
}));
let db: IntegrationDatabase;
let source: ExportData;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.create({
    data: { id: 'p', slug: 'p', name: 'P', repoPath: '/p', worktreeBasePath: '/w' },
  });
  for (const id of ['root', 'child', 'healthy']) {
    await db.prisma.workspace.create({
      data: {
        id,
        projectId: 'p',
        name: id,
        status: 'READY',
        parentWorkspaceId: id === 'child' ? 'root' : null,
        prs: {
          create: { id: `pr-${id}`, url: `https://github.com/o/r/pull/${id === 'root' ? 1 : 2}` },
        },
      },
    });
  }
  await db.prisma.agentSession.create({
    data: { id: 'session', workspaceId: 'root', workflow: 'implement', provider: 'CLAUDE' },
  });
  await db.prisma.terminalSession.create({
    data: { id: 'terminal', workspaceId: 'root', name: 'Terminal' },
  });
  await db.prisma.workspacePREvent.create({
    data: {
      id: 'event',
      workspaceId: 'root',
      prId: 'pr-root',
      kind: 'CI_FAILED',
      deduplicationKey: 'dedup',
      payload: {
        kind: 'CI_FAILED',
        target: { workspaceId: 'root', prId: 'pr-root' },
        observation: redObservation,
      },
    },
  });
  source = await dataBackupService.exportData('source-graph');
  source.data.workspaces = ['root', 'child', 'healthy'].map((id) =>
    source.data.workspaces.find((workspace) => workspace.id === id)!
  );
  await clearIntegrationDatabase(db.prisma);
}, 30_000);
afterAll(async () => destroyIntegrationDatabase(db));
function backup() {
  return structuredClone(source);
}
function root<T extends { id: string }>(data: { data: { workspaces: T[] } }) {
  return data.data.workspaces.find((w) => w.id === 'root')!;
}
function child<T extends { id: string }>(data: { data: { workspaces: T[] } }) {
  return data.data.workspaces.find((w) => w.id === 'child')!;
}
type Mutation = (data: ExportData) => void;
const duplicateIdentity = 'Duplicate source identity';
const invalidParent = 'Parent must be a different file-owned root in the same project';
const foreignSession = 'Declared session must belong to its file workspace';
const foreignEvent = 'Event and payload must belong to their declared workspace and PR';
const expectedIssues: Record<string, { path: (string | number)[]; message: string }> = {
  'project ID': { path: ['data', 'projects'], message: duplicateIdentity },
  'project slug': { path: ['data', 'projects'], message: duplicateIdentity },
  'workspace ID': { path: ['data', 'workspaces'], message: duplicateIdentity },
  'agent ID': { path: ['data', 'agentSessions'], message: duplicateIdentity },
  'terminal ID': { path: ['data', 'terminalSessions'], message: duplicateIdentity },
  'missing parent': {
    path: ['data', 'workspaces', 1, 'parentWorkspaceId'],
    message: invalidParent,
  },
  'self parent': { path: ['data', 'workspaces', 0, 'parentWorkspaceId'], message: invalidParent },
  cycle: { path: ['data', 'workspaces', 0, 'parentWorkspaceId'], message: invalidParent },
  grandchild: { path: ['data', 'workspaces', 2, 'parentWorkspaceId'], message: invalidParent },
  'cross-project parent': {
    path: ['data', 'workspaces', 1, 'parentWorkspaceId'],
    message: invalidParent,
  },
  'foreign frozen session': { path: ['data', 'workspaces', 0], message: foreignSession },
  'foreign monitor recipient': { path: ['data', 'workspaces', 0], message: foreignSession },
  'foreign legacy session': { path: ['data', 'workspaces', 0], message: foreignSession },
  'global PR ID': { path: ['data', 'workspaces'], message: duplicateIdentity },
  'global event ID': { path: ['data', 'workspaces'], message: duplicateIdentity },
  'workspace dedup across PRs': {
    path: ['data', 'workspaces', 0, 'prEvents'],
    message: 'Duplicate event deduplication key',
  },
  'container workspace': { path: ['data', 'workspaces', 0, 'prEvents'], message: foreignEvent },
  'foreign event PR': { path: ['data', 'workspaces', 0, 'prEvents'], message: foreignEvent },
  'missing event PR': { path: ['data', 'workspaces', 0, 'prEvents'], message: foreignEvent },
  'payload workspace': { path: ['data', 'workspaces', 0, 'prEvents'], message: foreignEvent },
  'payload PR': { path: ['data', 'workspaces', 0, 'prEvents'], message: foreignEvent },
  'payload target with null event PR': {
    path: ['data', 'workspaces', 0, 'prEvents'],
    message: foreignEvent,
  },
  'control workspace': { path: ['data', 'workspaces', 0, 'prEvents'], message: foreignEvent },
  'cross-workspace receipt': {
    path: ['data', 'workspaces', 1, 'prEvents'],
    message: 'Receipt members must belong to one workspace',
  },
};
function expectStructuralIssue(data: unknown, name: string) {
  expect(expectedIssues[name]).toBeDefined();
  const result = exportDataSchema.safeParse(data);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toContainEqual({ code: 'custom', ...expectedIssues[name] });
  }
}
interface IdentityGraph {
  data: {
    projects: { id: string; slug: string }[];
    workspaces: {
      id: string;
      projectId: string;
      parentWorkspaceId: string | null;
      prs?: unknown[];
      prEvents?: unknown[];
      prUrl?: string | null;
    }[];
    agentSessions: { id: string; workspaceId: string }[];
    terminalSessions: { id: string; workspaceId: string }[];
  };
}
function versionedBackup(version: number) {
  if (version === 4) {
    return publishedVersion4Backup();
  }
  if (version === 5) {
    return publishedVersion5Backup();
  }
  // v6/v7 cases use the current normalized-compatible export shape, including
  // optional account fields. Only v4/v5 builders model published historical wire.
  const b = backup();
  Reflect.set(b.meta, 'schemaVersion', version);
  return b;
}
const malformed: [string, (data: IdentityGraph) => void][] = [
  [
    'project ID',
    (b) => {
      b.data.projects.push({ ...b.data.projects[0]!, slug: 'other' });
    },
  ],
  [
    'project slug',
    (b) => {
      b.data.projects.push({ ...b.data.projects[0]!, id: 'other' });
    },
  ],
  [
    'workspace ID',
    (b) => {
      b.data.workspaces.push({ ...child(b), prs: [], prEvents: [], prUrl: null });
    },
  ],
  [
    'agent ID',
    (b) => {
      b.data.agentSessions.push({ ...b.data.agentSessions[0]!, workspaceId: 'healthy' });
    },
  ],
  [
    'terminal ID',
    (b) => {
      b.data.terminalSessions.push({ ...b.data.terminalSessions[0]!, workspaceId: 'healthy' });
    },
  ],
  [
    'missing parent',
    (b) => {
      child(b).parentWorkspaceId = 'missing';
    },
  ],
  [
    'self parent',
    (b) => {
      root(b).parentWorkspaceId = 'root';
    },
  ],
  [
    'cycle',
    (b) => {
      root(b).parentWorkspaceId = 'child';
    },
  ],
  [
    'grandchild',
    (b) => {
      b.data.workspaces.find((w) => w.id === 'healthy')!.parentWorkspaceId = 'child';
    },
  ],
  [
    'cross-project parent',
    (b) => {
      child(b).projectId = 'other-project';
    },
  ],
];
it.each(
  [4, 5, 6, 7].flatMap((version) => malformed.map(([name, mutate]) => ({ version, name, mutate })))
)(
  'rejects $name after version $version normalization before discovery',
  async ({ version, name, mutate }) => {
    const invalid = versionedBackup(version);
    expect(exportDataSchema.safeParse(invalid).success).toBe(true);
    mutate(invalid);
    expectStructuralIssue(invalid, name);
    state.reads = 0;
    // Exercise the runtime boundary with the unnormalized published wire input.
    await expect(
      Reflect.apply(dataBackupService.importData, dataBackupService, [invalid])
    ).rejects.toBeInstanceOf(ZodError);
    expect(state.reads).toBe(0);
    expect(await db.prisma.project.count()).toBe(0);
    expect(await db.prisma.workspace.count()).toBe(0);
  }
);
const badEvents: [string, Mutation][] = [
  [
    'foreign frozen session',
    (b) => {
      b.data.agentSessions[0]!.workspaceId = 'healthy';
      root(b).prEvents[0]!.deliverySessionId = 'session';
    },
  ],
  [
    'foreign monitor recipient',
    (b) => {
      b.data.agentSessions[0]!.workspaceId = 'healthy';
      root(b).prMonitoring = {
        enabled: false,
        deliveryMode: 'MAIN',
        recipientSessionId: 'session',
        legacySessionIds: [],
        bindingRevision: 0,
        eventEpoch: 0,
        deliveryPauseReason: null,
        lastCheckedAt: null,
      };
    },
  ],
  [
    'foreign legacy session',
    (b) => {
      b.data.agentSessions[0]!.workspaceId = 'healthy';
      root(b).prMonitoring = {
        enabled: false,
        deliveryMode: 'MAIN',
        recipientSessionId: null,
        legacySessionIds: ['session'],
        bindingRevision: 0,
        eventEpoch: 0,
        deliveryPauseReason: null,
        lastCheckedAt: null,
      };
    },
  ],
  [
    'global PR ID',
    (b) => {
      child(b).prs[0]!.id = 'pr-root';
    },
  ],
  [
    'global event ID',
    (b) => {
      child(b).prEvents.push({
        ...root(b).prEvents[0]!,
        workspaceId: 'child',
        prId: 'pr-child',
        deduplicationKey: 'different',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'child', prId: 'pr-child' },
          observation: redObservation,
        },
      });
    },
  ],
  [
    'workspace dedup across PRs',
    (b) => {
      root(b).prs.push({ ...child(b).prs[0]!, id: 'second' });
      root(b).prEvents.push({
        ...root(b).prEvents[0]!,
        id: 'second',
        prId: 'second',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'root', prId: 'second' },
          observation: redObservation,
        },
      });
    },
  ],
  [
    'container workspace',
    (b) => {
      root(b).prEvents[0]!.workspaceId = 'child';
    },
  ],
  [
    'foreign event PR',
    (b) => {
      root(b).prEvents[0]!.prId = 'pr-child';
    },
  ],
  [
    'missing event PR',
    (b) => {
      root(b).prEvents[0]!.prId = 'absent';
    },
  ],
  [
    'payload workspace',
    (b) => {
      root(b).prEvents[0]!.payload = {
        kind: 'CI_FAILED',
        target: { workspaceId: 'child', prId: 'pr-root' },
        observation: redObservation,
      };
    },
  ],
  [
    'payload PR',
    (b) => {
      root(b).prEvents[0]!.payload = {
        kind: 'CI_FAILED',
        target: { workspaceId: 'root', prId: 'pr-child' },
        observation: redObservation,
      };
    },
  ],
  [
    'payload target with null event PR',
    (b) => {
      root(b).prEvents[0]!.prId = null;
    },
  ],
  [
    'control workspace',
    (b) => {
      root(b).prEvents[0]!.kind = 'MONITORING_ENABLED';
      root(b).prEvents[0]!.payload = {
        kind: 'MONITORING_ENABLED',
        workspaceId: 'child',
        bindingRevision: 0,
        replyToPrComments: false,
      };
    },
  ],
  [
    'cross-workspace receipt',
    (b) => {
      const event = root(b).prEvents[0]!;
      event.deliveryId = 'shared-receipt';
      child(b).prEvents.push({
        ...event,
        id: 'other-event',
        workspaceId: 'child',
        prId: 'pr-child',
        payload: {
          kind: 'CI_FAILED',
          target: { workspaceId: 'child', prId: 'pr-child' },
          observation: redObservation,
        },
      });
    },
  ],
];
it.each(badEvents)(
  'rejects %s before database discovery even with a healthy workspace',
  async (name, mutate) => {
    const invalid = backup();
    expect(exportDataSchema.safeParse(invalid).success).toBe(true);
    mutate(invalid);
    expectStructuralIssue(invalid, name);
    state.reads = 0;
    await expect(dataBackupService.importData(invalid)).rejects.toBeInstanceOf(ZodError);
    expect(state.reads).toBe(0);
    expect(await db.prisma.project.count()).toBe(0);
    expect(await db.prisma.workspacePREvent.count()).toBe(0);
  }
);
it('rejects ambiguous dedicated-session duplicates before lookup can certify one matching row', () => {
  const b = backup();
  const session = b.data.agentSessions[0]!;
  session.workflow = 'pr-monitoring';
  session.workspacePrId = 'pr-root';
  root(b).prs[0]!.dedicatedSession = { sessionId: session.id };
  b.data.agentSessions.push({ ...session, workspaceId: 'healthy', workspacePrId: 'pr-healthy' });
  expect(exportDataSchema.safeParse(b).success).toBe(false);
});
it('accepts reverse-order roots and children, null-PR dedup in separate workspaces and absent historical references', async () => {
  const b = backup();
  b.data.workspaces = [child(b), b.data.workspaces.find((w) => w.id === 'healthy')!, root(b)];
  root(b).prMonitoring = {
    enabled: false,
    deliveryMode: 'MAIN',
    recipientSessionId: 'historical',
    legacySessionIds: ['historical'],
    bindingRevision: 0,
    eventEpoch: 0,
    deliveryPauseReason: null,
    lastCheckedAt: null,
  };
  const control = {
    ...root(b).prEvents[0]!,
    kind: 'MONITORING_ENABLED',
    prId: null,
    deliverySessionId: 'historical',
    deliveryText: 'unbound historical evidence',
    payload: {
      kind: 'MONITORING_ENABLED' as const,
      workspaceId: 'root',
      bindingRevision: 0,
      replyToPrComments: false,
    },
  };
  root(b).prEvents = [control];
  child(b).prEvents = [
    {
      ...control,
      id: 'child-event',
      workspaceId: 'child',
      payload: { ...control.payload, workspaceId: 'child' },
    },
  ];
  expect(exportDataSchema.safeParse(b).success).toBe(true);
  const result = await dataBackupService.importData(b);
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(await db.prisma.workspace.findUnique({ where: { id: 'child' } })).toMatchObject({
    parentWorkspaceId: 'root',
  });
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'historical' } })).toBeNull();
  await clearIntegrationDatabase(db.prisma);
});

it('keeps missing source projects and absent session/terminal workspaces as scoped skips', async () => {
  const b = backup();
  child(b).projectId = 'missing-project';
  // Parent ownership remains valid; this unrelated root has an unavailable project.
  child(b).parentWorkspaceId = null;
  b.data.agentSessions.push({
    ...b.data.agentSessions[0]!,
    id: 'orphan-session',
    workspaceId: 'absent-workspace',
  });
  b.data.terminalSessions.push({
    ...b.data.terminalSessions[0]!,
    id: 'orphan-terminal',
    workspaceId: 'absent-workspace',
  });
  expect(exportDataSchema.safeParse(b).success).toBe(true);
  const result = await dataBackupService.importData(b);
  expect(result.workspaces).toEqual({ imported: 2, skipped: 1 });
  expect(result.agentSessions).toEqual({ imported: 1, skipped: 1 });
  expect(result.terminalSessions).toEqual({ imported: 1, skipped: 1 });
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'orphan-session' } })).toBeNull();
  expect(
    await db.prisma.terminalSession.findUnique({ where: { id: 'orphan-terminal' } })
  ).toBeNull();
  await clearIntegrationDatabase(db.prisma);
});

it.each([4, 5, 6, 7])(
  'imports normalized version %s with a child preceding its root',
  async (version) => {
    const b = versionedBackup(version);
    b.data.workspaces.reverse();
    const normalized = exportDataSchema.parse(b);
    if (version <= 5) {
      expect(b.data).not.toHaveProperty('codexAccounts');
      expect(b.data.agentSessions[0]).not.toHaveProperty('codexAccountId');
      const rawRoot = b.data.workspaces.find((workspace) => workspace.id === 'root')!;
      expect(rawRoot).not.toHaveProperty('prMonitoring');
      expect(rawRoot).not.toHaveProperty('prEvents');
      expect(rawRoot).not.toHaveProperty('conversationMetadata');
      expect(normalized.meta.schemaVersion).toBe(6);
      expect(normalized.data.codexAccounts).toEqual([]);
      expect(root(normalized).prs.map((pr) => pr.id)).toEqual([
        version === 4 ? 'legacy-pr-root' : 'pr-root',
      ]);
      expect(normalized.data.agentSessions[0]).toMatchObject({
        workspacePrId: version === 4 ? 'legacy-pr-root' : 'pr-root',
        codexAccountId: null,
      });
      expect(root(normalized).prMonitoring).toMatchObject({
        legacySessionIds: ['session'],
        deliveryPauseReason: 'LEGACY_FIXER',
      });
      expect(root(normalized)).not.toHaveProperty('mode');
      if (version === 4) {
        expect(rawRoot).not.toHaveProperty('prs');
        expect(rawRoot).not.toHaveProperty('prDiscovery');
        expect(b.data.agentSessions[0]).not.toHaveProperty('workspacePrId');
      } else {
        expect(rawRoot).not.toHaveProperty('prUrl');
        expect(rawRoot).toHaveProperty('prs.0.ratchet.dispatchSnapshotKey', 'historical-dispatch');
        expect(root(normalized).prs[0]).not.toHaveProperty('ratchet');
      }
    }
    const imported = await dataBackupService.importData(normalized);
    expect(imported.workspaces).toEqual({ imported: 3, skipped: 0 });
    expect(await db.prisma.workspace.findUnique({ where: { id: 'child' } })).toMatchObject({
      parentWorkspaceId: 'root',
    });
    await clearIntegrationDatabase(db.prisma);
  }
);

it.each([6, 7])(
  'rejects a version %s control with a non-null PR before discovery',
  async (version) => {
    const b = backup();
    Reflect.set(b.meta, 'schemaVersion', version);
    const event = root(b).prEvents[0]!;
    event.kind = 'MONITORING_ENABLED';
    event.prId = null;
    event.payload = {
      kind: 'MONITORING_ENABLED',
      workspaceId: 'root',
      bindingRevision: 0,
      replyToPrComments: false,
    };
    expect(exportDataSchema.safeParse(b).success).toBe(true);
    event.prId = 'pr-root';
    const result = exportDataSchema.safeParse(b);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual({
        code: 'custom',
        path: ['data', 'workspaces', 0, 'prEvents'],
        message: foreignEvent,
      });
    }
    state.reads = 0;
    await expect(dataBackupService.importData(b)).rejects.toBeInstanceOf(ZodError);
    expect(state.reads).toBe(0);
    expect(await db.prisma.project.count()).toBe(0);
    expect(await db.prisma.workspace.count()).toBe(0);
    expect(await db.prisma.workspacePREvent.count()).toBe(0);
  }
);

it.each([6, 7])('imports a version %s null-PR control as an inert fact', async (version) => {
  const b = backup();
  Reflect.set(b.meta, 'schemaVersion', version);
  const event = root(b).prEvents[0]!;
  event.kind = 'MONITORING_ENABLED';
  event.prId = null;
  event.payload = {
    kind: 'MONITORING_ENABLED',
    workspaceId: 'root',
    bindingRevision: 0,
    replyToPrComments: false,
  };
  expect(exportDataSchema.safeParse(b).success).toBe(true);
  const result = await dataBackupService.importData(b);
  expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
  expect(result.inertTransforms.cancelledFacts).toBe(1);
  expect(await db.prisma.workspacePREvent.findUnique({ where: { id: event.id } })).toMatchObject({
    prId: null,
    state: 'CANCELLED',
    deliveredAt: null,
  });
  await clearIntegrationDatabase(db.prisma);
});

it.each([
  { version: 5, format: 'compatible v5 union' },
  { version: 6, format: 'current v6' },
  { version: 7, format: 'current v7' },
])(
  'rejects a $format fallback-versus-explicit PR identity before discovery',
  async ({ version }) => {
    const b = backup();
    Reflect.set(b.meta, 'schemaVersion', version);
    root(b).prs = [];
    root(b).prEvents = [];
    expect(root(b).prUrl).toBe('https://github.com/o/r/pull/1');
    expect(exportDataSchema.safeParse(b).success).toBe(true);
    child(b).prs[0]!.id = 'legacy-pr-root';
    state.reads = 0;
    await expect(dataBackupService.importData(b)).rejects.toBeInstanceOf(ZodError);
    expect(state.reads).toBe(0);
    expect(await db.prisma.project.count()).toBe(0);
    expect(await db.prisma.workspace.count()).toBe(0);
    expect(await db.prisma.workspacePR.count()).toBe(0);
    const parsed = exportDataSchema.safeParse(b);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual({
        code: 'custom',
        path: ['data', 'workspaces'],
        message: duplicateIdentity,
      });
    }
  }
);

function fallbackBackup(version: number) {
  const b = backup();
  Reflect.set(b.meta, 'schemaVersion', version);
  root(b).prs = [];
  const event = root(b).prEvents[0]!;
  event.prId = 'legacy-pr-root';
  event.payload = {
    kind: 'CI_FAILED',
    target: { workspaceId: 'root', prId: 'legacy-pr-root' },
    observation: redObservation,
  };
  b.data.agentSessions[0]!.workspacePrId = 'legacy-pr-root';
  return b;
}

it.each([6, 7])(
  'imports a v%s fallback-owned event without a referring session',
  async (version) => {
    const b = fallbackBackup(version);
    b.data.agentSessions[0]!.workspacePrId = null;
    expect(exportDataSchema.safeParse(b).success).toBe(true);
    const result = await dataBackupService.importData(b);
    expect(result.workspaces).toEqual({ imported: 3, skipped: 0 });
    expect(result.inertTransforms.cancelledFacts).toBe(1);
    expect(await db.prisma.workspacePREvent.findUnique({ where: { id: 'event' } })).toMatchObject({
      workspaceId: 'root',
      prId: 'legacy-pr-root',
      state: 'CANCELLED',
      deliveredAt: null,
      payload: { target: { workspaceId: 'root', prId: 'legacy-pr-root' } },
    });
    expect(
      await db.prisma.workspacePR.findUnique({ where: { id: 'legacy-pr-root' } })
    ).toMatchObject({ workspaceId: 'root' });
    await clearIntegrationDatabase(db.prisma);
  }
);

it.each([6, 7])(
  'imports a v%s fallback-owned dedicated-workflow session without inventing a binding',
  async (version) => {
    const b = fallbackBackup(version);
    root(b).prEvents = [];
    b.data.agentSessions[0]!.workflow = 'pr-monitoring';
    expect(exportDataSchema.safeParse(b).success).toBe(true);
    const result = await dataBackupService.importData(b);
    expect(result.agentSessions).toEqual({ imported: 1, skipped: 0 });
    expect(await db.prisma.agentSession.findUnique({ where: { id: 'session' } })).toMatchObject({
      workspaceId: 'root',
      workspacePrId: 'legacy-pr-root',
      workflow: 'pr-monitoring',
    });
    expect(await db.prisma.workspacePRDedicatedSession.count()).toBe(0);
    expect(await db.prisma.workspace.findUnique({ where: { id: 'healthy' } })).not.toBeNull();
    await clearIntegrationDatabase(db.prisma);
  }
);

const invalidFallbackReferences: [string, Mutation, (string | number)[], string][] = [
  [
    'unknown event PR',
    (b) => {
      root(b).prEvents[0]!.prId = 'absent';
    },
    ['data', 'workspaces', 0, 'prEvents'],
    foreignEvent,
  ],
  [
    'payload PR',
    (b) => {
      root(b).prEvents[0]!.payload = {
        kind: 'CI_FAILED',
        target: { workspaceId: 'root', prId: 'pr-child' },
        observation: redObservation,
      };
    },
    ['data', 'workspaces', 0, 'prEvents'],
    foreignEvent,
  ],
  [
    'outer workspace',
    (b) => {
      root(b).prEvents[0]!.workspaceId = 'child';
    },
    ['data', 'workspaces', 0, 'prEvents'],
    foreignEvent,
  ],
  [
    'payload workspace',
    (b) => {
      root(b).prEvents[0]!.payload = {
        kind: 'CI_FAILED',
        target: { workspaceId: 'child', prId: 'legacy-pr-root' },
        observation: redObservation,
      };
    },
    ['data', 'workspaces', 0, 'prEvents'],
    foreignEvent,
  ],
  [
    'control PR',
    (b) => {
      root(b).prEvents[0]!.kind = 'MONITORING_ENABLED';
      root(b).prEvents[0]!.payload = {
        kind: 'MONITORING_ENABLED',
        workspaceId: 'root',
        bindingRevision: 0,
        replyToPrComments: false,
      };
    },
    ['data', 'workspaces', 0, 'prEvents'],
    foreignEvent,
  ],
  [
    'foreign session PR',
    (b) => {
      b.data.agentSessions[0]!.workspacePrId = 'pr-child';
    },
    ['data', 'agentSessions', 0, 'workspacePrId'],
    'Session PR must belong to its workspace',
  ],
  [
    'unknown session PR',
    (b) => {
      b.data.agentSessions[0]!.workspacePrId = 'absent';
    },
    ['data', 'agentSessions', 0, 'workspacePrId'],
    'Session PR must belong to its workspace',
  ],
];
it.each(invalidFallbackReferences)(
  'rejects a fallback %s before discovery after a valid public import',
  async (_name, mutate, path, message) => {
    const b = fallbackBackup(7);
    expect(exportDataSchema.safeParse(b).success).toBe(true);
    expect((await dataBackupService.importData(b)).workspaces).toEqual({ imported: 3, skipped: 0 });
    expect(await db.prisma.agentSession.findUnique({ where: { id: 'session' } })).toMatchObject({
      workspacePrId: 'legacy-pr-root',
    });
    await clearIntegrationDatabase(db.prisma);
    mutate(b);
    const parsed = exportDataSchema.safeParse(b);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual({ code: 'custom', path, message });
    }
    state.reads = 0;
    await expect(dataBackupService.importData(b)).rejects.toBeInstanceOf(ZodError);
    expect(state.reads).toBe(0);
    expect(await db.prisma.workspace.count()).toBe(0);
  }
);

it.each([null, ''])(
  'emits no fallback for flat URL %s and rejects invented PR references',
  async (url) => {
    const b = fallbackBackup(7);
    root(b).prUrl = url;
    root(b).prEvents = [];
    b.data.agentSessions[0]!.workspacePrId = null;
    expect((await dataBackupService.importData(b)).workspaces.imported).toBe(3);
    expect(await db.prisma.workspacePR.count({ where: { workspaceId: 'root' } })).toBe(0);
    await clearIntegrationDatabase(db.prisma);
    b.data.agentSessions[0]!.workspacePrId = 'legacy-pr-root';
    state.reads = 0;
    await expect(dataBackupService.importData(b)).rejects.toBeInstanceOf(ZodError);
    expect(state.reads).toBe(0);
    expect(await db.prisma.workspace.count()).toBe(0);
  }
);

it('rejects published v5 explicit PR duplicates after proving raw parser and service migration', async () => {
  const baseline = publishedVersion5Backup();
  expect(root(baseline)).not.toHaveProperty('prUrl');
  expect(root(baseline)).toHaveProperty('ratchetActivePrId', 'pr-root');
  expect(root(baseline)).toHaveProperty('prs.0.ratchet.dispatchSnapshotKey', 'historical-dispatch');
  const parsed = exportDataSchema.parse(baseline);
  expect(parsed.meta.schemaVersion).toBe(6);
  expect(root(parsed).prUrl).toBeNull();
  expect(root(parsed).prs[0]).not.toHaveProperty('ratchet');
  expect(
    (await Reflect.apply(dataBackupService.importData, dataBackupService, [baseline])).workspaces
  ).toEqual({ imported: 3, skipped: 0 });
  expect(await db.prisma.agentSession.findUnique({ where: { id: 'session' } })).toMatchObject({
    workspacePrId: 'pr-root',
  });
  expect(await db.prisma.workspacePRDedicatedSession.count()).toBe(0);
  await clearIntegrationDatabase(db.prisma);
  const invalid = publishedVersion5Backup();
  child(invalid).prs[0]!.id = 'pr-root';
  state.reads = 0;
  await expect(
    Reflect.apply(dataBackupService.importData, dataBackupService, [invalid])
  ).rejects.toBeInstanceOf(ZodError);
  expect(state.reads).toBe(0);
  expect(await db.prisma.workspace.count()).toBe(0);
  expectStructuralIssue(invalid, 'global PR ID');
});
