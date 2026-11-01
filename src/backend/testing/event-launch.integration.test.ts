import { execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
const scriptProcess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: scriptProcess.spawn,
}));
import {
  createEventAdmissionFixture,
  createEventDeliveryFixture,
  boundary,
  releaseEventBoundaries,
} from '@/backend/orchestration/testing/event-delivery.test-support';
import { fakeEventProvider } from '@/backend/orchestration/testing/event-provider.test-support';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let h: Awaited<ReturnType<typeof createEventDeliveryFixture>>;
const providers = new Map<string, ReturnType<typeof fakeEventProvider>>();
const tasks: Promise<unknown>[] = [];
const execFileAsync = promisify(execFile);
beforeEach(async () => {
  db = await createIntegrationDatabase();
  providers.clear();
  scriptProcess.spawn.mockReset();
  const nativeProcess =
    await vi.importActual<typeof import('node:child_process')>('node:child_process');
  scriptProcess.spawn.mockImplementation(nativeProcess.spawn);
  tasks.length = 0;
  h = await createEventDeliveryFixture(db, 'CLAUDE', false, true);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('No host signals');
  });
  const factory = await vi.importActual<
    typeof import('@/backend/services/session/service/acp/acp-client-factory')
  >('@/backend/services/session/service/acp/acp-client-factory');
  vi.spyOn(factory.AcpClientFactory.prototype, 'createClient').mockImplementation(
    async ({ options }) => {
      const run = await db.prisma.agentRun.findUniqueOrThrow({
        where: { reservedSessionId: options.sessionId },
      });
      expect(run.workspaceId).toBe(run.reservedWorkspaceId);
      expect(
        await db.prisma.workspace.findUnique({ where: { id: run.workspaceId! } })
      ).toMatchObject({ status: 'READY' });
      const provider = fakeEventProvider(h.session.AcpProcessHandle, options, async () => {
        expect(
          await db.prisma.agentInitialDelivery.findUnique({ where: { runId: run.id } })
        ).toMatchObject({ state: 'SENDING' });
      });
      providers.set(options.sessionId, provider);
      return provider.handle;
    }
  );
  vi.spyOn(h.workspace.gitOpsService, 'prepareWorktreeCreation').mockImplementation(
    async (project, name) => ({
      worktreePath: join(project.worktreeBasePath, name),
      canonicalBasePath: project.worktreeBasePath,
    })
  );
  vi.spyOn(h.workspace.gitOpsService, 'ensureBaseBranchExists').mockResolvedValue();
  vi.spyOn(h.workspace.gitOpsService, 'createWorktree').mockImplementation(
    async (project, name) => {
      const run = await db.prisma.agentRun.findUniqueOrThrow({
        where: { reservedWorkspaceId: name.replace('workspace-', '') },
      });
      expect(run.workspaceId).toBe(run.reservedWorkspaceId);
      const worktreePath = join(project.worktreeBasePath, name);
      await mkdir(worktreePath, { recursive: true });
      return { worktreePath, branchName: 'event-test' };
    }
  );
  const github = await vi.importActual<typeof import('@/backend/services/github')>(
    '@/backend/services/github'
  );
  vi.spyOn(github.githubCLIService, 'getAuthenticatedUsername').mockResolvedValue('fixture');
}, 30_000);
afterEach(async () => {
  try {
    releaseEventBoundaries();
    for (const provider of providers.values()) {
      provider.response.resolve({ stopReason: 'end_turn' });
    }
    await Promise.allSettled(tasks);
    await h?.session.acpRuntimeManager.stopAllClients(10).catch(() => undefined);
    h?.session.sessionPromptTurnCompletionService.clearAll();
    h?.session.sessionDomainService.clearAllSessions();
    expect(process.kill).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    await destroyIntegrationDatabase(db);
  }
});

it('creates, links and initializes before the real singleton send and retains initial outcome', async () => {
  expect(await db.prisma.workspace.count()).toBe(0);
  const launch = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  const task = launch.launchEventRun(h.claim, new AbortController().signal);
  tasks.push(task);
  void task.catch(() => undefined);
  await vi.waitFor(() => expect(providers.size).toBe(1));
  const provider = providers.get(h.attempt.sessionId)!;
  await provider.called;
  provider.response.resolve({ stopReason: 'end_turn' });
  await task;
  expect(await h.read()).toMatchObject({ state: 'FINISHED', execution: h.execution });
  expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
    status: 'RUNNING',
    launchPhase: 'ACTIVE',
  });
  expect(await db.prisma.workspace.count()).toBe(1);
  expect(await db.prisma.agentSession.count()).toBe(1);
});

