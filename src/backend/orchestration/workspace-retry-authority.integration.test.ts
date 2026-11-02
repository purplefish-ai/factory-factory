import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLogger } from '@/backend/services/logger.service';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  boundary,
  releaseEventBoundaries,
  createEventAdmissionFixture,
} from './testing/event-delivery.test-support';

let db: IntegrationDatabase;
let h: Awaited<ReturnType<typeof createEventAdmissionFixture>>;
let workspaceId: string;
let runId: string;
let caller: ReturnType<
  typeof import('@/backend/trpc/workspace/init.trpc').workspaceInitRouter.createCaller
>;
let afterRetryCapture: (() => void) | undefined;
let afterWorkspaceWrite: (() => Promise<void>) | undefined;
const initialize = vi.fn(async () => undefined);
const config = vi.fn(async () => null);
const scripts = vi.fn(async () => ({ handled: true, success: true }));
beforeEach(async () => {
  db = await createIntegrationDatabase();
  afterWorkspaceWrite = undefined;
  afterRetryCapture = undefined;
  const observed = db.prisma.$extends({
    query: {
      workspace: {
        updateMany: async ({ args, query }) => {
          const result = await query(args);
          await afterWorkspaceWrite?.();
          return result;
        },
      },
    },
  });
  vi.doMock('@/backend/db', () => ({ prisma: observed }));
  h = await createEventAdmissionFixture(db);
  const claim = await h.owner.claimNextRun();
  if (claim.status !== 'CLAIMED') {
    throw new Error('Missing claim');
  }
  runId = claim.runId;
  workspaceId = claim.reservedWorkspaceId;
  const binding = await h.owner.readEventExecutionBinding(claim);
  await h.owner.freezeEventExecution({ claim, ...binding, execution: h.execution });
  await new h.workspace.WorkspaceCreationService({
    logger: createLogger('retry-fixture'),
  }).createEventWorkspaceOnce({
    type: 'EVENT_AGENT',
    runId,
    projectId: h.project.id,
    reservedWorkspaceId: workspaceId,
    reservedSessionId: claim.reservedSessionId,
    initialMessageId: claim.initialMessageId,
    name: 'Retry fixture',
    execution: h.execution,
    input: h.input,
  });
  h.session.eventSessionAuthority.configure(h.owner.agentInitialDelivery);
  const { workspaceInitRouter } = await vi.importActual<
    typeof import('@/backend/trpc/workspace/init.trpc')
  >('@/backend/trpc/workspace/init.trpc');
  const authority = await vi.importActual<typeof import('./workspace-retry-authority')>(
    './workspace-retry-authority'
  );
  const { enqueueWorkspaceInitializationTask } = await vi.importActual<
    typeof import('./workspace-init.orchestrator')
  >('./workspace-init.orchestrator');
  caller = workspaceInitRouter.createCaller(
    unsafeCoerce({
      appContext: {
        services: {
          ...h.workspace,
          ...authority,
          captureWorkspaceRetryGuard: async (
            ...args: Parameters<typeof authority.captureWorkspaceRetryGuard>
          ) => {
            const guard = await authority.captureWorkspaceRetryGuard(...args);
            afterRetryCapture?.();
            return guard;
          },
          enqueueWorkspaceInitializationTask,
          createLogger,
          initializeWorkspaceWorktree: initialize,
          factoryConfigService: { readConfig: config },
          executeStartupScriptPipeline: scripts,
          retryQueuedDispatchAfterWorkspaceReady: vi.fn(async () => undefined),
        },
      },
    })
  );
  vi.clearAllMocks();
}, 30_000);
afterEach(async () => {
  releaseEventBoundaries();
  vi.restoreAllMocks();
  vi.doUnmock('@/backend/db');
  await destroyIntegrationDatabase(db);
});

