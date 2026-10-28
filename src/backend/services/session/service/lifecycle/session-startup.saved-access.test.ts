import { expect, it, vi } from 'vitest';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { configOptions } from './session-config-authority.test-helpers';
import { createDeferred, createLifecycleHarness } from './session-lifecycle.test-helpers';
import { SessionConfigService } from './session.config.service';

it('keeps Claude native access authoritative over the legacy non-interactive bypass preset', async () => {
  const h = createLifecycleHarness({ provider: 'CLAUDE' });
  await h.service.startSession(h.session.id, {
    initialPrompt: '',
    startupModePreset: 'non_interactive',
  });
  expect(h.sessionConfigService.applyStartupModePreset).not.toHaveBeenCalled();
  expect(h.sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalledOnce();
});

it.each(['start', 'acquire'] as const)(
  'enforces native access before %s startup completion and notification recovery',
  async (path) => {
    const h = createLifecycleHarness();
    let applied = false;
    h.sessionConfigService.applyConfiguredPermissionPreset.mockImplementation(() => {
      applied = true;
      return Promise.resolve();
    });
    h.sessionConfigService.completeStartupConfiguration.mockImplementation(async (_id, params) => {
      expect(applied).toBe(true);
      await params.beforeComplete();
      params.assertCurrent();
      params.complete();
    });
    h.notificationDeliveryService.recoverPending = vi.fn(() => {
      expect(applied).toBe(true);
      return Promise.resolve({ dispatchableCount: 0 });
    });
    if (path === 'start') {
      await h.service.startSession(h.session.id, { initialPrompt: '' });
    } else {
      await h.service.getOrCreateSessionClient(h.session.id);
    }
    expect(h.sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalledOnce();
  }
);

it('stops a shared non-review candidate whose native access enforcement fails', async () => {
  const h = createLifecycleHarness();
  const applying = createDeferred<void>();
  h.runtimeManager.runClientCreationOperation.mockImplementation((_id, _purpose, operation) =>
    operation({ isOnlyOperation: () => false })
  );
  h.runtimeManager.getOrCreateClient.mockImplementation((_id, _options, handlers) => {
    handlers.onRuntimeCreated?.(h.handle);
    h.runtimeManager.getClient.mockReturnValue(h.handle);
    return Promise.resolve(h.handle);
  });
  h.sessionConfigService.applyConfiguredPermissionPreset.mockReturnValueOnce(applying.promise);
  const started = h.service
    .startSession(h.session.id, { initialPrompt: '' })
    .catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(h.sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalled()
  );
  await h.service.getOrCreateSessionClient(h.session.id);
  applying.reject(new Error('access rejected'));
  expect(await started).toEqual(expect.objectContaining({ message: 'access rejected' }));
  expect(h.runtimeManager.stopClient).toHaveBeenCalledWith(h.session.id);
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  expect(h.sessionConfigService.persistAcpConfigSnapshot).not.toHaveBeenCalled();
});

it('does not stop or clear a replacement after failed candidate cleanup finishes late', async () => {
  const h = createLifecycleHarness();
  const replacement = createLifecycleHarness().handle;
  const stopping = createDeferred<void>();
  h.runtimeManager.getOrCreateClient.mockImplementation((_id, _options, handlers) => {
    handlers.onRuntimeCreated?.(h.handle);
    h.runtimeManager.getClient.mockReturnValue(h.handle);
    return Promise.resolve(h.handle);
  });
  h.sessionConfigService.applyConfiguredPermissionPreset.mockRejectedValueOnce(
    new Error('access rejected')
  );
  h.runtimeManager.stopClient.mockReturnValueOnce(stopping.promise);
  const outcome = h.service.getOrCreateSessionClient(h.session.id).catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.runtimeManager.stopClient).toHaveBeenCalledOnce());
  h.runtimeManager.getClient.mockReturnValue(replacement);
  const snapshots = h.sessionDomainService.setRuntimeSnapshot.mock.calls.length;
  stopping.resolve();
  expect(await outcome).toEqual(expect.objectContaining({ message: 'access rejected' }));
  expect(h.runtimeManager.stopClient).toHaveBeenCalledOnce();
  expect(h.acpEventProcessor.clearSessionState).not.toHaveBeenCalled();
  expect(h.sessionDomainService.setRuntimeSnapshot.mock.calls).toHaveLength(snapshots);
});

it('fails startup readiness and prevents dispatch when final configuration persistence exhausts its retries', async () => {
  const h = createLifecycleHarness({ providerSessionId: 'thread' });
  h.handle.configOptions = configOptions('first');
  h.runtimeManager.getOrCreateClient.mockImplementation((_id, _options, handlers) => {
    handlers.onRuntimeCreated?.(h.handle);
    h.runtimeManager.getClient.mockReturnValue(h.handle);
    return Promise.resolve(h.handle);
  });
  let snapshotAttempts = 0;
  h.repository.updateSession.mockImplementation((_id, update, assertCurrent) => {
    assertCurrent?.();
    if (
      update.providerMetadata &&
      typeof update.providerMetadata === 'object' &&
      Object.hasOwn(update.providerMetadata, 'acpConfigSnapshot')
    ) {
      snapshotAttempts++;
      throw new Error('snapshot storage unavailable');
    }
    return Promise.resolve(h.session);
  });
  const config = new SessionConfigService({
    repository: unsafeCoerce(h.repository),
    runtimeManager: unsafeCoerce(h.runtimeManager),
    sessionDomainService: unsafeCoerce(h.sessionDomainService),
    codexModelCatalogService: { getModels: async () => [] },
  });
  h.sessionConfigService.completeStartupConfiguration.mockImplementation(
    config.completeStartupConfiguration.bind(config)
  );
  await expect(h.service.startSession(h.session.id, { initialPrompt: 'Do work' })).rejects.toThrow(
    'snapshot storage unavailable'
  );
  expect(snapshotAttempts).toBe(2);
  expect(h.runtimeManager.stopClient).toHaveBeenCalledWith(h.session.id);
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  expect(h.tryDispatchNextMessage).not.toHaveBeenCalled();
});