it('hands four independent committed claims off without waiting for turns and defers the fifth', async () => {
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  const consumer = createEventRunConsumer();
  const claims = [h.claim];
  for (let i = 0; i < 3; i++) {
    claims.push((await createEventDeliveryFixture(db, 'CLAUDE', false, true)).claim);
  }
  for (const claim of claims) {
    await consumer.consumeClaim(claim, new AbortController().signal);
  }
  await createEventAdmissionFixture(db);
  expect(await h.owner.claimNextRun()).toEqual({ status: 'DEFERRED', reason: 'CAPACITY' });
  await vi.waitFor(() => expect(providers.size).toBe(4));
  for (const provider of providers.values()) {
    await provider.called;
    provider.response.resolve({ stopReason: 'end_turn' });
  }
  await consumer.drain();
  expect(await db.prisma.agentInitialDelivery.count({ where: { state: 'FINISHED' } })).toBe(4);
});

it('retains an already-aborted committed claim as safely resumable without creating resources', async () => {
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  const consumer = createEventRunConsumer();
  await consumer.consumeClaim(h.claim, AbortSignal.abort());
  await consumer.drain();
  expect(await db.prisma.workspace.count()).toBe(0);
  expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
    status: 'RUNNING',
    reasonCode: 'SHUTDOWN',
    launchPreparation: { state: 'SAFE' },
  });
});

it.each(['workspace', 'session', 'link'] as const)(
  'resumes after committed %s handoff interruption without duplicate resources',
  async (boundary) => {
    const { launchEventRun } = await vi.importActual<
      typeof import('@/backend/orchestration/event-run-launch.orchestrator')
    >('@/backend/orchestration/event-run-launch.orchestrator');
    const cancellation = new AbortController();
    const creation = h.workspace.WorkspaceCreationService.prototype.createEventWorkspaceOnce;
    const session = h.session.sessionDataService.createEventSessionOnce.bind(
      h.session.sessionDataService
    );
    const link = h.owner.eventRunLaunch.link;
    const spy =
      boundary === 'workspace'
        ? vi
            .spyOn(h.workspace.WorkspaceCreationService.prototype, 'createEventWorkspaceOnce')
            .mockImplementationOnce(async function (
              this: InstanceType<typeof h.workspace.WorkspaceCreationService>,
              source
            ) {
              const result = await creation.call(this, source);
              cancellation.abort();
              return result;
            })
        : boundary === 'session'
          ? vi
              .spyOn(h.session.sessionDataService, 'createEventSessionOnce')
              .mockImplementationOnce(async (input) => {
                const result = await session(input);
                cancellation.abort();
                return result;
              })
          : vi.spyOn(h.owner.eventRunLaunch, 'link').mockImplementationOnce(async (claim) => {
              await link(claim);
              cancellation.abort();
            });
    await launchEventRun(h.claim, cancellation.signal);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    expect(providers.size).toBe(0);
    expect(h.workspace.gitOpsService.createWorktree).not.toHaveBeenCalled();
    const [recovered] = await h.owner.eventRunLaunch.recover([], 4);
    expect(recovered?.claim.reservedWorkspaceId).toBe(h.claim.reservedWorkspaceId);
    const task = launchEventRun(recovered!.claim, new AbortController().signal);
    tasks.push(task);
    await vi.waitFor(() => expect(providers.size).toBe(1));
    const provider = providers.get(h.claim.reservedSessionId)!;
    await provider.called;
    provider.response.resolve({ stopReason: 'end_turn' });
    await task;
    expect(await db.prisma.workspace.count()).toBe(1);
    expect(await db.prisma.agentSession.count()).toBe(1);
    expect(provider.connection.prompt).toHaveBeenCalledOnce();
  }
);

