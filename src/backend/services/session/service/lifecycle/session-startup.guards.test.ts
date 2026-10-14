import { beforeEach, expect, it, vi } from 'vitest';
import { SessionStartupCancelledError } from '@/backend/services/session/service/lifecycle/session-lifecycle-gate';
import {
  createDeferred,
  createLifecycleHarness,
  createPendingWorkspaceNotification,
} from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';
import { workspaceNotificationService } from '@/backend/services/workspace';

beforeEach(() => vi.clearAllMocks());
function guardHarness() {
  const harness = createLifecycleHarness();
  harness.runtimeManager.getOrCreateClient.mockImplementation((_id, _options, handlers) => {
    handlers.onRuntimeCreated?.(harness.handle);
    harness.runtimeManager.getClient.mockReturnValue(harness.handle);
    return Promise.resolve(harness.handle);
  });
  let valid = true;
  const assertCurrent = () =>
    valid ? Promise.resolve() : Promise.reject(new SessionStartupCancelledError());
  return {
    ...harness,
    assertCurrent,
    invalidate: () => {
      valid = false;
    },
  };
}
it('does not create a provider after monitoring changes during context loading', async () => {
  const h = guardHarness();
  const context = await h.contextService.load('session-1', h.session);
  const pending = createDeferred<typeof context>();
  vi.spyOn(h.contextService, 'load').mockReturnValueOnce(pending.promise);
  const started = h.service
    .startSession('session-1', { initialPrompt: '', assertCurrent: h.assertCurrent })
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.contextService.load).toHaveBeenCalled());
  h.invalidate();
  pending.resolve(context);
  expect(await started).toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  expect(h.sessionConfigService.persistAcpConfigSnapshot).not.toHaveBeenCalled();
});
it('rechecks monitoring after environment resolution before spawning the provider', async () => {
  const h = guardHarness();
  h.acpEnvironment.getMcpServers.mockImplementation(() => {
    h.invalidate();
    return [];
  });
  await expect(
    h.service.startSession('session-1', { initialPrompt: '', assertCurrent: h.assertCurrent })
  ).rejects.toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
});
it('stops a candidate created after the monitoring revision changed without persisting identity', async () => {
  const h = guardHarness();
  const pending = createDeferred<typeof h.handle>();
  h.runtimeManager.getOrCreateClient.mockImplementationOnce((_id, _options, handlers) =>
    pending.promise.then((handle) => {
      handlers.onRuntimeCreated?.(handle);
      h.runtimeManager.getClient.mockReturnValue(handle);
      return handle;
    })
  );
  const started = h.service
    .startSession('session-1', { initialPrompt: '', assertCurrent: h.assertCurrent })
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.runtimeManager.getOrCreateClient).toHaveBeenCalled());
  h.invalidate();
  pending.resolve(h.handle);
  expect(await started).toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
  expect(h.sessionConfigService.persistAcpConfigSnapshot).not.toHaveBeenCalled();
  expect(h.repository.updateSession).not.toHaveBeenCalledWith('session-1', { status: 'RUNNING' });
});
it('guards the provider identity callback before its durable write', async () => {
  const h = guardHarness();
  h.runtimeManager.getOrCreateClient.mockImplementation(async (_id, _options, handlers) => {
    h.invalidate();
    await handlers.onSessionId?.('session-1', 'new-provider-id');
    return h.handle;
  });
  await expect(
    h.service.startSession('session-1', { initialPrompt: '', assertCurrent: h.assertCurrent })
  ).rejects.toBeInstanceOf(SessionStartupCancelledError);
  expect(h.repository.updateSession).not.toHaveBeenCalledWith('session-1', {
    providerSessionId: 'new-provider-id',
  });
});
it('cleans up a guarded startup cancelled during the final running write', async () => {
  const h = guardHarness();
  const pending = createDeferred<typeof h.session>();
  h.repository.updateSession.mockReturnValueOnce(pending.promise);
  const started = h.service
    .startSession('session-1', { initialPrompt: '', assertCurrent: h.assertCurrent })
    .catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(h.repository.updateSession).toHaveBeenCalledWith('session-1', { status: 'RUNNING' })
  );
  h.invalidate();
  pending.resolve(h.session);
  expect(await started).toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  expect(h.repository.updateSessionIfStatus).toHaveBeenCalledWith('session-1', { status: 'IDLE' }, [
    'RUNNING',
  ]);
});
it('stops guarded startup after permission application before any initial turn', async () => {
  const h = guardHarness();
  const pending = createDeferred<void>();
  h.sessionConfigService.applyConfiguredPermissionPreset.mockReturnValueOnce(pending.promise);
  const started = h.service
    .startSession('session-1', { initialPrompt: 'would send', assertCurrent: h.assertCurrent })
    .catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(h.sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalled()
  );
  h.invalidate();
  pending.resolve(undefined);
  expect(await started).toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.stopAndQuiesce).toHaveBeenCalledWith('session-1');
  expect(h.repository.updateSessionIfStatus).toHaveBeenCalledWith('session-1', { status: 'IDLE' }, [
    'RUNNING',
  ]);
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
});
it('cancels after reasoning configuration before persisting the provider snapshot', async () => {
  const h = guardHarness();
  const pending = createDeferred<void>();
  h.sessionConfigService.applyConfiguredReasoningEffort.mockReturnValueOnce(pending.promise);
  const started = h.service
    .startSession('session-1', { initialPrompt: '', assertCurrent: h.assertCurrent })
    .catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(h.sessionConfigService.applyConfiguredReasoningEffort).toHaveBeenCalled()
  );
  h.invalidate();
  pending.resolve(undefined);
  expect(await started).toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.stopClient).toHaveBeenCalledWith('session-1');
  expect(h.sessionConfigService.persistAcpConfigSnapshot).not.toHaveBeenCalled();
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
});

