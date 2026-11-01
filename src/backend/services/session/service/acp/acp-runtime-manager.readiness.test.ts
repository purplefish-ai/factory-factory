import { beforeEach, expect, it, vi } from 'vitest';
import { createLifecycleHarness } from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';
import { AcpClientFactory } from './acp-client-factory';
import { AcpRuntimeManager } from './acp-runtime-manager';
import {
  createDeferred,
  createTestProcessHandle,
  type MockChildProcess,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  exitChildAfterSigterm,
} from './acp-runtime-manager.test-helpers';

vi.mock('@/backend/services/workspace', () => ({
  workspaceDataService: { findById: vi.fn() },
  workspaceNotificationService: {
    listPendingForDelivery: vi.fn().mockResolvedValue([]),
    markDelivered: vi.fn(),
  },
}));

const mockPrompt = vi.fn();
let factory = vi.spyOn(AcpClientFactory.prototype, 'createClient');
beforeEach(() => {
  factory = vi.spyOn(AcpClientFactory.prototype, 'createClient').mockReset();
  mockPrompt.mockReset();
});
function createManagerTestHarness() {
  return { manager: new AcpRuntimeManager() };
}
function setupSuccessfulSpawn(capabilities?: Record<string, unknown>): MockChildProcess {
  const handle = createTestProcessHandle({
    provider: 'CLAUDE',
    providerSessionId: 'provider-session-123',
    agentCapabilities: capabilities,
    connection: { prompt: mockPrompt },
  });
  factory.mockResolvedValue(handle);
  return handle.child as unknown as MockChildProcess;
}

it('holds a direct prompt until the installed candidate finishes configuration', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  const handle = await manager.getOrCreateClient(
    'session-1',
    { ...defaultOptions(), deferPromptReadiness: true },
    defaultHandlers(),
    defaultContext()
  );
  const prompt = manager.sendPrompt('session-1', [{ type: 'text', text: 'Wait for read-only' }]);
  await Promise.resolve();
  expect(mockPrompt).not.toHaveBeenCalled();
  handle.completeConfiguration();
  await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
  expect(mockPrompt).toHaveBeenCalledOnce();
});

it.each(['stop', 'exit', 'setup failure'] as const)(
  'rejects waiting prompts on %s without running the provider',
  async (kind) => {
    const { manager } = createManagerTestHarness();
    const child = setupSuccessfulSpawn();
    exitChildAfterSigterm(child);
    const handle = await manager.getOrCreateClient(
      'session-1',
      { ...defaultOptions(), deferPromptReadiness: true },
      defaultHandlers(),
      defaultContext()
    );
    const prompt = manager
      .sendPrompt('session-1', [{ type: 'text', text: 'Never execute' }])
      .catch((error: unknown) => error);
    await Promise.resolve();
    expect(mockPrompt).not.toHaveBeenCalled();
    if (kind === 'stop') {
      await manager.stopClient('session-1');
    } else if (kind === 'exit') {
      child.exitCode = 1;
      child.emit('exit', 1, null);
    } else {
      handle.failConfiguration(new Error('access rejected'));
    }
    expect(await prompt).toBeInstanceOf(Error);
    expect(mockPrompt).not.toHaveBeenCalled();
  }
);

it('keeps a concurrent direct prompt behind explicit startup access enforcement', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const lifecycle = createLifecycleHarness();
  lifecycle.runtimeManager.getClient.mockImplementation((id) => manager.getClient(id));
  lifecycle.runtimeManager.getOrCreateClient.mockImplementation((...args) =>
    manager.getOrCreateClient(...args)
  );
  const configuring = createDeferred<void>();
  lifecycle.sessionConfigService.applyConfiguredPermissionPreset.mockReturnValueOnce(
    configuring.promise
  );
  const startup = lifecycle.service.startSession('session-1', { initialPrompt: '' });
  await vi.waitFor(() =>
    expect(lifecycle.sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalled()
  );
  mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  const prompt = manager.sendPrompt('session-1', [{ type: 'text', text: 'User message' }]);
  await Promise.resolve();
  expect(mockPrompt).not.toHaveBeenCalled();
  configuring.resolve();
  await startup;
  await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
  expect(mockPrompt).toHaveBeenCalledOnce();
});

