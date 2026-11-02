import { expect, it } from 'vitest';
import {
  createManagerTestHarness,
  mockPrompt,
  setupSuccessfulSpawn,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-harness';
import {
  createDeferred,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  exitChildAfterSigterm,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import type { InitialDeliveryFence } from '@/shared/event-agent-delivery';
import type { WorkspaceInitGuard } from '@/shared/workspace-init-retry';
import { EventSessionAuthority } from './event-session-authority';
import { EventSessionFenceError } from './event-session-fence-error';

it('rejects generic retry dispatch after real initial admission begins during runtime configuration wait', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const handle = await manager.getOrCreateClient(
    'session',
    defaultOptions(),
    defaultHandlers(),
    defaultContext()
  );
  const execution = {
    version: 1 as const,
    provider: 'CLAUDE' as const,
    model: 'sonnet',
    reasoningEffort: null,
    codexAccountId: null,
    startupModePreset: 'non_interactive' as const,
    accessMode: 'bypassPermissions',
    planModeEnabled: false as const,
  };
  const attempt = {
    runId: 'run',
    sessionId: 'reserved',
    workerGeneration: 1,
    attemptGeneration: 1,
    messageId: 'initial',
    sendAttemptId: 'send',
  };
  const fence: InitialDeliveryFence = { attempt, execution, state: 'FINISHED', evidence: null };
  const read = createDeferred<void>();
  let hold = false;
  const authority = new EventSessionAuthority(async () => ({ runId: 'run', execution }));
  authority.configure({
    readFence: async () => {
      if (hold) {
        await read.promise;
      }
      return fence;
    },
    beforeSend: async () => undefined,
    outcome: async () => undefined,
    ambiguous: async () => undefined,
    stop: async () => undefined,
  });
  const context = {
    projectId: 'project',
    workspaceId: 'workspace',
    initialMessageId: 'initial',
    preparation: null,
    fence,
  };
  const guard: WorkspaceInitGuard = { context, ...authority.createWorkspaceRetryGuard(context) };
  await guard.check();
  const config = handle.beginConfiguration();
  const send = manager.sendPrompt('session', [], undefined, undefined, guard);
  const outcome = send.then(
    () => null,
    (error: unknown) => error
  );
  hold = true;
  const initial = authority.runInitial(attempt, async () => undefined).catch(() => undefined);
  config.complete();
  expect(await outcome).toBeInstanceOf(EventSessionFenceError);
  expect(mockPrompt).not.toHaveBeenCalled();
  read.resolve();
  await initial;
});

it.each(['replacement', 'stop', 'configuration', 'pending update', 'current'] as const)(
  'rechecks captured prompt runtime after caller authority wait: %s',
  async (change) => {
    const { manager } = createManagerTestHarness();
    const child = setupSuccessfulSpawn();
    exitChildAfterSigterm(child);
    const handle = await manager.getOrCreateClient(
      'session',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
    const before = mockPrompt.mock.calls.length;
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const sending = manager
      .sendPrompt('session', [], undefined, undefined, {
        check: () => {
          entered.resolve();
          return released.promise;
        },
        assertCurrent: () => undefined,
      })
      .catch((error: unknown) => error);
    await entered.promise;
    let complete: () => void = () => undefined;
    if (change === 'replacement' || change === 'stop') {
      await manager.stopClient('session');
      if (change === 'replacement') {
        exitChildAfterSigterm(setupSuccessfulSpawn());
        await manager.getOrCreateClient(
          'session',
          defaultOptions(),
          defaultHandlers(),
          defaultContext()
        );
      }
    } else if (change === 'configuration') {
      const config = handle.beginConfiguration();
      complete = () => config.complete();
    } else if (change === 'pending update') {
      const update = createDeferred<void>();
      handle.trackPendingConfigUpdate(update.promise);
      complete = () => update.resolve();
    }
    released.resolve();
    const outcome = await sending;
    complete();
    await manager.stopAllClients(10);
    if (change === 'current') {
      expect(outcome).toEqual({ stopReason: 'end_turn' });
      expect(mockPrompt.mock.calls.length).toBe(before + 1);
    } else {
      expect(mockPrompt.mock.calls.length).toBe(before);
      expect(outcome).toBeInstanceOf(Error);
    }
  }
);

it('starts an ordinary ready prompt without adding a microtask before the provider call', async () => {
  const { manager } = createManagerTestHarness();
  exitChildAfterSigterm(setupSuccessfulSpawn());
  await manager.getOrCreateClient('session', defaultOptions(), defaultHandlers(), defaultContext());
  mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  const before = mockPrompt.mock.calls.length;
  const sending = manager.sendPrompt('session', []);
  const immediate = mockPrompt.mock.calls.length;
  await sending;
  await manager.stopAllClients(10);
  expect(immediate).toBe(before + 1);
});