it('does not stop a concurrent runtime reused during guarded acquisition', async () => {
  const h = guardHarness();
  h.runtimeManager.getClient.mockReturnValueOnce(undefined).mockReturnValue(h.handle);
  h.sessionConfigService.applyConfiguredPermissionPreset.mockImplementation(() => {
    h.invalidate();
    return Promise.resolve();
  });
  await expect(
    h.service.startSession('session-1', {
      initialPrompt: '',
      assertCurrent: h.assertCurrent,
    })
  ).rejects.toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.getOrCreateClient).not.toHaveBeenCalled();
  expect(h.runtimeManager.stopAndQuiesce).not.toHaveBeenCalled();
  expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
});

it('retains a runtime after a valid ordinary startup has reused it and finished', async () => {
  const h = guardHarness();
  const pending = createDeferred<void>();
  h.sessionConfigService.applyConfiguredPermissionPreset.mockReturnValueOnce(pending.promise);
  const guarded = h.service
    .startSession('session-1', {
      initialPrompt: '',
      assertCurrent: h.assertCurrent,
    })
    .catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(h.sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalled()
  );
  const reused = await h.service.getOrCreateSessionClient('session-1');
  expect(reused).toBe(h.handle);
  h.invalidate();
  pending.resolve(undefined);
  expect(await guarded).toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.stopAndQuiesce).not.toHaveBeenCalled();
  expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
});

it('passes the destination fence into notification recovery before cards are appended', async () => {
  const h = guardHarness();
  vi.spyOn(workspaceNotificationService, 'listPendingForDelivery').mockImplementation(() => {
    h.invalidate();
    return Promise.resolve([createPendingWorkspaceNotification()]);
  });
  await expect(
    h.service.startSession('session-1', {
      initialPrompt: '',
      assertCurrent: h.assertCurrent,
    })
  ).rejects.toBeInstanceOf(SessionStartupCancelledError);
  expect(h.sessionDomainService.enqueue).not.toHaveBeenCalled();
  expect(h.sessionDomainService.appendClaudeEvent).not.toHaveBeenCalled();
});
it('keeps established runtime context when its original startup is cancelled during configuration', async () => {
  const h = guardHarness();
  const pending = createDeferred<void>();
  h.sessionConfigService.applyConfiguredReasoningEffort.mockReturnValueOnce(pending.promise);
  const guarded = h.service
    .startSession('session-1', {
      initialPrompt: '',
      assertCurrent: h.assertCurrent,
    })
    .catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(h.sessionConfigService.applyConfiguredReasoningEffort).toHaveBeenCalled()
  );
  expect(await h.service.getOrCreateSessionClient('session-1')).toBe(h.handle);
  h.invalidate();
  pending.resolve(undefined);
  expect(await guarded).toBeInstanceOf(SessionStartupCancelledError);
  expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
  expect(h.acpEventProcessor.clearSessionState).not.toHaveBeenCalled();
  expect(h.sessionDomainService.setRuntimeSnapshot).toHaveBeenLastCalledWith(
    'session-1',
    expect.objectContaining({ phase: 'idle', processState: 'alive' })
  );
});