it('holds preparation capacity when an owned Git cleanup loses its canonical base despite successful removal return', async () => {
  const { launchEventRun } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  const git = (...args: string[]) => execFileAsync('git', args, { cwd: db.tempDir });
  await git('init');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'Initial'
  );
  const base = join(db.tempDir, 'base-link');
  const canonical = join(db.tempDir, 'canonical-base');
  await mkdir(canonical);
  await symlink(canonical, base, 'dir');
  await db.prisma.project.updateMany({ data: { worktreeBasePath: base } });
  const cancellation = new AbortController();
  vi.mocked(h.workspace.gitOpsService.prepareWorktreeCreation).mockRestore();
  vi.mocked(h.workspace.gitOpsService.createWorktree).mockImplementation(async (_project, name) => {
    const path = join(base, name);
    await git('worktree', 'add', '-b', 'event-owned', path);
    await rm(base);
    cancellation.abort();
    return { worktreePath: path, branchName: 'event-owned' };
  });
  const removal = vi.spyOn(h.workspace.gitOpsService, 'removeWorktree');
  await launchEventRun(h.claim, cancellation.signal);
  expect(removal).toHaveResolved();
  expect((await git('worktree', 'list', '--porcelain')).stdout).toContain('refs/heads/event-owned');
  expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
    status: 'RUNNING',
    launchPhase: 'NEEDS_ATTENTION',
    reasonCode: 'PREPARATION_CLEANUP_UNCERTAIN',
    launchPreparation: { state: 'UNKNOWN' },
  });
  expect(await h.owner.eventRunLaunch.recover([], 4)).toEqual([]);
  expect(await h.read()).toMatchObject({ state: 'PENDING' });
  expect(providers.size).toBe(0);
});

it('does not reset the original setup deadline on a safe retry', async () => {
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: {
      launchPreparation: {
        version: 1,
        state: 'SAFE',
        setupStartedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
      },
    },
  });
  const { launchEventRun } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  const task = launchEventRun(h.claim, new AbortController().signal);
  tasks.push(task);
  // Resolve a wrong implementation's prompt so this regression fails without hanging teardown.
  await vi.waitFor(async () => {
    const run = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
    expect(run.status === 'FAILED' || providers.size > 0).toBe(true);
  });
  for (const provider of providers.values()) {
    provider.response.resolve({ stopReason: 'end_turn' });
  }
  await task;
  expect(h.workspace.gitOpsService.createWorktree).not.toHaveBeenCalled();
  expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
    status: 'FAILED',
    reasonCode: 'SETUP_TIMEOUT',
  });
});

it('holds the selected Codex reservation through freeze and session creation and never selects again', async () => {
  const codex = await createEventDeliveryFixture(db, 'CODEX', false, true);
  const accounts = await vi.importActual<typeof import('@/backend/services/codex-accounts')>(
    '@/backend/services/codex-accounts'
  );
  vi.spyOn(accounts.codexAccountService, 'getEnabledAccountIds').mockResolvedValue([
    'event-test-account',
  ]);
  vi.spyOn(accounts.codexAccountService, 'getRuntimeContext').mockImplementation(async (id) => ({
    accountId: id!,
    homeDir: db.tempDir,
    sessionsDir: db.tempDir,
    env: {},
  }));
  const cancellation = new AbortController();
  const reserve: typeof accounts.codexAccountService.withAccountReservation = async (
    _options,
    create
  ) => {
    const result = await create('event-test-account');
    expect(await db.prisma.agentRun.findUnique({ where: { id: codex.claim.runId } })).toMatchObject(
      { effectiveExecution: { codexAccountId: 'event-test-account' } }
    );
    expect(
      await db.prisma.agentSession.findUnique({ where: { id: codex.claim.reservedSessionId } })
    ).not.toBeNull();
    cancellation.abort();
    return result;
  };
  const selected = vi
    .spyOn(accounts.codexAccountService, 'withAccountReservation')
    .mockImplementation(reserve);
  const { launchEventRun } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  await launchEventRun(codex.claim, cancellation.signal);
  const recovered = (await codex.owner.eventRunLaunch.recover([h.claim.runId], 4))[0]!;
  const task = launchEventRun(recovered.claim, new AbortController().signal);
  tasks.push(task);
  await vi.waitFor(() => expect(providers.has(codex.claim.reservedSessionId)).toBe(true));
  const provider = providers.get(codex.claim.reservedSessionId)!;
  await provider.called;
  expect(provider.options.codexAccountContext?.accountId).toBe('event-test-account');
  expect(provider.handle.configOptions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'model', currentValue: 'gpt-5.4' }),
      expect.objectContaining({ id: 'reasoning_effort', currentValue: 'high' }),
    ])
  );
  provider.response.resolve({ stopReason: 'end_turn' });
  await task;
  expect(selected).toHaveBeenCalledOnce();
});

