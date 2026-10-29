import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpRuntimeEventHandlers } from '@/backend/services/session/service/acp';
import { AcpClientFactory } from '@/backend/services/session/service/acp/acp-client-factory';
import { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import {
  createTestProcessHandle,
  exitChildWithCode,
  type MockChildProcess,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { AcpRuntimeSupervisor } from '@/backend/services/session/service/acp/acp-runtime-supervisor';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { AcpEventProcessor } from './acp-event-processor';
import {
  gate,
  setupStartupConfig,
  startupConfigOptions,
} from './session-pending-config.test-helpers';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn(() => Promise.resolve([])),
    findForDelivery: vi.fn(() => Promise.resolve(null)),
    markDelivered: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({})) },
}));
afterEach(() => vi.restoreAllMocks());

function setupSupervisor() {
  const h = setupStartupConfig();
  const manager = new AcpRuntimeManager();
  const creating = vi.spyOn(AcpRuntimeSupervisor.prototype, 'getOrCreateClient');
  const factory = vi.spyOn(AcpClientFactory.prototype, 'createClient').mockResolvedValue(h.handle);
  exitChildWithCode(unsafeCoerce<MockChildProcess>(h.handle.child));
  for (const name of [
    'getClient',
    'getPendingClient',
    'getOrCreateClient',
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
    Object.assign(h.runtimeManager, { [name]: manager[name].bind(manager) });
  }
  const config = new SessionConfigService({
    repository: unsafeCoerce(h.repository),
    runtimeManager: manager,
    sessionDomainService: unsafeCoerce(h.sessionDomainService),
    codexModelCatalogService: { getModels: () => Promise.resolve([]) },
  });
  for (const name of [
    'requireSavedStartupAccess',
    'applyStartupModel',
    'completeStartupConfiguration',
    'applyConfiguredReasoningEffort',
    'applyConfiguredPermissionPreset',
    'applyStartupModePreset',
    'applyStartupLaunchPlan',
    'persistAcpConfigSnapshot',
  ] as const) {
    h.sessionConfigService[name].mockImplementation(unsafeCoerce(config[name].bind(config)));
  }
  const processor = new AcpEventProcessor({
    runtimeManager: manager,
    sessionDomainService: unsafeCoerce(h.sessionDomainService),
    sessionPermissionService: unsafeCoerce({ createPermissionBridge: () => undefined }),
    sessionConfigService: config,
    onToolCallTimeout: () => undefined,
  });
  h.acpEventProcessor.createRuntimeEventHandler.mockImplementation(
    processor.createRuntimeEventHandler.bind(processor)
  );
  let emit: AcpRuntimeEventHandlers['onAcpEvent'];
  factory.mockImplementation((request) => {
    emit = request.handlers.onAcpEvent;
    return Promise.resolve(h.handle);
  });
  const identity = gate();
  const original = h.repository.updateSession.getMockImplementation();
  if (!original) {
    throw new Error('Expected real repository forwarding');
  }
  h.repository.updateSession.mockImplementation(async (...args) => {
    if (args[1].providerSessionId !== undefined) {
      await identity.wait();
    }
    return original(...args);
  });
  return {
    ...h,
    manager,
    config,
    identity,
    factory,
    creating,
    emitNative: (model = 'third') =>
      emit?.(h.session.id, {
        type: 'acp_session_update',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: startupConfigOptions(model),
        },
      }),
  };
}

