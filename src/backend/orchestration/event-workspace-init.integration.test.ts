import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
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
let init: typeof import('./event-workspace-init.orchestrator').initializeEventWorkspaceWorktree;
let worktreePath: string;
const initTasks = new Set<ReturnType<typeof init>>();
beforeEach(async () => {
  db = await createIntegrationDatabase();
  h = await createEventDeliveryFixture(db, 'CLAUDE', false);
  worktreePath = join(db.tempDir, `workspace-${h.claim.reservedWorkspaceId}`);
  await mkdir(worktreePath);
  // Controlled Git fixture: the pre-created directory holds test config, not a retained worktree.
  vi.spyOn(h.workspace.gitOpsService, 'prepareWorktreeCreation').mockResolvedValue(worktreePath);
  const module = await vi.importActual<typeof import('./event-workspace-init.orchestrator')>(
    './event-workspace-init.orchestrator'
  );
  init = (input) => {
    const task = module.initializeEventWorkspaceWorktree(input);
    initTasks.add(task);
    void task.then(
      () => initTasks.delete(task),
      () => initTasks.delete(task)
    );
    return task;
  };
  vi.spyOn(h.workspace.gitOpsService, 'ensureBaseBranchExists').mockResolvedValue();
  vi.spyOn(h.workspace.gitOpsService, 'removeWorktree').mockResolvedValue();
  vi.spyOn(h.workspace.gitOpsService, 'createWorktree').mockResolvedValue({
    worktreePath,
    branchName: 'event-test',
  });
  const github = await vi.importActual<typeof import('@/backend/services/github')>(
    '@/backend/services/github'
  );
  vi.spyOn(github.githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('fixture');
}, 30_000);
afterEach(async () => {
  try {
    releaseEventBoundaries();
    vi.useRealTimers();
    await Promise.allSettled([...initTasks]);
  } finally {
    vi.restoreAllMocks();
    await destroyIntegrationDatabase(db);
  }
});
const input = (signal = new AbortController().signal) => ({ claim: h.claim, signal });
it('initializes the reserved event workspace without default session startup or legacy auto-init', async () => {
  const linearContext =
    await vi.importActual<typeof import('./linear-config.helper')>('./linear-config.helper');
  const linearLookup = vi.spyOn(linearContext, 'getWorkspaceLinearContext').mockResolvedValue({
    apiKey: 'fixture-only',
    linearIssueId: 'fixture-issue',
  });
  const dispatch = vi.spyOn(h.session.sessionDispatchService, 'tryDispatchNextMessage');
  const startup = vi.spyOn(h.session.sessionLifecycleService, 'startSession');
  const extra = await h.session.sessionDataService.createAgentSession({
    workspaceId: h.claim.reservedWorkspaceId,
    workflow: 'followup',
    provider: 'CLAUDE',
    model: 'sonnet',
  });
  const result = await init(input());
  expect(result).toMatchObject({
    status: 'READY',
    workspaceId: h.claim.reservedWorkspaceId,
    sessionId: h.attempt.sessionId,
  });
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({ status: 'READY', worktreePath });
  expect(h.session.sessionDomainService.getQueueLength(h.attempt.sessionId)).toBe(0);
  expect(h.session.sessionDomainService.getQueueLength(extra.id)).toBe(0);
  expect(startup).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(linearLookup).not.toHaveBeenCalled();
  expect(await db.prisma.terminalSession.count()).toBe(0);
});
it('rejects malformed factory config rather than publishing READY', async () => {
  await writeFile(join(worktreePath, 'factory-factory.json'), '{broken');
  expect(await init(input())).toMatchObject({ status: 'FAILED', cleanup: 'CONFIRMED' });
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({ status: 'FAILED' });
});
it('drains late Git creation after abort without registering its path or publishing READY', async () => {
  const creating = boundary();
  vi.mocked(h.workspace.gitOpsService.createWorktree).mockImplementation(async () => {
    await creating.wait();
    return { worktreePath, branchName: 'event-test' };
  });
  const removed = vi.spyOn(h.workspace.gitOpsService, 'removeWorktree').mockResolvedValue();
  const cancellation = new AbortController();
  let done = false;
  const task = init(input(cancellation.signal)).then((result) => {
    done = true;
    return result;
  });
  await creating.entered;
  cancellation.abort();
  await nextTurn();
  expect(done).toBe(false);
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({ status: 'PROVISIONING', worktreePath: null });
  creating.release();
  expect(await task).toMatchObject({ status: 'ABORTED', cleanup: 'CONFIRMED' });
  expect(removed).toHaveBeenCalledWith(worktreePath, expect.any(Object));
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({ status: 'FAILED', worktreePath: null });
});
it('fences the no-script READY transaction if the claim changes at beforeReady', async () => {
  const result = await init({
    ...input(),
    beforeReady: async () => {
      await db.prisma.agentRun.update({
        where: { id: h.claim.runId },
        data: { workerGeneration: { increment: 1 } },
      });
    },
  });
  expect(result).toMatchObject({ status: 'STALE' });
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({ status: 'PROVISIONING' });
});
it('keeps ordinary nonzero setup warnings and successful startup work', async () => {
  await writeFile(
    join(worktreePath, 'factory-factory.json'),
    JSON.stringify({ scripts: { setup: 'printf setup; exit 7' } })
  );
  await db.prisma.project.update({
    where: { id: h.workspaceSource.projectId },
    data: { startupScriptCommand: 'printf startup' },
  });
  expect(await init(input())).toMatchObject({ status: 'READY' });
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({
    status: 'READY',
    initOutput: expect.stringContaining('setupstartup'),
    initErrorMessage: expect.any(String),
  });
});
it.each(['ARCHIVED', 'DELETED'] as const)(
  'does not resurrect a workspace %s at the READY publication boundary',
  async (state) => {
    const result = await init({
      ...input(),
      beforeReady: async () => {
        if (state === 'DELETED') {
          await db.prisma.workspace.delete({ where: { id: h.claim.reservedWorkspaceId } });
        } else {
          await db.prisma.workspace.update({
            where: { id: h.claim.reservedWorkspaceId },
            data: { status: state },
          });
        }
      },
    });
    expect(result).toMatchObject({ status: 'STALE' });
    const row = await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId);
    if (state === 'DELETED') {
      expect(row).toBeNull();
    } else {
      expect(row).toMatchObject({ status: 'ARCHIVED' });
    }
  }
);
it('serializes duplicate event initialization through the legacy workspace tail', async () => {
  const creating = boundary();
  vi.mocked(h.workspace.gitOpsService.createWorktree).mockImplementation(async () => {
    await creating.wait();
    return { worktreePath, branchName: 'event-test' };
  });
  const first = init(input());
  await creating.entered;
  const second = init(input());
  creating.release();
  expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([
    'READY',
    'READY',
  ]);
  expect(h.workspace.gitOpsService.createWorktree).toHaveBeenCalledOnce();
});
it('returns TIMED_OUT only after an uncancellable Git operation drains at the fifteen-minute deadline', async () => {
  const creating = boundary();
  vi.mocked(h.workspace.gitOpsService.createWorktree).mockImplementation(async () => {
    await creating.wait();
    return { worktreePath, branchName: 'event-test' };
  });
  vi.useFakeTimers();
  let done = false;
  const task = init(input()).then((result) => {
    done = true;
    return result;
  });
  await creating.entered;
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
  expect(done).toBe(false);
  creating.release();
  expect(await task).toMatchObject({ status: 'TIMED_OUT', cleanup: 'CONFIRMED' });
  expect(h.workspace.gitOpsService.removeWorktree).toHaveBeenCalledOnce();
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({ status: 'PROVISIONING' });
  // Advancing fifteen minutes also expires the real sixty-second claim lease; no FAILED write is authorized.
});
it('retains UNKNOWN cleanup in a failed script result without publishing READY', async () => {
  const script = await vi.importActual<typeof import('@/backend/services/run-script')>(
    '@/backend/services/run-script'
  );
  await writeFile(
    join(worktreePath, 'factory-factory.json'),
    JSON.stringify({ scripts: { setup: 'task' } })
  );
  const called = vi
    .spyOn(script.startupScriptService, 'runEventStartupScript')
    .mockRejectedValue(new script.EventSetupError('TIMED_OUT', 'UNKNOWN', 'Cleanup unconfirmed'));
  expect(await init(input())).toMatchObject({ status: 'TIMED_OUT', cleanup: 'UNKNOWN' });
  expect(called).toHaveBeenCalledOnce();
  expect(await h.read()).toMatchObject({ state: 'PENDING' });
  expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
    status: 'RUNNING',
  });
});
it('rejects local task invalidation before READY without changing the superseded workspace status', async () => {
  let current = true;
  const result = await init({
    ...input(),
    assertCurrent: () => {
      if (!current) {
        throw new Error('Task superseded');
      }
    },
    beforeReady: () => {
      current = false;
      return Promise.resolve();
    },
  });
  expect(result).toMatchObject({ status: 'STALE' });
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({ status: 'PROVISIONING' });
});
it.skipIf(process.platform === 'win32')(
  'aborts an actually spawned setup group before READY and drains its output',
  async () => {
    await writeFile(
      join(worktreePath, 'factory-factory.json'),
      JSON.stringify({ scripts: { setup: 'printf script-started; exec sleep 30' } })
    );
    const cancel = new AbortController();
    const task = init(input(cancel.signal));
    try {
      await vi.waitFor(async () => {
        const workspace = await h.workspace.workspaceDataService.findById(
          h.claim.reservedWorkspaceId
        );
        expect(workspace?.initOutput).toContain('script-started');
        expect(workspace?.initScriptPid).toBeGreaterThan(1);
      });
      cancel.abort();
      expect(await task).toMatchObject({ status: 'ABORTED', cleanup: 'CONFIRMED' });
      expect(
        await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
      ).toMatchObject({ status: 'FAILED', initScriptPid: null });
    } finally {
      cancel.abort();
      await task;
    }
  }
);
it.each(['CONFIRMED', 'UNKNOWN'] as const)(
  'joins cleanup after Git rejects beyond physical creation and returns %s proof',
  async (cleanup) => {
    let physicalWorkStarted = false;
    vi.mocked(h.workspace.gitOpsService.createWorktree).mockImplementation(async () => {
      await writeFile(join(worktreePath, 'partial-checkout'), 'partial physical work');
      physicalWorkStarted = true;
      throw new Error('Git failed after partial worktree creation');
    });
    const removing = boundary();
    vi.mocked(h.workspace.gitOpsService.removeWorktree).mockImplementation(async () => {
      await removing.wait();
      if (cleanup === 'UNKNOWN') {
        throw new Error('Cleanup failed');
      }
      await rm(worktreePath, { recursive: true });
    });
    let done = false;
    const task = init(input()).then((result) => {
      done = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(physicalWorkStarted).toBe(true));
      await vi.waitFor(() => expect(h.workspace.gitOpsService.removeWorktree).toHaveBeenCalled());
      expect(done).toBe(false);
      removing.release();
      expect(await task).toMatchObject({ status: 'FAILED', cleanup });
      const partial = readFile(join(worktreePath, 'partial-checkout'), 'utf8');
      if (cleanup === 'CONFIRMED') {
        await expect(partial).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await expect(partial).resolves.toBe('partial physical work');
      }
      expect(
        await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
      ).toMatchObject({ status: 'FAILED', worktreePath: null });
    } finally {
      removing.release();
      await task;
    }
  }
);