it('uses the current authorized attempt message while retaining original run provenance', async () => {
  const claim = { ...h.claim, attemptGeneration: 2 };
  await db.prisma.agentRun.update({ where: { id: claim.runId }, data: { attemptGeneration: 2 } });
  await db.prisma.agentInitialDelivery.update({
    where: { runId: claim.runId },
    data: { attemptGeneration: 2, messageId: 'current-message', sendAttemptId: 'current-send' },
  });
  const { launchEventRun } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  const task = launchEventRun(claim, new AbortController().signal);
  tasks.push(task);
  await vi.waitFor(() => expect(providers.size).toBe(1));
  const provider = providers.get(claim.reservedSessionId)!;
  await provider.called;
  expect(await h.read()).toMatchObject({
    state: 'SENDING',
    attempt: { messageId: 'current-message', sendAttemptId: 'current-send', attemptGeneration: 2 },
  });
  expect(await db.prisma.agentRun.findUnique({ where: { id: claim.runId } })).toMatchObject({
    initialMessageId: h.claim.initialMessageId,
  });
  provider.response.resolve({ stopReason: 'end_turn' });
  await task;
});

it('fences invocation when lease renewal fails during the committed SENDING observation', async () => {
  const gate = boundary();
  const beforeSend = h.owner.agentInitialDelivery.beforeSend;
  vi.spyOn(h.owner.agentInitialDelivery, 'beforeSend').mockImplementation(async (...args) => {
    await beforeSend(...args);
    await gate.wait();
  });
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  const consumer = createEventRunConsumer();
  await consumer.consumeClaim(h.claim, new AbortController().signal);
  await gate.entered;
  await db.prisma.agentRun.update({
    where: { id: h.claim.runId },
    data: { leaseExpiresAt: new Date(0) },
  });
  await consumer.maintain(new AbortController().signal);
  gate.release();
  await consumer.drain();
  expect(providers.get(h.claim.reservedSessionId)!.connection.prompt).not.toHaveBeenCalled();
  expect(await h.read()).toMatchObject({ state: 'AMBIGUOUS' });
});

it('preserves composed PID and output at the UNKNOWN cleanup boundary without reconstructing evidence', async () => {
  await db.prisma.project.updateMany({ data: { startupScriptCommand: 'controlled-script' } });
  const child = Object.assign(new EventEmitter(), {
    pid: 12_345,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  scriptProcess.spawn.mockReturnValue(unsafeCoerce<ChildProcess>(child));
  const groups = await vi.importActual<typeof import('@/backend/lib/owned-process-group')>(
    '@/backend/lib/owned-process-group'
  );
  const cleanup = boundary();
  vi.spyOn(groups, 'stopOwnedProcessGroup').mockImplementation(async () => {
    await cleanup.wait();
    return 'UNKNOWN';
  });
  const originalPidWrite = h.workspace.eventWorkspaceInitService.scriptPid;
  let sets = 0;
  const pidWrites = vi
    .spyOn(h.workspace.eventWorkspaceInitService, 'scriptPid')
    .mockImplementation((...args) => {
      if (!args[2] && ++sets > 1) {
        return Promise.reject(new Error('Cannot reconstruct PID evidence'));
      }
      return originalPidWrite(...args);
    });
  const { launchEventRun } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  const cancellation = new AbortController();
  const task = launchEventRun(h.claim, cancellation.signal);
  tasks.push(task);
  const workspace = () =>
    db.prisma.workspace.findUnique({ where: { id: h.claim.reservedWorkspaceId } });
  try {
    await vi.waitFor(async () =>
      expect(await workspace()).toMatchObject({ initScriptPid: 12_345 })
    );
    child.stdout.write('Persistent setup output');
    await vi.waitFor(async () =>
      expect(await workspace()).toMatchObject({ initOutput: 'Persistent setup output' })
    );
    cancellation.abort();
    await cleanup.entered;
    expect(await workspace()).toMatchObject({
      initScriptPid: 12_345,
      initOutput: 'Persistent setup output',
    });
    cleanup.release();
    await task;
    expect(await workspace()).toMatchObject({
      initScriptPid: 12_345,
      initOutput: 'Persistent setup output',
      status: 'PROVISIONING',
    });
    expect(pidWrites.mock.calls.map((args) => args[2])).toEqual([false]);
    expect(await h.owner.eventRunLaunch.recover([], 4)).toEqual([]);
    expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
      status: 'RUNNING',
      launchPhase: 'NEEDS_ATTENTION',
    });
  } finally {
    cancellation.abort();
    cleanup.release();
    await task;
  }
});

