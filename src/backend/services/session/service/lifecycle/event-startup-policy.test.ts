import { expect, it, vi } from 'vitest';
import type { InitialDeliveryFence } from '@/shared/event-agent-delivery';
import { EventSessionAuthority } from './event-session-authority';
import { guardEventStartup } from './event-session-startup';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';
import { prepareSessionStartup } from './session-startup-preparation';
const attempt = {
  runId: 'run',
  sessionId: 'session-1',
  messageId: 'message',
  sendAttemptId: 'send',
  workerGeneration: 1,
  attemptGeneration: 1,
};
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
it('rejects an event permit when no authority is composed while preserving ordinary startup', async () => {
  await expect(
    guardEventStartup(undefined, 'session-1', { eventInitial: { attempt, execution } })
  ).rejects.toThrow();
  await expect(guardEventStartup(undefined, 'ordinary', {})).resolves.toEqual({});
});
it('caches immutable startup ownership classification but reads each mutable event fence', async () => {
  const ordinaryLookup = vi.fn(async () => null);
  const ordinary = new EventSessionAuthority(ordinaryLookup);
  const guarded = await guardEventStartup(ordinary, 'ordinary', {
    assertCurrent: vi.fn(async () => undefined),
  });
  await guarded.assertCurrent?.();
  await guarded.assertCurrent?.();
  expect(ordinaryLookup).toHaveBeenCalledOnce();
  const lookup = vi.fn(async () => ({ runId: 'run', execution }));
  const authority = new EventSessionAuthority(lookup);
  const state: InitialDeliveryFence = { attempt, execution, state: 'PENDING', evidence: null };
  const readFence = vi.fn(async () => state);
  authority.configure({
    readFence,
    beforeSend: async () => undefined,
    outcome: async () => undefined,
    ambiguous: async () => undefined,
    stop: async () => undefined,
  });
  await authority.runInitial(attempt, async (permit) => {
    const event = await guardEventStartup(authority, 'session-1', {
      eventInitial: permit,
      assertCurrent: async () => undefined,
    });
    const reads = readFence.mock.calls.length;
    await event.assertCurrent?.();
    state.state = 'AMBIGUOUS';
    await expect(event.assertCurrent?.()).rejects.toThrow();
    expect(readFence.mock.calls.length).toBe(reads + 2);
  });
});
it('does not opt an ordinary startup into cleanup merely by installing an authorization guard', async () => {
  const authority = new EventSessionAuthority(async () => null);
  const h = createLifecycleHarness({ eventAuthority: authority });
  h.sendSessionMessage.mockRejectedValue(new Error('send failed'));
  await expect(h.service.startSession(h.session.id, { initialPrompt: 'hello' })).rejects.toThrow(
    'send failed'
  );
  expect(h.runtimeManager.stopAndQuiesce).not.toHaveBeenCalled();
});
it('rejects a changed frozen account on the preparation reread before provider configuration', async () => {
  const h = createLifecycleHarness({ provider: 'CODEX', session: { codexAccountId: 'changed' } });
  await expect(
    prepareSessionStartup(
      h.session.id,
      h.handle,
      { eventExecution: { ...execution, provider: 'CODEX', codexAccountId: 'frozen' } },
      {
        repository: h.repository,
        config: h.sessionConfigService,
        assertCurrent: () => undefined,
        checkCurrent: async () => undefined,
        isRequestFailure: () => false,
      }
    )
  ).rejects.toThrow();
  expect(h.sessionConfigService.applyStartupModel).not.toHaveBeenCalled();
});
it('routes the harness authority into actual runtime-exit coordination', async () => {
  const authority = new EventSessionAuthority(async () => null);
  const observed = vi.spyOn(authority, 'observeUnexpectedExit').mockResolvedValue();
  const h = createLifecycleHarness({ eventAuthority: authority });
  await h.service.getOrCreateSessionClient(h.session.id);
  const handlers = h.runtimeManager.getOrCreateClient.mock.calls[0]![2];
  await handlers.onRuntimeExit?.({
    sessionId: h.session.id,
    incarnationId: 'runtime',
    purpose: 'active',
    managed: false,
    exitCode: 1,
  });
  expect(observed).toHaveBeenCalledWith(h.session.id, 'runtime');
});

it('continues process-exit cleanup when durable unexpected-exit observation fails', async () => {
  const authority = new EventSessionAuthority(async () => null);
  vi.spyOn(authority, 'observeUnexpectedExit').mockRejectedValue(new Error('database unavailable'));
  const h = createLifecycleHarness({ eventAuthority: authority });
  await h.service.getOrCreateSessionClient(h.session.id);
  const handlers = h.runtimeManager.getOrCreateClient.mock.calls[0]![2];
  await handlers.onRuntimeExit?.({
    sessionId: h.session.id,
    incarnationId: 'runtime',
    purpose: 'active',
    managed: false,
    exitCode: 1,
  });
  expect(h.sessionDomainService.markProcessExit).toHaveBeenCalledWith(h.session.id, 1);
  expect(h.acpEventProcessor.clearSessionState).toHaveBeenCalledWith(h.session.id);
});