it('waits for overlapping and newly started configuration leases', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  const handle = await manager.getOrCreateClient(
    'session-1',
    { ...defaultOptions(), deferPromptReadiness: true },
    defaultHandlers(),
    defaultContext()
  );
  const overlapping = handle.beginConfiguration();
  const prompt = manager.sendPrompt('session-1', [{ type: 'text', text: 'Wait' }]);
  handle.completeConfiguration();
  await Promise.resolve();
  expect(mockPrompt).not.toHaveBeenCalled();
  overlapping.complete();
  const newer = handle.beginConfiguration();
  overlapping.fail(new Error('stale failure'));
  await Promise.resolve();
  expect(mockPrompt).not.toHaveBeenCalled();
  newer.complete();
  await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
});

it('keeps a failed setup rejected after another configuration lease completes', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const handle = await manager.getOrCreateClient(
    'session-1',
    { ...defaultOptions(), deferPromptReadiness: true },
    defaultHandlers(),
    defaultContext()
  );
  const lease = handle.beginConfiguration();
  const prompt = manager.sendPrompt('session-1', []).catch((error: unknown) => error);
  const failure = new Error('permission setup failed');
  lease.fail(failure);
  handle.completeConfiguration();
  expect(await prompt).toBe(failure);
  await expect(manager.sendPrompt('session-1', [])).rejects.toBe(failure);
  expect(mockPrompt).not.toHaveBeenCalled();
});

it('blocks browse prompts and defers an active promotion until its configuration completes', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn({ loadSession: true });
  mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  const handle = await manager.getOrCreateClient(
    'session-1',
    {
      ...defaultOptions(),
      purpose: 'browse',
      resumeProviderSessionId: 'existing',
      deferPromptReadiness: true,
    },
    defaultHandlers(),
    defaultContext()
  );
  expect(handle.configurationReady).toBeUndefined();
  await expect(manager.sendPrompt('session-1', [])).rejects.toThrow('not ready');
  await manager.getOrCreateClient(
    'session-1',
    { ...defaultOptions(), deferPromptReadiness: true },
    defaultHandlers(),
    defaultContext()
  );
  const prompt = manager.sendPrompt('session-1', []);
  await Promise.resolve();
  expect(mockPrompt).not.toHaveBeenCalled();
  handle.completeConfiguration();
  await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
});

it('does not let stopped waiters or late setup completion release a replacement handle', async () => {
  const { manager } = createManagerTestHarness();
  const child = setupSuccessfulSpawn();
  exitChildAfterSigterm(child);
  const options = { ...defaultOptions(), deferPromptReadiness: true };
  const original = await manager.getOrCreateClient(
    'session-1',
    options,
    defaultHandlers(),
    defaultContext()
  );
  const stoppedPrompt = manager.sendPrompt('session-1', []).catch((error: unknown) => error);
  await manager.stopClient('session-1');
  expect(await stoppedPrompt).toBeInstanceOf(Error);
  setupSuccessfulSpawn();
  const replacement = await manager.getOrCreateClient(
    'session-1',
    options,
    defaultHandlers(),
    defaultContext()
  );
  mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  const prompt = manager.sendPrompt('session-1', []);
  original.completeConfiguration();
  await Promise.resolve();
  expect(mockPrompt).not.toHaveBeenCalled();
  replacement.completeConfiguration();
  await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
});

it('rejects a prompt when stop begins after readiness resolves but before its continuation', async () => {
  const { manager } = createManagerTestHarness();
  const child = setupSuccessfulSpawn();
  exitChildAfterSigterm(child);
  const handle = await manager.getOrCreateClient(
    'session-1',
    { ...defaultOptions(), deferPromptReadiness: true },
    defaultHandlers(),
    defaultContext()
  );
  const prompt = manager.sendPrompt('session-1', []).catch((error: unknown) => error);
  handle.completeConfiguration();
  await manager.stopClient('session-1');
  expect(await prompt).toBeInstanceOf(Error);
  expect(mockPrompt).not.toHaveBeenCalled();
});

it('keeps prompts behind explicitly requested startup planning as well as native access', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const lifecycle = createLifecycleHarness();
  lifecycle.runtimeManager.getClient.mockImplementation((id) => manager.getClient(id));
  lifecycle.runtimeManager.getOrCreateClient.mockImplementation((...args) =>
    manager.getOrCreateClient(...args)
  );
  const planning = createDeferred<void>();
  lifecycle.sessionConfigService.applyStartupModePreset.mockReturnValueOnce(planning.promise);
  const startup = lifecycle.service.startSession('session-1', {
    initialPrompt: '',
    startupModePreset: 'plan',
  });
  await vi.waitFor(() =>
    expect(lifecycle.sessionConfigService.applyStartupModePreset).toHaveBeenCalled()
  );
  mockPrompt.mockResolvedValue({ stopReason: 'end_turn' });
  const prompt = manager.sendPrompt('session-1', []);
  await Promise.resolve();
  expect(mockPrompt).not.toHaveBeenCalled();
  planning.resolve();
  await startup;
  await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
});