it.each([
  ['LOCAL_RUNTIME_GROUP_STOPPED', 'ECONNRESET', 'PROVISIONING_RETRY'],
  ['UNKNOWN', 'ECONNRESET', 'PREPARATION_CLEANUP_UNCERTAIN'],
  ['LOCAL_RUNTIME_GROUP_STOPPED', 'UNRECOGNIZED', 'PROVISIONING_FAILED'],
] as const)(
  'preserves typed output failure through %s cleanup for code %s',
  async (cleanup, code, reasonCode) => {
    await db.prisma.project.updateMany({ data: { startupScriptCommand: 'controlled-script' } });
    const child = Object.assign(new EventEmitter(), {
      pid: 12_345,
      exitCode: null,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    scriptProcess.spawn.mockReturnValue(unsafeCoerce<ChildProcess>(child));
    const groups = await vi.importActual<typeof import('@/backend/lib/owned-process-group')>(
      '@/backend/lib/owned-process-group'
    );
    const stopped = vi.spyOn(groups, 'stopOwnedProcessGroup').mockResolvedValue(cleanup);
    const output = vi
      .spyOn(h.workspace.eventWorkspaceInitService, 'appendOutput')
      .mockRejectedValueOnce(
        Object.assign(new Error('Persistence transport failed'), { code, retryAfterMs: 90_000 })
      );
    const { launchEventRun } = await vi.importActual<
      typeof import('@/backend/orchestration/event-run-launch.orchestrator')
    >('@/backend/orchestration/event-run-launch.orchestrator');
    const before = Date.now();
    const task = launchEventRun(h.claim, new AbortController().signal);
    tasks.push(task);
    await vi.waitFor(async () =>
      expect(
        await db.prisma.workspace.findUnique({ where: { id: h.claim.reservedWorkspaceId } })
      ).toMatchObject({ initScriptPid: 12_345 })
    );
    child.stdout.write('failure boundary');
    await task;
    expect(output).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    const run = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
    expect(run).toMatchObject({
      reasonCode,
      attemptCount: 1,
      reservedWorkspaceId: h.claim.reservedWorkspaceId,
      reservedSessionId: h.claim.reservedSessionId,
    });
    if (reasonCode === 'PROVISIONING_RETRY') {
      expect(run.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 90_000);
    } else {
      expect(run.nextAttemptAt).toBeNull();
    }
    expect(providers.size).toBe(0);
  }
);

it('retains existing setup PID and output when cleanup is unknown and recovery does not rerun scripts', async () => {
  await db.prisma.project.updateMany({
    data: { startupScriptCommand: 'controlled-unknown-script' },
  });
  const scripts = await vi.importActual<typeof import('@/backend/services/run-script')>(
    '@/backend/services/run-script'
  );
  const script = vi
    .spyOn(scripts.startupScriptService, 'runEventStartupScript')
    .mockImplementation(async (_workspace, _project, options) => {
      await options.setPid(12_345);
      await options.appendOutput('Retained setup evidence');
      throw new scripts.EventSetupError('FAILED', 'UNKNOWN', 'Cleanup uncertain');
    });
  const { launchEventRun } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  await launchEventRun(h.claim, new AbortController().signal);
  expect(
    await db.prisma.workspace.findUnique({ where: { id: h.claim.reservedWorkspaceId } })
  ).toMatchObject({
    initScriptPid: 12_345,
    initOutput: 'Retained setup evidence',
    status: 'PROVISIONING',
  });
  expect(await h.owner.eventRunLaunch.recover([], 4)).toEqual([]);
  expect(script).toHaveBeenCalledOnce();
  expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
    status: 'RUNNING',
    launchPhase: 'NEEDS_ATTENTION',
  });
});

