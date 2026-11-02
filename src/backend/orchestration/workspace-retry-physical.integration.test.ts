import { mkdir, stat, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import {
  boundary,
  createEventDeliveryFixture,
  releaseEventBoundaries,
} from './testing/event-delivery.test-support';
let db: IntegrationDatabase;
let h: Awaited<ReturnType<typeof createEventDeliveryFixture>>;
let init: typeof import('./workspace-init.orchestrator');
let guard: import('@/shared/workspace-init-retry').WorkspaceInitGuard;
let terminal: typeof import('@/backend/services/terminal');
const tasks: Promise<unknown>[] = [];
beforeEach(async () => {
  db = await createIntegrationDatabase();
  h = await createEventDeliveryFixture(db, 'CLAUDE', false);
  await db.prisma.agentInitialDelivery.update({
    where: { runId: h.claim.runId },
    data: { state: 'FINISHED' },
  });
  await db.prisma.workspace.update({
    where: { id: h.claim.reservedWorkspaceId },
    data: { status: 'FAILED' },
  });
  init = await vi.importActual<typeof import('./workspace-init.orchestrator')>(
    './workspace-init.orchestrator'
  );
  const authority = await vi.importActual<typeof import('./workspace-retry-authority')>(
    './workspace-retry-authority'
  );
  const workspace = await h.workspace.workspaceDataService.findByIdWithProject(
    h.claim.reservedWorkspaceId
  );
  if (!workspace) {
    throw new Error('Missing workspace');
  }
  const captured = await authority.captureWorkspaceRetryGuard(workspace);
  if (!captured) {
    throw new Error('Missing guard');
  }
  guard = captured;
  terminal = await vi.importActual<typeof import('@/backend/services/terminal')>(
    '@/backend/services/terminal'
  );
  vi.spyOn(terminal.terminalService, 'createTerminal').mockRejectedValue(
    new Error('Unexpected terminal spawn')
  );
  vi.spyOn(terminal.terminalService, 'destroyTerminal');
  vi.spyOn(h.session.sessionLifecycleService, 'startSession').mockRejectedValue(
    new Error('Unexpected provider spawn')
  );
  vi.spyOn(h.session.sessionLifecycleService, 'stopWorkspaceSessions').mockResolvedValue();
  vi.spyOn(h.workspace.gitOpsService, 'ensureBaseBranchExists').mockResolvedValue();
  vi.spyOn(h.workspace.gitOpsService, 'removeWorktree').mockResolvedValue();
  const github = await vi.importActual<typeof import('@/backend/services/github')>(
    '@/backend/services/github'
  );
  vi.spyOn(github.githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('fixture');
}, 30_000);
afterEach(async () => {
  releaseEventBoundaries();
  await Promise.allSettled(tasks.splice(0));
  vi.restoreAllMocks();
  await destroyIntegrationDatabase(db);
});
async function replace() {
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: { attemptGeneration: { increment: 1 } },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { runId: h.claim.runId },
    data: {
      state: 'PENDING',
      attemptGeneration: { increment: 1 },
      messageId: 'replacement-message',
      sendAttemptId: 'replacement-send',
    },
  });
}
it('checks after nested base-branch preflight before Git creation', async () => {
  const preflight = boundary();
  vi.mocked(h.workspace.gitOpsService.ensureBaseBranchExists).mockImplementation(() =>
    preflight.wait()
  );
  const create = vi.spyOn(h.workspace.gitOpsService, 'createWorktree');
  const task = init.initializeWorkspaceWorktree(h.claim.reservedWorkspaceId, { guard });
  tasks.push(task);
  await preflight.entered;
  await replace();
  preflight.release();
  await task;
  expect(create).not.toHaveBeenCalled();
  expect(terminal.terminalService.createTerminal).not.toHaveBeenCalled();
  expect(h.session.sessionLifecycleService.stopWorkspaceSessions).not.toHaveBeenCalled();
  expect(
    await db.prisma.workspace.findUnique({ where: { id: h.claim.reservedWorkspaceId } })
  ).toMatchObject({ status: 'PROVISIONING' });
});
it('joins started Git creation without registering or cleaning replacement resources', async () => {
  const physical = boundary();
  const created = join(db.tempDir, 'created');
  vi.spyOn(h.workspace.gitOpsService, 'createWorktree').mockImplementation(async () => {
    await mkdir(created);
    await physical.wait();
    return { worktreePath: created, branchName: 'created' };
  });
  await h.workspace.worktreeLifecycleService.setInitMode(h.claim.reservedWorkspaceId, true, guard);
  const task = init.initializeWorkspaceWorktree(h.claim.reservedWorkspaceId, {
    guard,
    useExistingBranch: false,
  });
  tasks.push(task);
  let done = false;
  void task.then(() => {
    done = true;
  });
  await physical.entered;
  await replace();
  await db.prisma.workspace.update({
    where: { id: h.claim.reservedWorkspaceId },
    data: { status: 'READY', worktreePath: '/replacement', initScriptPid: 12_345 },
  });
  await h.workspace.worktreeLifecycleService.setInitMode(h.claim.reservedWorkspaceId, false);
  expect(done).toBe(false);
  physical.release();
  await task;
  expect(
    await db.prisma.workspace.findUnique({ where: { id: h.claim.reservedWorkspaceId } })
  ).toMatchObject({ status: 'READY', worktreePath: '/replacement', initScriptPid: 12_345 });
  expect(await h.workspace.worktreeLifecycleService.getInitMode(h.claim.reservedWorkspaceId)).toBe(
    false
  );
  expect((await stat(created)).isDirectory()).toBe(true);
  expect(h.workspace.gitOpsService.removeWorktree).not.toHaveBeenCalled();
  expect(terminal.terminalService.destroyTerminal).not.toHaveBeenCalled();
  expect(h.session.sessionLifecycleService.stopWorkspaceSessions).not.toHaveBeenCalled();
  expect(h.session.sessionLifecycleService.startSession).not.toHaveBeenCalled();
});