it('preserves a retained worktree when strict configuration fails', async () => {
  await db.prisma.workspace.update({
    where: { id: h.claim.reservedWorkspaceId },
    data: { worktreePath },
  });
  await writeFile(join(worktreePath, 'factory-factory.json'), '{broken');
  expect(await init(input())).toMatchObject({ status: 'FAILED' });
  expect(h.workspace.gitOpsService.prepareWorktreeCreation).not.toHaveBeenCalled();
  expect(h.workspace.gitOpsService.createWorktree).not.toHaveBeenCalled();
  expect(h.workspace.gitOpsService.removeWorktree).not.toHaveBeenCalled();
  expect(await readFile(join(worktreePath, 'factory-factory.json'), 'utf8')).toBe('{broken');
});
it('never creates or removes a candidate rejected by the Git owner as preexisting', async () => {
  vi.mocked(h.workspace.gitOpsService.prepareWorktreeCreation).mockRejectedValue(
    new Error('Preexisting worktree')
  );
  expect(await init(input())).toMatchObject({ status: 'FAILED' });
  expect(h.workspace.gitOpsService.createWorktree).not.toHaveBeenCalled();
  expect(h.workspace.gitOpsService.removeWorktree).not.toHaveBeenCalled();
});

it('preserves STALE when the durable fence changes only at script PID cleanup', async () => {
  await writeFile(
    join(worktreePath, 'factory-factory.json'),
    JSON.stringify({ scripts: { setup: 'printf cleanup-boundary' } })
  );
  const owner = h.workspace.eventWorkspaceInitService;
  const writePid = owner.scriptPid;
  const cleanup = vi.spyOn(owner, 'scriptPid').mockImplementation(async (...args) => {
    if (args[2]) {
      await db.prisma.agentRun.update({
        where: { id: h.claim.runId },
        data: { workerGeneration: { increment: 1 } },
      });
    }
    return writePid(...args);
  });
  expect(await init(input())).toMatchObject({ status: 'STALE' });
  expect(cleanup.mock.calls.some((args) => args[2])).toBe(true);
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({ status: 'PROVISIONING' });
});
it('invalidates READY with the same missing path without recreating the retained workspace', async () => {
  expect(await init(input())).toMatchObject({ status: 'READY' });
  await rm(worktreePath, { recursive: true });
  expect(await init(input())).toMatchObject({ status: 'FAILED' });
  expect(
    await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId)
  ).toMatchObject({ status: 'FAILED', worktreePath });
  expect(h.workspace.gitOpsService.createWorktree).toHaveBeenCalledOnce();
});
it('retains a marked Unicode-safe bounded output tail inside the event owner transaction', async () => {
  const owner = h.workspace.eventWorkspaceInitService;
  await owner.start(h.claim);
  await owner.appendOutput(h.claim, `${'😀'.repeat(25_600)}x`);
  const row = await h.workspace.workspaceDataService.findById(h.claim.reservedWorkspaceId);
  expect(row?.initOutput?.startsWith('[...truncated...]\n')).toBe(true);
  expect(Buffer.from(row?.initOutput ?? '').toString('utf8')).toBe(row?.initOutput);
  expect(row?.initOutput?.length).toBeLessThanOrEqual(50 * 1024);
  expect(row?.initOutput?.endsWith('😀x')).toBe(true);
});