describe('real supervisor and startup configuration phase ordering', () => {
  it('keeps the installed candidate hidden during identity persistence and clears pending before configuration', async () => {
    const h = setupSupervisor();
    const configuring = vi.spyOn(h.config, 'applyConfiguredReasoningEffort');
    const observations = vi.spyOn(h.config, 'applyConfigOptionsUpdateDelta');
    h.sessionConfigService.applyConfiguredReasoningEffort.mockImplementation(async (...args) => {
      expect(h.manager.getPendingClient(h.session.id)).toBeUndefined();
      expect(h.manager.getClient(h.session.id)).toBe(h.handle);
      expect(h.handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
        'third'
      );
      await configuring.apply(h.config, args);
    });
    const starting = h.service.startSession(h.session.id, { initialPrompt: 'Do work' });
    await h.identity.started;
    const supervisor = h.creating.mock.contexts[0];
    if (!(supervisor instanceof AcpRuntimeSupervisor)) {
      throw new Error('Expected real supervisor');
    }
    expect(supervisor?.getInstalledHandle(h.session.id)).toBe(h.handle);
    expect(supervisor?.isCurrentHandle(h.session.id, h.handle)).toBe(true);
    expect(h.manager.getPendingClient(h.session.id)).toBeDefined();
    expect(h.manager.getClient(h.session.id)).toBeUndefined();
    expect(h.manager.getBrowseClient(h.session.id)).toBeUndefined();
    expect(configuring).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.sessionConfigService.persistAcpConfigSnapshot).not.toHaveBeenCalled();
    expect(h.sendSessionMessage).not.toHaveBeenCalled();
    h.emitNative();
    h.identity.release();
    await starting;
    expect(configuring).toHaveBeenCalledOnce();
    expect(h.manager.getPendingClient(h.session.id)).toBeUndefined();
    expect(h.handle.configurationReady).toBeUndefined();
    expect(h.complete).toHaveBeenCalledOnce();
    expect(h.row().model).toBe('third');
    expect(h.row().providerMetadata).toMatchObject({
      acpConfigSnapshot: { observedModelId: 'third' },
    });
    expect(h.sessionDomainService.emitDelta).toHaveBeenCalledWith(
      h.session.id,
      expect.objectContaining({
        type: 'config_options_update',
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'model', currentValue: 'third' }),
        ]),
      })
    );
    expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(h.session.id, 'Do work');
    const source = observations.mock.calls[0]?.[3];
    expect(source?.()).toBe(true);
    await h.manager.stopClient(h.session.id);
    expect(source?.()).toBe(false);
    const published = h.sessionDomainService.emitDelta.mock.calls.length;
    h.config.applyConfigOptionsUpdateDelta(
      h.session.id,
      h.handle,
      startupConfigOptions('first'),
      source
    );
    h.emitNative('first');
    expect(h.sessionDomainService.emitDelta.mock.calls.length).toBe(published);
    expect(h.handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
      'third'
    );
  });
  it.each(['stop', 'exit', 'replacement'] as const)(
    'fences %s during pending identity without starting configuration or overwriting a newer snapshot',
    async (outcome) => {
      const h = setupSupervisor();
      const starting = h.service
        .startSession(h.session.id, { initialPrompt: 'Old prompt' })
        .catch((error) => error);
      await h.identity.started;
      h.emitNative('first');
      if (outcome === 'exit') {
        const child = unsafeCoerce<MockChildProcess>(h.handle.child);
        child.exitCode = 1;
        child.emit('exit', 1, null);
        h.identity.release();
      } else {
        const stopping = h.service.stopSession(h.session.id, { reason: 'USER_STOP' });
        h.identity.release();
        await stopping;
      }
      expect(await starting).toBeInstanceOf(Error);
      expect(h.sessionConfigService.persistAcpConfigSnapshot).not.toHaveBeenCalled();
      expect(h.sendSessionMessage).not.toHaveBeenCalled();
      expect(h.row().providerMetadata).toBeNull();
      if (outcome === 'replacement') {
        // The new runtime's initial model must agree with its durable desired
        // selection now that this fixture executes the real startup finalizer.
        await h.repository.updateSession(h.session.id, { model: 'third' });
        const replacement = createTestProcessHandle({
          providerSessionId: 'thread',
          sessionCreationOutcome: { kind: 'resumed' },
          connection: h.handle.connection,
        });
        replacement.configOptions = startupConfigOptions('third');
        exitChildWithCode(unsafeCoerce<MockChildProcess>(replacement.child));
        h.factory.mockResolvedValueOnce(replacement);
        await h.service.startSession(h.session.id, { initialPrompt: 'Replacement prompt' });
        expect(h.manager.getClient(h.session.id)).toBe(replacement);
        expect(replacement.isRunning()).toBe(true);
        const published = h.sessionDomainService.emitDelta.mock.calls.length;
        h.emitNative('first');
        expect(h.sessionDomainService.emitDelta.mock.calls.length).toBe(published);
        expect(
          replacement.configOptions.find((option) => option.id === 'model')?.currentValue
        ).toBe('third');
        expect(h.row().model).toBe('third');
        expect(h.row().providerMetadata).toMatchObject({
          acpConfigSnapshot: { observedModelId: 'third' },
        });
        expect(h.sendSessionMessage).toHaveBeenCalledExactlyOnceWith(
          h.session.id,
          'Replacement prompt'
        );
        await h.manager.stopClient(h.session.id);
      }
    }
  );

  it.each(['stop', 'exit', 'replacement'] as const)(
    'rejects a delayed pending-source snapshot after %s through the existing CAS guard',
    async (outcome) => {
      const h = setupSupervisor();
      const observations = vi.spyOn(h.config, 'applyConfigOptionsUpdateDelta');
      const starting = h.service.startSession(h.session.id);
      await h.identity.started;
      h.emitNative();
      h.identity.release();
      await starting;
      const source = observations.mock.calls[0]?.[3];
      expect(source?.()).toBe(true);
      const reading = gate();
      // Hold the repository's own post-read/pre-CAS boundary, after storage's read.
      h.accessor.findById.mockImplementationOnce(() => Promise.resolve(h.row()));
      h.accessor.findById.mockImplementationOnce(async () => {
        const row = h.row();
        await reading.wait();
        return row;
      });
      const persistence = vi.spyOn(h.config, 'persistAcpConfigSnapshot');
      h.config.applyConfigOptionsUpdateDelta(
        h.session.id,
        h.handle,
        startupConfigOptions('second'),
        source
      );
      const write = persistence.mock.results[0]?.value;
      await reading.started;
      expect(h.row().model).toBe('third');
      if (outcome === 'exit') {
        const child = unsafeCoerce<MockChildProcess>(h.handle.child);
        child.exitCode = 1;
        child.emit('exit', 1, null);
      } else {
        await h.manager.stopClient(h.session.id);
      }
      expect(source?.()).toBe(false);
      let replacementStart: Promise<void> | undefined;
      let replacement: ReturnType<typeof createTestProcessHandle> | undefined;
      if (outcome === 'replacement') {
        replacement = createTestProcessHandle({
          providerSessionId: 'thread',
          sessionCreationOutcome: { kind: 'resumed' },
          connection: h.handle.connection,
        });
        replacement.configOptions = startupConfigOptions('third');
        exitChildWithCode(unsafeCoerce<MockChildProcess>(replacement.child));
        h.factory.mockResolvedValueOnce(replacement);
        replacementStart = h.service.startSession(h.session.id);
        await vi.waitFor(() => expect(h.manager.getClient(h.session.id)).toBe(replacement));
      }
      const published = h.sessionDomainService.emitDelta.mock.calls.length;
      h.config.applyConfigOptionsUpdateDelta(
        h.session.id,
        h.handle,
        startupConfigOptions('first'),
        source
      );
      h.emitNative('first');
      expect(h.sessionDomainService.emitDelta.mock.calls.length).toBe(published);
      reading.release();
      await expect(write).rejects.toThrow('Session runtime changed');
      await replacementStart;
      expect(h.row().model).toBe('third');
      expect(h.row().providerMetadata).toMatchObject({
        acpConfigSnapshot: { observedModelId: 'third' },
      });
      if (replacement) {
        expect(replacement.isRunning()).toBe(true);
        expect(
          replacement.configOptions.find((option) => option.id === 'model')?.currentValue
        ).toBe('third');
        await h.manager.stopClient(h.session.id);
      }
    }
  );
});

vi.mock('@/backend/services/codex-accounts', () => ({
  NATIVE_DEFAULT_CODEX_ACCOUNT_ID: 'codex-native-default',
  codexAccountService: {
    getRuntimeContext: vi.fn(async (accountId = 'codex-native-default') => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    getPreviewRuntimeContext: vi.fn(async ({ accountId = 'codex-native-default' } = {}) => ({
      accountId,
      homeDir: '/test/codex',
      sessionsDir: '/test/codex/sessions',
      env: { CODEX_HOME: '/test/codex' },
    })),
    withAccountReservation: vi.fn(async (input, create) =>
      create(input.accountId ?? 'codex-native-default')
    ),
    getUsage: vi.fn(),
  },
}));