const branches = [
  { status: 'FAILED', worktreePath: null },
  { status: 'READY', worktreePath: null },
  { status: 'READY', worktreePath: '/fixture/worktree' },
  { status: 'FAILED', worktreePath: '/fixture/worktree' },
] as const;
it.each(branches)(
  'blocks actual $status/$worktreePath retry before session insertion or run linkage',
  async (branch) => {
    await db.prisma.workspace.update({
      where: { id: workspaceId },
      data: { ...branch, initErrorMessage: 'Setup failed' },
    });
    await expect(caller.retryInit({ id: workspaceId })).rejects.toThrow(/initial|event/i);
    expect(await db.prisma.workspace.findUnique({ where: { id: workspaceId } })).toMatchObject({
      status: branch.status,
      initRetryCount: 0,
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(scripts).not.toHaveBeenCalled();
    expect(await db.prisma.agentSession.count()).toBe(0);
    expect(await db.prisma.agentRun.findUnique({ where: { id: runId } })).toMatchObject({
      workspaceId: null,
    });
  }
);

async function finished() {
  await db.prisma.agentInitialDelivery.update({ where: { runId }, data: { state: 'FINISHED' } });
  await db.prisma.agentRun.update({
    where: { id: runId },
    data: { launchPreparation: { version: 1, state: 'STARTUP', setupStartedAt: null } },
  });
  await db.prisma.workspace.update({
    where: { id: workspaceId },
    data: { status: 'FAILED', initErrorMessage: 'Setup failed' },
  });
  const { captureWorkspaceRetryGuard } = await vi.importActual<
    typeof import('./workspace-retry-authority')
  >('./workspace-retry-authority');
  const workspace = await h.workspace.workspaceDataService.findByIdWithProject(workspaceId);
  if (!workspace) {
    throw new Error('Missing workspace');
  }
  const guard = await captureWorkspaceRetryGuard(workspace);
  if (!guard) {
    throw new Error('Missing guard');
  }
  return guard;
}
it('rejects a captured FINISHED context at the actual writer after attempt replacement', async () => {
  const guard = await finished();
  await db.prisma.agentRun.update({
    where: { id: runId },
    data: { attemptGeneration: { increment: 1 } },
  });
  await db.prisma.agentInitialDelivery.update({
    where: { runId },
    data: {
      attemptGeneration: { increment: 1 },
      state: 'PENDING',
      messageId: 'replacement',
      sendAttemptId: 'replacement-send',
    },
  });
  await expect(
    h.workspace.workspaceStateMachine.startProvisioning(workspaceId, { guard })
  ).rejects.toThrow(/Event initial work prevents setup retry/);
  expect(await db.prisma.workspace.findUnique({ where: { id: workspaceId } })).toMatchObject({
    status: 'FAILED',
    initRetryCount: 0,
  });
});
it('keeps valid FINISHED historical STARTUP and terminal runs available', async () => {
  await finished();
  await db.prisma.agentRun.update({
    where: { id: runId },
    data: { status: 'COMPLETED', launchPhase: 'FINISHED' },
  });
  expect(await caller.getInitStatus({ id: workspaceId })).toMatchObject({
    retryAvailability: { status: 'AVAILABLE' },
  });
  await caller.retryInit({ id: workspaceId });
  expect(await db.prisma.workspace.findUnique({ where: { id: workspaceId } })).toMatchObject({
    status: 'NEW',
    initRetryCount: 1,
  });
});
it('rejects missing origin instead of treating EVENT_AGENT as ordinary', async () => {
  await db.prisma.workspace.update({ where: { id: workspaceId }, data: { status: 'FAILED' } });
  await db.prisma.workspaceLaunchOrigin.deleteMany({ where: { workspaceId } });
  expect(await caller.getInitStatus({ id: workspaceId })).toMatchObject({
    retryAvailability: { status: 'BLOCKED', reason: 'AUTHORITY_UNAVAILABLE' },
  });
  await expect(caller.retryInit({ id: workspaceId })).rejects.toThrow(/event/i);
});
it('rechecks the captured guard after the real initializer predecessor drains', async () => {
  const guard = await finished();
  const { enqueueWorkspaceInitializationTask, initializeWorkspaceWorktree } = await vi.importActual<
    typeof import('./workspace-init.orchestrator')
  >('./workspace-init.orchestrator');
  let release!: () => void;
  const predecessor = enqueueWorkspaceInitializationTask(
    workspaceId,
    () =>
      new Promise<void>((done) => {
        release = done;
      })
  );
  await Promise.resolve();
  await Promise.resolve();
  const git = vi
    .spyOn(h.workspace.gitOpsService, 'ensureBaseBranchExists')
    .mockRejectedValue(new Error('Unexpected Git effect'));
  const task = initializeWorkspaceWorktree(workspaceId, { guard });
  const outcome = task.then(
    () => null,
    (error: unknown) => error
  );
  await db.prisma.agentInitialDelivery.update({ where: { runId }, data: { state: 'PENDING' } });
  release();
  await predecessor;
  expect(await outcome).toMatchObject({ name: 'WorkspaceInitFenceError' });
  expect(git).not.toHaveBeenCalled();
  expect(await db.prisma.workspace.findUnique({ where: { id: workspaceId } })).toMatchObject({
    status: 'FAILED',
    initRetryCount: 0,
  });
});

it.each(branches)(
  'ordinary $status/$worktreePath still retries through the state machine',
  async (branch) => {
    const ordinary = await db.prisma.workspace.create({
      data: {
        projectId: h.project.id,
        name: 'Ordinary',
        ...branch,
        initErrorMessage: 'Setup failed',
      },
    });
    scripts.mockResolvedValueOnce({ handled: false, success: true });
    expect(await caller.getInitStatus({ id: ordinary.id })).toMatchObject({
      retryAvailability: { status: 'AVAILABLE' },
    });
    await caller.retryInit({ id: ordinary.id });
    expect(await db.prisma.workspace.findUnique({ where: { id: ordinary.id } })).toMatchObject({
      initRetryCount: 1,
      status:
        branch.status === 'READY' && branch.worktreePath
          ? 'READY'
          : branch.status === 'FAILED' && !branch.worktreePath
            ? 'NEW'
            : 'PROVISIONING',
    });
  }
);
it.each(['SETUP', 'STARTUP', 'UNKNOWN', 'AMBIGUOUS'] as const)(
  'rejects %s through every router branch',
  async (state) => {
    if (state === 'AMBIGUOUS') {
      await db.prisma.agentInitialDelivery.update({ where: { runId }, data: { state } });
    } else {
      await db.prisma.agentRun.update({
        where: { id: runId },
        data: { launchPreparation: { version: 1, state, setupStartedAt: null } },
      });
    }
    for (const branch of branches) {
      await db.prisma.workspace.update({
        where: { id: workspaceId },
        data: { ...branch, initErrorMessage: 'Setup failed' },
      });
      await expect(caller.retryInit({ id: workspaceId })).rejects.toThrow(/initial|event/i);
      expect(await db.prisma.workspace.findUnique({ where: { id: workspaceId } })).toMatchObject({
        status: branch.status,
        initRetryCount: 0,
      });
    }
    expect(initialize).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
    expect(scripts).not.toHaveBeenCalled();
  }
);
async function createReservedSession() {
  const run = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  await h.session.sessionDataService.createEventSessionOnce({
    id: run.reservedSessionId!,
    workspaceId,
    runId,
    execution: h.execution,
  });
}
it('blocks FINISHED while the real initial operation remains active, then allows after drain', async () => {
  await createReservedSession();
  const run = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  const fence = await h.owner.agentInitialDelivery.readFence(runId, run.reservedSessionId!);
  const held = boundary();
  const initial = h.session.eventSessionAuthority.runInitial(fence.attempt, () => held.wait());
  await held.entered;
  try {
    await db.prisma.agentInitialDelivery.update({ where: { runId }, data: { state: 'FINISHED' } });
    await db.prisma.workspace.update({ where: { id: workspaceId }, data: { status: 'FAILED' } });
    expect(await caller.getInitStatus({ id: workspaceId })).toMatchObject({
      retryAvailability: { status: 'BLOCKED', reason: 'INITIAL_ACTIVE' },
    });
    await expect(caller.retryInit({ id: workspaceId })).rejects.toThrow(
      /Event initial work prevents setup retry/
    );
  } finally {
    held.release();
    await initial;
  }
  expect(await caller.getInitStatus({ id: workspaceId })).toMatchObject({
    retryAvailability: { status: 'AVAILABLE' },
  });
});
it('rolls back a real workspace write when initial admission appears during the transaction await', async () => {
  await createReservedSession();
  const guard = await finished();
  const write = boundary();
  const ownerRead = boundary();
  h.session.eventSessionAuthority.configure({
    ...h.owner.agentInitialDelivery,
    readFence: async (...args) => {
      await ownerRead.wait();
      return h.owner.agentInitialDelivery.readFence(...args);
    },
  });
  afterWorkspaceWrite = () => write.wait();
  const transition = h.workspace.workspaceStateMachine.startProvisioning(workspaceId, { guard });
  const outcome = transition.catch((error: unknown) => error);
  await write.entered;
  const initial = h.session.eventSessionAuthority
    .runInitial(guard.context.fence.attempt, async () => undefined)
    .catch(() => undefined);
  await ownerRead.entered;
  write.release();
  expect(await outcome).toBeInstanceOf(Error);
  afterWorkspaceWrite = undefined;
  afterRetryCapture = undefined;
  ownerRead.release();
  await initial;
  expect(await db.prisma.workspace.findUnique({ where: { id: workspaceId } })).toMatchObject({
    status: 'FAILED',
    initRetryCount: 0,
  });
});

it.each([
  'missing-delivery',
  'malformed-preparation',
  'generation',
  'execution',
  'owner-unavailable',
] as const)('fails closed for %s owner facts', async (kind) => {
  await finished();
  if (kind === 'missing-delivery') {
    await db.prisma.agentInitialDelivery.delete({ where: { runId } });
  }
  if (kind === 'malformed-preparation') {
    await db.prisma.agentRun.update({
      where: { id: runId },
      data: { launchPreparation: { state: 'untrusted' } },
    });
  }
  if (kind === 'generation') {
    await db.prisma.agentInitialDelivery.update({
      where: { runId },
      data: { attemptGeneration: 99 },
    });
  }
  if (kind === 'execution') {
    await db.prisma.agentRun.update({
      where: { id: runId },
      data: { effectiveExecution: { provider: 'unknown' } },
    });
  }
  if (kind === 'owner-unavailable') {
    h.session.eventSessionAuthority.configure({
      ...h.owner.agentInitialDelivery,
      readFence: () => Promise.reject(new Error('private owner failure')),
    });
  }
  expect(await caller.getInitStatus({ id: workspaceId })).toMatchObject({
    retryAvailability: { status: 'BLOCKED', reason: 'AUTHORITY_UNAVAILABLE' },
  });
  await expect(caller.retryInit({ id: workspaceId })).rejects.toThrow(/event/i);
  expect(initialize).not.toHaveBeenCalled();
});
it('projects the same retry budget enforced by the writer', async () => {
  await finished();
  await db.prisma.workspace.update({ where: { id: workspaceId }, data: { initRetryCount: 3 } });
  expect(await caller.getInitStatus({ id: workspaceId })).toMatchObject({
    retryAvailability: { status: 'BLOCKED', reason: 'RETRY_LIMIT' },
  });
  await expect(caller.retryInit({ id: workspaceId })).rejects.toThrow(
    'Maximum retry attempts (3) exceeded'
  );
  expect(initialize).not.toHaveBeenCalled();
});
it.each(['mode-read', 'mode-write', 'config'] as const)(
  'rejects stale authority after actual router %s await',
  async (stage) => {
    await finished();
    const gate = boundary();
    if (stage === 'config') {
      await db.prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: 'READY', worktreePath: '/fixture' },
      });
      config.mockImplementationOnce(async () => {
        await gate.wait();
        return null;
      });
    } else {
      const readMode = h.workspace.worktreeLifecycleService.getInitMode.bind(
        h.workspace.worktreeLifecycleService
      );
      const writeMode = h.workspace.worktreeLifecycleService.setInitMode.bind(
        h.workspace.worktreeLifecycleService
      );
      if (stage === 'mode-read') {
        vi.spyOn(h.workspace.worktreeLifecycleService, 'getInitMode').mockImplementationOnce(
          async (id) => {
            await gate.wait();
            return readMode(id);
          }
        );
      } else {
        vi.spyOn(h.workspace.worktreeLifecycleService, 'setInitMode').mockImplementationOnce(
          async (id, value, guard) => {
            await gate.wait();
            await h.workspace.worktreeLifecycleService.clearInitMode(id);
            guard?.assertCurrent();
            return writeMode(id, value, guard);
          }
        );
      }
    }
    const request = caller.retryInit({
      id: workspaceId,
      useExistingBranch: stage === 'mode-write' ? true : undefined,
    });
    const result = request.catch((error: unknown) => error);
    await gate.entered;
    await db.prisma.agentInitialDelivery.update({ where: { runId }, data: { state: 'PENDING' } });
    gate.release();
    expect(await result).toBeInstanceOf(Error);
    expect(await db.prisma.workspace.findUnique({ where: { id: workspaceId } })).toMatchObject({
      initRetryCount: 0,
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(scripts).not.toHaveBeenCalled();
  }
);

it.each(['ordinary', 'event'] as const)(
  'preserves %s origin-read infrastructure failure semantics without effects',
  async (kind) => {
    await finished();
    if (kind === 'ordinary') {
      await db.prisma.workspace.update({
        where: { id: workspaceId },
        data: { creationSource: 'MANUAL' },
      });
    }
    const outage = new Error('Fixture origin database unavailable');
    vi.spyOn(h.workspace.workspaceDataService, 'readEventOrigin').mockRejectedValue(outage);
    await expect(caller.retryInit({ id: workspaceId })).rejects.toThrow(
      kind === 'ordinary' ? outage.message : /Event initial work/
    );
    expect(initialize).not.toHaveBeenCalled();
    expect(scripts).not.toHaveBeenCalled();
    expect(await db.prisma.workspace.findUnique({ where: { id: workspaceId } })).toMatchObject({
      status: 'FAILED',
      initRetryCount: 0,
    });
  }
);

it('does not label a durable owner conflict as live local initial work', async () => {
  await finished();
  const { ApplicationError } = await vi.importActual<
    typeof import('@/backend/lib/application-error')
  >('@/backend/lib/application-error');
  h.session.eventSessionAuthority.configure({
    ...h.owner.agentInitialDelivery,
    readFence: () => Promise.reject(new ApplicationError('CONFLICT', 'owner changed')),
  });
  expect(await caller.getInitStatus({ id: workspaceId })).toMatchObject({
    retryAvailability: { status: 'BLOCKED', reason: 'AUTHORITY_UNAVAILABLE' },
  });
});

it('does not replay a captured READY warning after its predecessor finishes setup', async () => {
  await finished();
  await db.prisma.workspace.update({
    where: { id: workspaceId },
    data: { status: 'READY', worktreePath: '/fixture/worktree' },
  });
  const { enqueueWorkspaceInitializationTask } = await vi.importActual<
    typeof import('./workspace-init.orchestrator')
  >('./workspace-init.orchestrator');
  const held = boundary();
  const predecessor = enqueueWorkspaceInitializationTask(workspaceId, () => held.wait());
  await held.entered;
  let captures = 0;
  let bothCaptured!: () => void;
  const captured = new Promise<void>((resolve) => {
    bothCaptured = resolve;
  });
  afterRetryCapture = () => {
    if (++captures === 2) {
      bothCaptured();
    }
  };
  const first = caller.retryInit({ id: workspaceId });
  const second = caller.retryInit({ id: workspaceId });
  // Both RPCs must have captured the same READY warning before the tail runs.
  await captured;
  expect(config).not.toHaveBeenCalled();
  held.release();
  await predecessor;
  await Promise.allSettled([first, second]);
  expect(scripts).toHaveBeenCalledTimes(1);
  expect(config).toHaveBeenCalledTimes(1);
  expect(await db.prisma.workspace.findUnique({ where: { id: workspaceId } })).toMatchObject({
    initRetryCount: 1,
  });
});