it('honors typed transient Retry-After from setup without resetting identity or budget', async () => {
  vi.mocked(h.workspace.gitOpsService.prepareWorktreeCreation).mockRejectedValueOnce(
    Object.assign(new Error('Transient transport failure'), {
      code: 'ECONNRESET',
      retryAfterMs: 90_000,
    })
  );
  const { launchEventRun } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-launch.orchestrator')
  >('@/backend/orchestration/event-run-launch.orchestrator');
  const before = Date.now();
  await launchEventRun(h.claim, new AbortController().signal);
  const run = await db.prisma.agentRun.findUniqueOrThrow({ where: { id: h.claim.runId } });
  expect(run).toMatchObject({
    status: 'RUNNING',
    attemptCount: 1,
    reasonCode: 'PROVISIONING_RETRY',
    reservedWorkspaceId: h.claim.reservedWorkspaceId,
    reservedSessionId: h.claim.reservedSessionId,
    initialMessageId: h.claim.initialMessageId,
  });
  expect(h.workspace.gitOpsService.prepareWorktreeCreation).toHaveBeenCalledOnce();
  expect(
    await db.prisma.agentInitialDelivery.findUnique({ where: { runId: h.claim.runId } })
  ).toMatchObject({ messageId: h.attempt.messageId, sendAttemptId: h.attempt.sendAttemptId });
  expect(run.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 90_000);
  expect(await db.prisma.workspace.count()).toBe(1);
  expect(await db.prisma.agentSession.count()).toBe(1);
  expect(providers.size).toBe(0);
});

it.each(['stall', 'reject'] as const)(
  'bounds failed-claim shutdown when the first disposition will %s and accounts for the next claim',
  async (mode) => {
    const other = await createEventDeliveryFixture(db, 'CLAUDE', false, true);
    const gate = boundary();
    vi.spyOn(h.owner.eventRunLaunch, 'read').mockRejectedValue(
      new Error('Initial owner read failed')
    );
    const dispose = h.owner.eventRunLaunch.dispose;
    const dispositions = vi
      .spyOn(h.owner.eventRunLaunch, 'dispose')
      .mockImplementation(async (...args) => {
        if (args[0].runId === h.claim.runId) {
          if (mode === 'reject') {
            throw new Error('Disposition unavailable');
          }
          await gate.wait();
        }
        return dispose(...args);
      });
    const { createEventRunConsumer } = await vi.importActual<
      typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
    >('@/backend/orchestration/event-run-consumer.orchestrator');
    const consumer = createEventRunConsumer();
    await consumer.consumeClaim(h.claim, new AbortController().signal);
    await consumer.consumeClaim(other.claim, new AbortController().signal);
    await consumer.drain();
    vi.useFakeTimers();
    let stopped = false;
    let stopError: unknown;
    const stopping = consumer.stop().then(
      () => {
        stopped = true;
      },
      (error) => {
        stopError = error;
      }
    );
    try {
      await vi.waitFor(() => expect(dispositions).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(5000);
      expect(stopped).toBe(true);
      expect(stopError).toBeUndefined();
      gate.release();
      await consumer.drain();
      expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
        status: 'RUNNING',
        launchPhase: 'PROVISIONING',
      });
      expect(
        await db.prisma.agentRun.findUnique({ where: { id: other.claim.runId } })
      ).toMatchObject({
        status: 'RUNNING',
        launchPhase: 'NEEDS_ATTENTION',
        reasonCode: 'PREPARATION_CLEANUP_UNCERTAIN',
      });
      expect(providers.size).toBe(0);
    } finally {
      gate.release();
      vi.useRealTimers();
      await stopping;
      await consumer.drain();
    }
  }
);

it('bounds shutdown behind a stalled durable handoff read and fences all later writes', async () => {
  const gate = boundary();
  const read = h.owner.eventRunLaunch.read;
  vi.spyOn(h.owner.eventRunLaunch, 'read').mockImplementationOnce(async (claim) => {
    const result = await read(claim);
    await gate.wait();
    return result;
  });
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  const consumer = createEventRunConsumer();
  await consumer.consumeClaim(h.claim, new AbortController().signal);
  await gate.entered;
  vi.useFakeTimers();
  const stopping = consumer.stop();
  try {
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    const disposition = vi.spyOn(h.owner.eventRunLaunch, 'dispose');
    gate.release();
    await consumer.drain();
    expect(disposition).not.toHaveBeenCalled();
    expect(await db.prisma.workspace.count()).toBe(0);
  } finally {
    gate.release();
    vi.useRealTimers();
    await stopping;
    await consumer.drain();
  }
});

