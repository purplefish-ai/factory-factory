import { describe, expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import {
  createTestProcessHandle,
  createDeferred,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { EventSessionAuthority } from './event-session-authority';
import { SessionConfigService } from './session.config.service';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

function setup(eventAuthority?: Pick<EventSessionAuthority, 'assertOrdinary'>) {
  const handle = createTestProcessHandle({ providerSessionId: 'thread' });
  handle.configOptions = [
    {
      id: 'mode',
      name: 'Access',
      category: 'mode',
      type: 'select',
      currentValue: 'workspace-write',
      options: ['read-only', 'workspace-write'].map((value) => ({ value, name: value })),
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'first',
      options: ['first', 'second'].map((value) => ({ value, name: value })),
    },
    {
      id: 'reasoning',
      name: 'Reasoning',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: ['low', 'high'].map((value) => ({ value, name: value })),
    },
  ];
  const applyOption = (id: string, value: string) => {
    handle.configOptions = handle.configOptions.map((option) =>
      option.type === 'select' && option.id === id ? { ...option, currentValue: value } : option
    );
    return Promise.resolve(handle.configOptions);
  };
  const session = {
    id: 'session',
    provider: 'CODEX',
    providerSessionId: 'thread',
    workflow: 'code',
  };
  const runtime = {
    getClient: vi.fn(() => handle as AcpProcessHandle | undefined),
    isStopInProgress: vi.fn(() => false),
    setSessionMode: vi.fn((_sessionId: string, value: string) => applyOption('mode', value)),
    setSessionModel: vi.fn((_sessionId: string, value: string) => applyOption('model', value)),
    setConfigOption: vi.fn((_sessionId: string, id: string, value: string) =>
      applyOption(id, value)
    ),
  };
  const repository = { getSessionById: vi.fn().mockResolvedValue(session), updateSession: vi.fn() };
  const domain = { emitDelta: vi.fn() };
  const service = new SessionConfigService({
    eventAuthority,
    runtimeManager: unsafeCoerce(runtime),
    repository: unsafeCoerce(repository),
    codexModelCatalogService: { getModels: vi.fn() },
    sessionDomainService: unsafeCoerce(domain),
  });
  return { handle, session, runtime, repository, domain, service };
}

describe('public native config readiness', () => {
  it.each(['generic', 'reasoning'] as const)(
    'does not publish or persist a %s result from a replaced incarnation',
    async (kind) => {
      const h = setup();
      h.handle.configOptions = [
        {
          id: 'reasoning',
          category: 'thought_level',
          name: 'Reasoning',
          type: 'select',
          currentValue: 'low',
          options: ['low', 'high'].map((value) => ({ value, name: value })),
        },
      ];
      const responding = createDeferred<typeof h.handle.configOptions>();
      const rpc = kind === 'generic' ? h.runtime.setSessionMode : h.runtime.setConfigOption;
      rpc.mockReturnValueOnce(responding.promise);
      const setting = (
        kind === 'generic'
          ? h.service.setSessionConfigOption('session', 'mode', 'read-only')
          : h.service.setSessionReasoningEffort('session', 'high')
      ).catch((error: unknown) => error);
      await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
      const replacement = createTestProcessHandle({ providerSessionId: 'replacement' });
      h.runtime.getClient.mockReturnValue(replacement);
      h.repository.getSessionById.mockResolvedValue({
        ...h.session,
        providerSessionId: 'replacement',
      });
      responding.resolve([
        {
          id: 'mode',
          category: 'mode',
          name: 'Access',
          type: 'select',
          currentValue: 'agent-full-access',
          options: [{ value: 'agent-full-access', name: 'Full access' }],
        },
      ]);
      expect(await setting).toBeInstanceOf(Error);
      expect(h.domain.emitDelta).not.toHaveBeenCalled();
      expect(h.repository.updateSession).not.toHaveBeenCalled();
    }
  );

  it.each(['generic', 'reasoning'] as const)(
    'does not publish or persist a %s snapshot after replacement during metadata loading',
    async (kind) => {
      const h = setup();
      const reading = createDeferred<typeof h.session>();
      if (kind === 'generic') {
        h.repository.getSessionById.mockResolvedValueOnce(h.session);
      }
      h.repository.getSessionById.mockReturnValueOnce(reading.promise);
      const setting = (
        kind === 'generic'
          ? h.service.setSessionConfigOption('session', 'mode', 'read-only')
          : h.service.setSessionReasoningEffort('session', 'high')
      ).catch((error: unknown) => error);
      await vi.waitFor(() =>
        expect(h.repository.getSessionById).toHaveBeenCalledTimes(kind === 'generic' ? 2 : 1)
      );
      h.runtime.getClient.mockReturnValue(createTestProcessHandle({ providerSessionId: 'thread' }));
      reading.resolve(h.session);
      expect(await setting).toBeInstanceOf(Error);
      expect(h.repository.updateSession).not.toHaveBeenCalled();
      expect(h.domain.emitDelta).not.toHaveBeenCalled();
    }
  );

  it.each(['generic', 'reasoning'] as const)(
    'rejects a stale %s snapshot during retry metadata loading',
    async (kind) => {
      const h = setup();
      const reading = createDeferred<typeof h.session>();
      if (kind === 'generic') {
        h.repository.getSessionById.mockResolvedValueOnce(h.session);
      }
      h.repository.getSessionById
        .mockResolvedValueOnce(h.session)
        .mockReturnValueOnce(reading.promise);
      h.repository.updateSession.mockRejectedValueOnce(new Error('Storage unavailable'));
      const setting = (
        kind === 'generic'
          ? h.service.setSessionConfigOption('session', 'mode', 'read-only')
          : h.service.setSessionReasoningEffort('session', 'high')
      ).catch((error: unknown) => error);
      await vi.waitFor(() =>
        expect(h.repository.getSessionById).toHaveBeenCalledTimes(kind === 'generic' ? 3 : 2)
      );
      h.runtime.getClient.mockReturnValue(createTestProcessHandle({ providerSessionId: 'thread' }));
      reading.resolve(h.session);
      expect(await setting).toBeInstanceOf(Error);
      expect(h.repository.updateSession).toHaveBeenCalledOnce();
      expect(h.domain.emitDelta).not.toHaveBeenCalled();
    }
  );

  it('rejects a native change once stop begins even while its child is alive', async () => {
    const h = setup();
    h.runtime.isStopInProgress.mockReturnValue(true);
    await expect(
      h.service.setSessionConfigOption('session', 'mode', 'read-only')
    ).rejects.toThrow();
    expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
  });

  it.each(['model', 'reasoning'] as const)(
    'keeps public %s changes and their snapshots behind startup',
    async (kind) => {
      const h = setup();
      h.handle.configOptions = [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'first',
          options: ['first', 'second'].map((value) => ({ value, name: value })),
        },
        {
          id: 'reasoning',
          name: 'Reasoning',
          category: 'thought_level',
          type: 'select',
          currentValue: 'low',
          options: ['low', 'high'].map((value) => ({ value, name: value })),
        },
      ];
      h.handle.deferPromptReadiness();
      const setting =
        kind === 'model'
          ? h.service.setSessionModel('session', 'second')
          : h.service.setSessionReasoningEffort('session', 'high');
      await Promise.resolve();
      expect(h.runtime.setSessionModel).not.toHaveBeenCalled();
      expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
      expect(h.repository.updateSession).not.toHaveBeenCalled();
      h.handle.completeConfiguration();
      await setting;
      if (kind === 'model') {
        expect(h.runtime.setSessionModel).toHaveBeenCalledWith('session', 'second');
      } else {
        expect(h.runtime.setConfigOption).toHaveBeenCalledWith('session', 'reasoning', 'high');
      }
      expect(h.repository.updateSession).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({
          providerMetadata: expect.objectContaining({
            acpConfigSnapshot: expect.objectContaining({
              provider: 'CODEX',
              providerSessionId: 'thread',
              configOptions: expect.arrayContaining([
                expect.objectContaining({
                  id: kind === 'model' ? 'model' : 'reasoning',
                  currentValue: kind === 'model' ? 'second' : 'high',
                }),
              ]),
            }),
          }),
        }),
        expect.any(Function)
      );
    }
  );
  it('waits until startup configuration completes before applying a user choice', async () => {
    const h = setup();
    h.handle.deferPromptReadiness();
    const setting = h.service.setSessionConfigOption('session', 'mode', 'read-only');
    await Promise.resolve();
    expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
    h.handle.completeConfiguration();
    await setting;
    expect(h.runtime.setSessionMode).toHaveBeenCalledWith('session', 'read-only');
    expect(h.repository.updateSession).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        providerMetadata: expect.objectContaining({
          acpConfigSnapshot: expect.objectContaining({
            provider: 'CODEX',
            providerSessionId: 'thread',
            configOptions: expect.arrayContaining([
              expect.objectContaining({
                id: 'mode',
                currentValue: 'read-only',
              }),
            ]),
          }),
        }),
      }),
      expect.any(Function)
    );
  });

  it.each(['failure', 'replacement'] as const)(
    'rejects a queued native choice after %s',
    async (kind) => {
      const h = setup();
      h.handle.deferPromptReadiness();
      const setting = h.service
        .setSessionConfigOption('session', 'mode', 'read-only')
        .catch((error: unknown) => error);
      if (kind === 'failure') {
        h.handle.failConfiguration(new Error('access rejected'));
      } else {
        h.runtime.getClient.mockReturnValue(createTestProcessHandle());
        h.handle.completeConfiguration();
      }
      expect(await setting).toBeInstanceOf(Error);
      expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
    }
  );

  it('rechecks a new configuration barrier after asynchronous reviewer validation', async () => {
    const h = setup();
    const validating = createDeferred<typeof h.session>();
    h.repository.getSessionById.mockReturnValueOnce(validating.promise);
    const setting = h.service.setSessionConfigOption('session', 'mode', 'read-only');
    const configuration = h.handle.beginConfiguration();
    validating.resolve(h.session);
    await Promise.resolve();
    expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
    configuration.complete();
    await setting;
    expect(h.runtime.setSessionMode).toHaveBeenCalledOnce();
  });
});

it.each(['model', 'generic', 'reasoning'] as const)(
  'fences public %s mutations while ordinary mutations retain behavior',
  async (kind) => {
    let fenced = true;
    const h = setup({
      assertOrdinary: () =>
        fenced ? Promise.reject(new Error('initial fenced')) : Promise.resolve(),
    });
    const edit = () =>
      kind === 'model'
        ? h.service.setSessionModel('session', 'second')
        : kind === 'generic'
          ? h.service.setSessionConfigOption('session', 'mode', 'read-only')
          : h.service.setSessionReasoningEffort('session', 'high');
    await expect(edit()).rejects.toThrow('initial fenced');
    expect(h.runtime.setSessionModel).not.toHaveBeenCalled();
    expect(h.runtime.setSessionMode).not.toHaveBeenCalled();
    expect(h.runtime.setConfigOption).not.toHaveBeenCalled();
    expect(h.repository.updateSession).not.toHaveBeenCalled();
    fenced = false;
    await edit();
    expect(
      h.runtime.setSessionModel.mock.calls.length +
        h.runtime.setSessionMode.mock.calls.length +
        h.runtime.setConfigOption.mock.calls.length
    ).toBe(1);
  }
);
