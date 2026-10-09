import { beforeEach, expect, it, vi } from 'vitest';
import { SessionStartupCancelledError } from '@/backend/services/session/service/lifecycle/session-lifecycle-gate';
import {
  createDeferred,
  createLifecycleHarness,
} from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';

beforeEach(() => vi.clearAllMocks());
function guardHarness() {
  const harness = createLifecycleHarness();
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
  h.runtimeManager.getOrCreateClient.mockReturnValueOnce(pending.promise);
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
