import { describe, expect, it, vi } from 'vitest';
import {
  createDeferred,
  createTestProcessHandle,
} from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import {
  configOptions,
  setupAuthority,
} from '@/backend/services/session/service/lifecycle/session-config-authority.test-helpers';

vi.mock('@/backend/services/settings', () => ({ userSettingsService: {} }));

const queued = () => ({
  timestamp: new Date(0).toISOString(),
  settings: {
    selectedModel: 'first',
    reasoningEffort: 'high',
    thinkingEnabled: false,
    planModeEnabled: true,
  },
});

describe('accepted queued settings survive runtime changes', () => {
  it('preserves accepted live edits after the runtime is replaced', async () => {
    const h = setupAuthority();
    await h.service.setSessionConfigOption('session', 'model', 'second');
    const replacement = createTestProcessHandle({ provider: 'CODEX', providerSessionId: 'thread' });
    replacement.configOptions = configOptions('second');
    h.runtime.getClient.mockReturnValue(replacement);
    expect(h.service.resolveQueuedMessageSettings('session', queued())).toMatchObject({
      selectedModel: 'second',
      reasoningEffort: 'low',
    });
  });

  it.each(['model', 'reasoning_effort', 'collaboration_mode'])(
    'retains a durable inactive %s edit before restart and after replacement',
    async (configId) => {
      const h = setupAuthority();
      await h.service.persistAcpConfigSnapshot('session', {
        provider: 'CODEX',
        providerSessionId: 'thread',
        configOptions: h.handle.configOptions,
      });
      h.runtime.getClient.mockReturnValue(undefined);
      const value =
        configId === 'model' ? 'second' : configId === 'reasoning_effort' ? 'low' : 'default';
      await h.service.setSessionConfigOption('session', configId, value);
      const expected =
        configId === 'model'
          ? { selectedModel: 'second', reasoningEffort: 'low' }
          : configId === 'reasoning_effort'
            ? { reasoningEffort: 'low' }
            : { planModeEnabled: false };
      expect(h.service.resolveQueuedMessageSettings('session', queued())).toMatchObject(expected);
      const replacement = createTestProcessHandle({
        provider: 'CODEX',
        providerSessionId: 'thread',
      });
      replacement.configOptions = configOptions('second');
      h.runtime.getClient.mockReturnValue(replacement);
      expect(h.service.resolveQueuedMessageSettings('session', queued())).toMatchObject(expected);
    }
  );

  it('retains a durable inactive explicit model request', async () => {
    const h = setupAuthority();
    await h.service.persistAcpConfigSnapshot('session', {
      provider: 'CODEX',
      providerSessionId: 'thread',
      configOptions: h.handle.configOptions,
    });
    h.runtime.getClient.mockReturnValue(undefined);
    await h.service.setSessionModel('session', 'second', 'user');
    expect(h.service.resolveQueuedMessageSettings('session', queued()).selectedModel).toBe(
      'second'
    );
  });

  it.each(['generic', 'model'] as const)(
    'retains an inactive %s edit rerouted to a newly installed runtime',
    async (kind) => {
      const h = setupAuthority();
      h.runtime.getClient.mockReturnValue(undefined);
      const read = h.repository.getSessionById.bind(h.repository);
      vi.spyOn(h.repository, 'getSessionById').mockImplementationOnce(async (sessionId) => {
        h.runtime.getClient.mockReturnValue(h.handle);
        return await read(sessionId);
      });
      await (kind === 'generic'
        ? h.service.setSessionConfigOption('session', 'model', 'second')
        : h.service.setSessionModel('session', 'second', 'user'));
      expect(h.runtime.setSessionModel).toHaveBeenCalledWith('session', 'second');
      expect(h.service.resolveQueuedMessageSettings('session', queued())).toMatchObject({
        selectedModel: 'second',
        reasoningEffort: 'low',
      });
    }
  );

  it('does not capture a reasoning-only no-op while stopped', async () => {
    const h = setupAuthority();
    await h.service.persistAcpConfigSnapshot('session', {
      provider: 'CODEX',
      providerSessionId: 'thread',
      configOptions: h.handle.configOptions,
    });
    h.runtime.getClient.mockReturnValue(undefined);
    await h.service.setSessionReasoningEffort('session', 'low', 'user');
    expect(h.service.resolveQueuedMessageSettings('session', queued()).reasoningEffort).toBe(
      'high'
    );
  });

  it('releases retained intent on permanent deletion', async () => {
    const h = setupAuthority();
    await h.service.setSessionConfigOption('session', 'model', 'second');
    h.service.releaseSessionConfiguration('session');
    expect(h.service.resolveQueuedMessageSettings('session', queued()).selectedModel).toBe('first');
  });

  it('does not retain an unfinished edit rejected by runtime replacement', async () => {
    const h = setupAuthority();
    const writing = createDeferred<{ configOptions: ReturnType<typeof configOptions> }>();
    h.connection.setSessionConfigOption.mockReturnValueOnce(writing.promise);
    const edit = h.service.setSessionConfigOption('session', 'model', 'second');
    await vi.waitFor(() => expect(h.connection.setSessionConfigOption).toHaveBeenCalled());
    h.runtime.getClient.mockReturnValue(createTestProcessHandle());
    writing.resolve({ configOptions: configOptions('second') });
    await expect(edit).rejects.toThrow('Session runtime changed');
    expect(h.service.resolveQueuedMessageSettings('session', queued()).selectedModel).toBe('first');
  });

  it('does not retain a rejected inactive edit', async () => {
    const h = setupAuthority();
    await h.service.persistAcpConfigSnapshot('session', {
      provider: 'CODEX',
      providerSessionId: 'thread',
      configOptions: h.handle.configOptions,
    });
    h.runtime.getClient.mockReturnValue(undefined);
    await expect(
      h.service.setSessionConfigOption('session', 'model', 'unsupported')
    ).rejects.toThrow('Unsupported');
    expect(h.service.resolveQueuedMessageSettings('session', queued()).selectedModel).toBe('first');
  });
});