it.each(['preflight', 'running'] as const)(
  'fences real script %s and preserves replacement output/PID/state',
  async (stage) => {
    const path = join(db.tempDir, 'script');
    await mkdir(path);
    const source = await h.workspace.workspaceDataService.findByIdWithProject(
      h.claim.reservedWorkspaceId
    );
    if (!source) {
      throw new Error('Missing workspace');
    }
    await h.workspace.workspaceStateMachine.startProvisioning(source.id, { guard });
    const { startupScriptService } = await vi.importActual<
      typeof import('@/backend/services/run-script')
    >('@/backend/services/run-script');
    const preflight = boundary();
    startupScriptService.configure({
      workspace: {
        markReady: (id) => h.workspace.workspaceStateMachine.markReady(id),
        markFailed: (id, error) => h.workspace.workspaceStateMachine.markFailed(id, error),
        clearInitOutput: async (...args) => {
          await h.workspace.workspaceRunScriptService.clearInitOutput(...args);
          if (stage === 'preflight') {
            await preflight.wait();
          }
        },
        appendInitOutput: (...args) =>
          h.workspace.workspaceRunScriptService.appendInitOutput(...args),
        setInitScriptPid: (...args) =>
          h.workspace.workspaceRunScriptService.setInitScriptPid(...args),
        clearInitScriptPid: (...args) =>
          h.workspace.workspaceRunScriptService.clearInitScriptPid(...args),
      },
    });
    const task = startupScriptService.runStartupScript(
      { ...source, worktreePath: path },
      {
        ...source.project,
        startupScriptCommand:
          'touch started; while [ ! -f released ]; do sleep 0.02; done; echo stale-output',
        startupScriptTimeout: 15,
      },
      { guard, deferStateTransition: true }
    );
    const result = task.catch((error: unknown) => error);
    tasks.push(result);
    let drained = false;
    void result.then(() => {
      drained = true;
    });
    try {
      if (stage === 'preflight') {
        await preflight.entered;
      } else {
        await vi.waitFor(
          async () => {
            await access(join(path, 'started'));
          },
          { timeout: 5000 }
        );
      }
      await replace();
      await db.prisma.workspace.update({
        where: { id: source.id },
        data: { status: 'READY', initScriptPid: 54_321, initOutput: 'replacement-output' },
      });
      expect(drained).toBe(false);
    } finally {
      preflight.release();
      await writeFile(join(path, 'released'), '');
    }
    expect(await result).toBeInstanceOf(Error);
    if (stage === 'preflight') {
      await expect(access(join(path, 'started'))).rejects.toThrow();
    }
    expect(await db.prisma.workspace.findUnique({ where: { id: source.id } })).toMatchObject({
      status: 'READY',
      initScriptPid: 54_321,
      initOutput: 'replacement-output',
    });
  }
);

it('preserves a replacement directory when nested cleanup preflight outlives its captured attempt', async () => {
  const path = join(db.tempDir, 'cleanup-candidate');
  await mkdir(path);
  await h.workspace.workspaceStateMachine.startProvisioning(h.claim.reservedWorkspaceId, { guard });
  const source = await h.workspace.workspaceDataService.findByIdWithProject(
    h.claim.reservedWorkspaceId
  );
  if (!source) {
    throw new Error('Missing workspace');
  }
  vi.mocked(h.workspace.gitOpsService.removeWorktree).mockRestore();
  const { GitClient } = await vi.importActual<typeof import('@/backend/clients/git.client')>(
    '@/backend/clients/git.client'
  );
  const listing = boundary();
  vi.spyOn(GitClient.prototype, 'listWorktreesWithBranches').mockImplementation(async () => {
    await listing.wait();
    return [];
  });
  const { handleWorkspaceInitFailure } = await vi.importActual<
    typeof import('./workspace-init-cleanup')
  >('./workspace-init-cleanup');
  const cleanup = handleWorkspaceInitFailure(
    source.id,
    new Error('Setup failed'),
    undefined,
    { project: source.project, worktreeInfo: { worktreePath: path, branchName: 'candidate' } },
    guard
  );
  tasks.push(cleanup);
  await listing.entered;
  await replace();
  await db.prisma.workspace.update({
    where: { id: source.id },
    data: { status: 'READY', worktreePath: path },
  });
  await writeFile(join(path, 'replacement'), 'owned by replacement');
  listing.release();
  await cleanup;
  await expect(access(join(path, 'replacement'))).resolves.toBeUndefined();
  expect(await db.prisma.workspace.findUnique({ where: { id: source.id } })).toMatchObject({
    status: 'READY',
    worktreePath: path,
  });
});
