import { afterEach, expect, it, vi } from 'vitest';
import { AcpClientFactory } from '@/backend/services/session/service/acp/acp-client-factory';
import { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import {
  exitChildWithCode,
  type MockChildProcess,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { gate } from './session-config-authority.test-helpers';
import { setupStartupConfig } from './session-startup-config.test-helpers';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));
afterEach(() => vi.restoreAllMocks());

it('keeps a coalesced borrower shared after the real manager creator has completed', async () => {
  const h = setupStartupConfig();
  const manager = new AcpRuntimeManager();
  const factoryGate = gate();
  const factory = vi
    .spyOn(AcpClientFactory.prototype, 'createClient')
    .mockImplementationOnce(async () => {
      await factoryGate.wait();
      return h.handle;
    });
  exitChildWithCode(unsafeCoerce<MockChildProcess>(h.handle.child));
  for (const name of [
    'getClient',
    'getPendingClient',
    'runClientCreationOperation',
    'isStopInProgress',
    'stopClient',
    'isSessionRunning',
    'isSessionWorking',
    'hasClientCreationOperation',
    'isBrowseOnlySession',
    'getSubagentBrowseCapability',
    'stopAndQuiesce',
  ] as const) {
    h.runtimeManager[name].mockImplementation(unsafeCoerce(manager[name].bind(manager)));
  }
  let createdCallbacks = 0;
  h.runtimeManager.getOrCreateClient.mockImplementation((id, options, handlers, context) =>
    manager.getOrCreateClient(
      id,
      options,
      {
        ...handlers,
        onRuntimeCreated: (handle) => {
          createdCallbacks++;
          handlers.onRuntimeCreated?.(handle);
        },
      },
      context
    )
  );
  const held = gate();
  const finalize = h.config.completeStartupConfiguration.bind(h.config);
  let finalizers = 0;
  h.sessionConfigService.completeStartupConfiguration.mockImplementation((id, params) => {
    const number = ++finalizers;
    return finalize(
      id,
      number === 2
        ? {
            ...params,
            beforeComplete: async () => {
              await held.wait();
              await params.beforeComplete();
            },
          }
        : params
    );
  });
  let cancelled = false;
  const cancellation = new Error('borrower request cancelled');
  const creator = h.service.getOrCreateSessionClient(h.session.id);
  const borrower = h.service
    .getOrCreateSessionClient(h.session.id, {
      assertCurrent: () => (cancelled ? Promise.reject(cancellation) : Promise.resolve()),
    })
    .catch((error) => error);
  await factoryGate.started;
  factoryGate.release();
  await held.started;
  expect(await creator).toBe(h.handle);
  expect(createdCallbacks).toBe(1);
  expect(factory).toHaveBeenCalledOnce();
  expect(h.handle.configurationReady).toBeUndefined();
  expect(manager.hasClientCreationOperation(h.session.id)).toBe(true);
  cancelled = true;
  held.release();
  expect(await borrower).toBe(cancellation);
  expect(finalizers).toBe(2);
  expect(h.fail).not.toHaveBeenCalled();
  expect(h.runtimeManager.stopClient).not.toHaveBeenCalled();
  expect(h.handle.configurationReady).toBeUndefined();
  await expect(h.config.setSessionModel(h.session.id, 'third')).resolves.toBeUndefined();
  expect(h.row().model).toBe('third');
  expect(h.sendSessionMessage).not.toHaveBeenCalled();
  await manager.stopClient(h.session.id);
});
