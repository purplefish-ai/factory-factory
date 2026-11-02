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
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import type { InitialDeliveryFence } from '@/shared/event-agent-delivery';
import type { WorkspaceInitGuard } from '@/shared/workspace-init-retry';
import { EventSessionAuthority } from './event-session-authority';

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
  expect(await outcome).toBeInstanceOf(Error);
  expect(mockPrompt).not.toHaveBeenCalled();
  read.resolve();
  await initial;
});
