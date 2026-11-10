import type { SessionConfigOption } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it, vi } from 'vitest';
import {
  createDeferred,
  createTestProcessHandle,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

function setup() {
  const configOptions: SessionConfigOption[] = [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'first',
      options: ['first', 'second'].map((value) => ({ value, name: value })),
    },
  ];
  const session = {
    id: 'session',
    provider: 'CODEX',
    providerSessionId: 'thread',
    model: 'first',
    workflow: 'code',
    providerMetadata: {
      acpConfigSnapshot: { provider: 'CODEX', providerSessionId: 'thread', configOptions },
    },
  };
  const repository = {
    getSessionById: vi.fn().mockResolvedValue(session),
    updateSession: vi
      .fn()
      .mockImplementation(async (_id, update) => Object.assign(session, update)),
  };
  const runtime = {
    getClient: vi.fn(),
    isStopInProgress: vi.fn(() => false),
    setSessionModel: vi.fn().mockResolvedValue(configOptions),
  };
  const catalog = {
    getModels: vi
      .fn()
      .mockResolvedValue([{ id: 'second', displayName: 'Second', isDefault: true }]),
  };
  const domain = { emitDelta: vi.fn() };
  const service = new SessionConfigService({
    repository: unsafeCoerce(repository),
    runtimeManager: unsafeCoerce(runtime),
    codexModelCatalogService: catalog,
    sessionDomainService: unsafeCoerce(domain),
  });
  return { configOptions, session, repository, runtime, catalog, service };
}

describe('durable session model selection', () => {
  it('persists a stopped model edit for the next startup', async () => {
    const h = setup();
    await h.service.setSessionModel('session', 'second');
    expect(h.session.model).toBe('second');
    expect(h.session.providerMetadata.acpConfigSnapshot.configOptions[0]?.currentValue).toBe(
      'second'
    );
    expect(h.runtime.setSessionModel).not.toHaveBeenCalled();
  });

  it('rejects an unsupported model instead of silently keeping another model', async () => {
    const h = setup();
    const handle = createTestProcessHandle();
    handle.configOptions = h.configOptions;
    h.runtime.getClient.mockReturnValue(handle);
    await expect(h.service.setSessionModel('session', 'missing')).rejects.toThrow(
      'Unsupported model'
    );
    expect(h.runtime.setSessionModel).not.toHaveBeenCalled();
  });

  it('rejects an unsupported live model through the generic configuration endpoint', async () => {
    const h = setup();
    const handle = createTestProcessHandle();
    handle.configOptions = h.configOptions;
    h.runtime.getClient.mockReturnValue(handle);
    await expect(h.service.setSessionConfigOption('session', 'model', 'missing')).rejects.toThrow(
      'Unsupported model'
    );
    expect(h.runtime.setSessionModel).not.toHaveBeenCalled();
  });

  it('validates against the options available after startup readiness', async () => {
    const h = setup();
    const handle = createTestProcessHandle();
    handle.configOptions = [];
    handle.deferPromptReadiness();
    h.runtime.getClient.mockReturnValue(handle);
    h.runtime.setSessionModel.mockImplementation(async () => handle.configOptions);
    const changing = h.service.setSessionModel('session', 'second');
    handle.configOptions = h.configOptions;
    handle.completeConfiguration();
    await changing;
    expect(h.runtime.setSessionModel).toHaveBeenCalledWith('session', 'second');
  });

  it('does not persist a native default while passively reading a catalog', async () => {
    const h = setup();
    h.session.model = 'unavailable';
    const model = h.configOptions[0];
    if (model?.type === 'select') {
      h.configOptions[0] = { ...model, currentValue: 'unavailable' };
    }
    const options = await h.service.getSessionConfigOptionsWithFallback('session');
    expect(options.find((option) => option.category === 'model')?.currentValue).toBe('unavailable');
    expect(h.repository.updateSession).not.toHaveBeenCalled();
  });

  it('returns the live choice if a runtime appears during catalog discovery', async () => {
    const h = setup();
    const discovered = createDeferred<Awaited<ReturnType<typeof h.catalog.getModels>>>();
    h.catalog.getModels.mockReturnValue(discovered.promise);
    const reading = h.service.getSessionConfigOptionsWithFallback('session');
    await vi.waitFor(() => expect(h.catalog.getModels).toHaveBeenCalled());
    const handle = createTestProcessHandle();
    handle.configOptions = h.configOptions.map((option) =>
      option.type === 'select' ? { ...option, currentValue: 'live' } : option
    );
    h.runtime.getClient.mockReturnValue(handle);
    discovered.resolve([{ id: 'second', displayName: 'Second', isDefault: true }]);
    expect((await reading)[0]?.currentValue).toBe('live');
    expect(h.repository.updateSession).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer stopped edit after delayed catalog discovery', async () => {
    const h = setup();
    const discovered = createDeferred<Awaited<ReturnType<typeof h.catalog.getModels>>>();
    h.catalog.getModels.mockReturnValue(discovered.promise);
    const reading = h.service.getSessionConfigOptionsWithFallback('session');
    await vi.waitFor(() => expect(h.catalog.getModels).toHaveBeenCalled());
    await h.service.setSessionConfigOption('session', 'model', 'second');
    discovered.resolve([{ id: 'second', displayName: 'Second', isDefault: true }]);
    expect((await reading)[0]?.currentValue).toBe('second');
    expect(h.session.model).toBe('second');
    expect(h.repository.updateSession).toHaveBeenCalledTimes(1);
  });
});