it('rejects a concurrent prompt and stops the candidate when explicit startup access fails', async () => {
  const { manager } = createManagerTestHarness();
  const child = setupSuccessfulSpawn();
  exitChildAfterSigterm(child);
  const lifecycle = createLifecycleHarness();
  lifecycle.runtimeManager.getClient.mockImplementation((id) => manager.getClient(id));
  lifecycle.runtimeManager.getOrCreateClient.mockImplementation((...args) =>
    manager.getOrCreateClient(...args)
  );
  lifecycle.runtimeManager.stopClient.mockImplementation((id) => manager.stopClient(id));
  const configuring = createDeferred<void>();
  lifecycle.sessionConfigService.applyConfiguredPermissionPreset.mockReturnValueOnce(
    configuring.promise
  );
  const startup = lifecycle.service
    .startSession('session-1', { initialPrompt: '' })
    .catch((error: unknown) => error);
  await vi.waitFor(() =>
    expect(lifecycle.sessionConfigService.applyConfiguredPermissionPreset).toHaveBeenCalled()
  );
  const prompt = manager.sendPrompt('session-1', []).catch((error: unknown) => error);
  configuring.reject(new Error('access rejected'));
  expect(await startup).toEqual(expect.objectContaining({ message: 'access rejected' }));
  expect(await prompt).toBeInstanceOf(Error);
  expect(manager.getClient('session-1')).toBeUndefined();
  expect(mockPrompt).not.toHaveBeenCalled();
});

it('observes SENDING only after readiness and rejects configuration reintroduced during persistence', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const handle = await manager.getOrCreateClient(
    'session-1',
    { ...defaultOptions(), deferPromptReadiness: true },
    defaultHandlers(),
    defaultContext()
  );
  const sending = vi.fn(() => {
    handle.deferPromptReadiness();
    handle.beginConfiguration();
    return Promise.resolve();
  });
  const observed = {
    lifecycleGeneration: 7,
    createObservation: vi.fn((_source, assertCurrent) => ({
      assertCurrent,
      beforeSend: sending,
      outcome: async () => undefined,
      ambiguous: async () => undefined,
    })),
  };
  const pending = manager
    .sendPrompt('session-1', [{ type: 'text', text: 'initial' }], undefined, observed)
    .catch((error) => error);
  await Promise.resolve();
  expect(sending).not.toHaveBeenCalled();
  handle.completeConfiguration();
  expect(await pending).toBeInstanceOf(Error);
  expect(mockPrompt).not.toHaveBeenCalled();
  expect(observed.createObservation).toHaveBeenCalledWith(
    expect.objectContaining({
      providerSessionId: 'provider-session-123',
      lifecycleGeneration: 7,
      runtimeIncarnationId: expect.any(String),
    }),
    expect.any(Function)
  );
});

it('does not treat generic or repeated provider activity as initial prompt acceptance or outcome', async () => {
  const { manager } = createManagerTestHarness();
  setupSuccessfulSpawn();
  const response = createDeferred<{ stopReason: 'end_turn' }>();
  mockPrompt.mockReturnValue(response.promise);
  await manager.getOrCreateClient(
    'session-1',
    defaultOptions(),
    defaultHandlers(),
    defaultContext()
  );
  const beforeSend = vi.fn(async () => undefined);
  const outcome = vi.fn(async () => undefined);
  const pending = manager.sendPrompt('session-1', [{ type: 'text', text: 'task' }], undefined, {
    lifecycleGeneration: 1,
    createObservation: (_source, assertCurrent) => ({
      assertCurrent,
      beforeSend,
      outcome,
      ambiguous: async () => undefined,
    }),
  });
  await vi.waitFor(() => expect(mockPrompt).toHaveBeenCalledOnce());
  const activity = () =>
    factory.mock.calls[0]?.[0].handlers.onAcpEvent?.('session-1', {
      type: 'acp_session_update',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'task' } },
    });
  activity();
  activity();
  expect(beforeSend).toHaveBeenCalledOnce();
  expect(outcome).not.toHaveBeenCalled();
  response.resolve({ stopReason: 'end_turn' });
  await pending;
  activity();
  expect(outcome).toHaveBeenCalledExactlyOnceWith({ stopReason: 'end_turn', result: 'COMPLETED' });
});