it('directly joins pending Git before allowing shutdown to finish', async () => {
  const gate = boundary();
  const create = h.workspace.gitOpsService.createWorktree;
  vi.mocked(create).mockImplementationOnce(async (project, name) => {
    const worktreePath = join(project.worktreeBasePath, name);
    await mkdir(worktreePath, { recursive: true });
    await gate.wait();
    return { worktreePath, branchName: 'owned' };
  });
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  const consumer = createEventRunConsumer();
  await consumer.consumeClaim(h.claim, new AbortController().signal);
  await gate.entered;
  vi.useFakeTimers();
  let stopped = false;
  const stopping = consumer.stop().then(() => {
    stopped = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(6000);
    expect(stopped).toBe(false);
  } finally {
    gate.release();
    vi.useRealTimers();
    await stopping;
    await consumer.drain();
  }
  expect(providers.size).toBe(0);
});

it.each(['before Git', 'after Git'] as const)(
  'bounds initializer durable reads %s without losing physical ownership',
  async (position) => {
    const gate = boundary();
    const read = h.workspace.eventWorkspaceInitService.read;
    let reads = 0;
    vi.spyOn(h.workspace.eventWorkspaceInitService, 'read').mockImplementation(async (...args) => {
      const result = await read(...args);
      reads++;
      if (reads === (position === 'before Git' ? 1 : 4)) {
        await gate.wait();
      }
      return result;
    });
    const { createEventRunConsumer } = await vi.importActual<
      typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
    >('@/backend/orchestration/event-run-consumer.orchestrator');
    const consumer = createEventRunConsumer();
    await consumer.consumeClaim(h.claim, new AbortController().signal);
    await gate.entered;
    expect(h.workspace.gitOpsService.createWorktree).toHaveBeenCalledTimes(
      position === 'before Git' ? 0 : 1
    );
    vi.useFakeTimers();
    let stopped = false;
    const stopping = consumer.stop().then(() => {
      stopped = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(stopped).toBe(true);
      const finish = vi.spyOn(h.workspace.eventWorkspaceInitService, 'finish');
      const disposition = vi.spyOn(h.owner.eventRunLaunch, 'dispose');
      gate.release();
      await consumer.drain();
      expect(finish).not.toHaveBeenCalled();
      expect(disposition).not.toHaveBeenCalled();
      expect(providers.size).toBe(0);
      expect(h.workspace.gitOpsService.createWorktree).toHaveBeenCalledTimes(
        position === 'before Git' ? 0 : 1
      );
    } finally {
      gate.release();
      vi.useRealTimers();
      await stopping;
      await consumer.drain();
    }
  }
);

it('interrupts a stalled prompt as SHUTDOWN with uncertainty and no ordinary lifecycle finalization', async () => {
  const { createEventRunConsumer } = await vi.importActual<
    typeof import('@/backend/orchestration/event-run-consumer.orchestrator')
  >('@/backend/orchestration/event-run-consumer.orchestrator');
  const consumer = createEventRunConsumer();
  await consumer.consumeClaim(h.claim, new AbortController().signal);
  await vi.waitFor(() => expect(providers.size).toBe(1));
  const provider = providers.get(h.attempt.sessionId)!;
  await provider.called;
  await consumer.stop();
  const stopped = await h.read();
  expect(stopped).toMatchObject({
    state: 'AMBIGUOUS',
    evidence: { stop: { cause: 'SHUTDOWN', status: 'UNKNOWN' } },
  });
  expect(await db.prisma.agentRun.findUnique({ where: { id: h.claim.runId } })).toMatchObject({
    status: 'RUNNING',
    launchPhase: 'NEEDS_ATTENTION',
  });
  // A late terminal response cannot start another owner observation after task closure.
  const outcome = vi.spyOn(h.owner.agentInitialDelivery, 'outcome');
  const ambiguity = vi.spyOn(h.owner.agentInitialDelivery, 'ambiguous');
  provider.response.resolve({ stopReason: 'end_turn' });
  await consumer.drain();
  expect(outcome).not.toHaveBeenCalled();
  expect(ambiguity).not.toHaveBeenCalled();
}, 20_000);
