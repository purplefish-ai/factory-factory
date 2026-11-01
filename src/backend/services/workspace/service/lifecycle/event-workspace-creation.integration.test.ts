import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createLogger } from '@/backend/services/logger.service';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let service: InstanceType<typeof import('./creation.service').WorkspaceCreationService>;
let projectId: string;
const execution = {
  version: 1 as const,
  provider: 'CLAUDE' as const,
  model: 'sonnet',
  reasoningEffort: 'high',
  codexAccountId: null,
  startupModePreset: 'non_interactive' as const,
  accessMode: 'bypassPermissions',
  planModeEnabled: false as const,
};
const source = () => ({
  type: 'EVENT_AGENT' as const,
  projectId,
  runId: 'run',
  reservedWorkspaceId: 'workspace',
  reservedSessionId: 'session',
  initialMessageId: 'message',
  name: 'Event task',
  execution,
  input: { version: 1 as const, context: [] },
  issue: { number: 12, url: 'https://github.com/org/repo/issues/12' },
});
beforeAll(async () => {
  db = await createIntegrationDatabase();
  const { WorkspaceCreationService } =
    await vi.importActual<typeof import('./creation.service')>('./creation.service');
  service = new WorkspaceCreationService({ logger: createLogger('test') });
  expect(service.createEventWorkspaceOnce).toBeTypeOf('function');
}, 30_000);
beforeEach(async () => {
  await db.prisma.workspace.deleteMany();
  await db.prisma.workspaceLaunchOrigin.deleteMany();
  await db.prisma.project.deleteMany();
  const project = await db.prisma.project.create({
    data: { name: 'Repo', slug: 'repo', repoPath: '/repo', worktreeBasePath: '/worktrees' },
  });
  projectId = project.id;
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('creates one reserved workspace atomically with provenance and normal side tables under concurrent retries', async () => {
  const results = await Promise.all([
    service.createEventWorkspaceOnce(source()),
    service.createEventWorkspaceOnce(source()),
    service.createEventWorkspaceOnce(source()),
  ]);
  expect(results.map((row) => row.id)).toEqual(['workspace', 'workspace', 'workspace']);
  expect(await db.prisma.workspace.count()).toBe(1);
  expect(await db.prisma.workspaceLaunchOrigin.findFirst()).toMatchObject({
    runId: 'run',
    workspaceId: 'workspace',
    projectId,
  });
  expect(
    await db.prisma.workspace.findUnique({
      where: { id: 'workspace' },
      include: { prMonitoring: true, prDiscovery: true, runScript: true },
    })
  ).toMatchObject({
    creationSource: 'EVENT_AGENT',
    defaultSessionProvider: 'CLAUDE',
    githubIssueNumber: 12,
    prMonitoring: { enabled: false },
    prDiscovery: { workspaceId: 'workspace' },
    runScript: { workspaceId: 'workspace' },
  });
  expect(results[0]?.creationMetadata).not.toHaveProperty('initialPrompt');
});
it('retains a tombstone after deletion before run linkage and refuses resurrection', async () => {
  await service.createEventWorkspaceOnce(source());
  await db.prisma.workspace.delete({ where: { id: 'workspace' } });
  await expect(service.createEventWorkspaceOnce(source())).rejects.toThrow(/deleted/i);
  expect(await db.prisma.workspace.count()).toBe(0);
  expect(await db.prisma.workspaceLaunchOrigin.count()).toBe(1);
});
it.each(['ARCHIVING', 'ARCHIVED'] as const)('refuses a %s workspace on retry', async (status) => {
  await service.createEventWorkspaceOnce(source());
  await db.prisma.workspace.update({ where: { id: 'workspace' }, data: { status } });
  await expect(service.createEventWorkspaceOnce(source())).rejects.toThrow(/archiv/i);
});
it.each([
  { runId: 'other' },
  { reservedWorkspaceId: 'other' },
  { projectId: 'other' },
  { reservedSessionId: 'other' },
  { initialMessageId: 'other' },
])('rejects mismatched origin %j', async (patch) => {
  await service.createEventWorkspaceOnce(source());
  await expect(service.createEventWorkspaceOnce({ ...source(), ...patch })).rejects.toThrow(
    /ownership/i
  );
  expect(await db.prisma.workspace.count()).toBe(1);
});
it('rolls back provenance when active-project insertion is unavailable', async () => {
  await db.prisma.project.update({ where: { id: projectId }, data: { isArchived: true } });
  await expect(service.createEventWorkspaceOnce(source())).rejects.toThrow();
  expect(await db.prisma.workspaceLaunchOrigin.count()).toBe(0);
  expect(await db.prisma.workspace.count()).toBe(0);
});
it('does not let a generic existing reserved ID acquire event provenance', async () => {
  await db.prisma.workspace.create({
    data: { id: 'workspace', projectId, name: 'Human workspace' },
  });
  await expect(service.createEventWorkspaceOnce(source())).rejects.toThrow();
  expect(await db.prisma.workspaceLaunchOrigin.count()).toBe(0);
});
it('rejects event sources on generic creation and preserves ordinary new-ID semantics', async () => {
  await expect(service.create(source() as never)).rejects.toThrow(/event/i);
  const one = await service.create({ type: 'MANUAL', projectId, name: 'Human' });
  const two = await service.create({ type: 'MANUAL', projectId, name: 'Human' });
  expect(one.id).not.toBe(two.id);
  expect(await db.prisma.workspaceLaunchOrigin.count()).toBe(0);
});

it('publishes creation once after the atomic commit and never on reuse', async () => {
  const { workspaceStateMachine, WORKSPACE_CREATED } =
    await vi.importActual<typeof import('./state-machine.service')>('./state-machine.service');
  const ids: string[] = [];
  const listener = (event: { workspaceId: string }) => {
    ids.push(event.workspaceId);
  };
  workspaceStateMachine.on(WORKSPACE_CREATED, listener);
  try {
    await service.createEventWorkspaceOnce(source());
    await service.createEventWorkspaceOnce(source());
    expect(ids).toEqual(['workspace']);
    expect(await db.prisma.workspaceLaunchOrigin.count()).toBe(1);
  } finally {
    workspaceStateMachine.off(WORKSPACE_CREATED, listener);
  }
});
it('retains workspace provenance after its project is deleted', async () => {
  await service.createEventWorkspaceOnce(source());
  await db.prisma.workspace.delete({ where: { id: 'workspace' } });
  await db.prisma.project.delete({ where: { id: projectId } });
  await expect(service.createEventWorkspaceOnce(source())).rejects.toThrow(/deleted/i);
  expect(
    await db.prisma.workspaceLaunchOrigin.findUnique({ where: { runId: 'run' } })
  ).toMatchObject({ projectId });
});
