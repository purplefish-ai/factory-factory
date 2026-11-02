import { expect, it, vi } from 'vitest';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { setupAuthority } from './session-config-authority.test-helpers';

it('persists desired queued settings before publishing or acknowledging a native configuration edit', async () => {
  const gate = createDeferred<void>();
  const override = vi.fn(() => gate.promise);
  const h = setupAuthority(undefined, { override });
  const pending = h.service.setSessionModel('session', 'second', 'user');
  await vi.waitFor(() => expect(override).toHaveBeenCalledOnce());
  expect(h.models()).toEqual([]);
  gate.resolve();
  await pending;
  expect(h.models()).toEqual(['second']);
});

it('retains a provider-accepted edit and fences prompts until desired persistence recovers', async () => {
  let unavailable = true;
  const override = vi.fn(() =>
    unavailable ? Promise.reject(new Error('desired settings unavailable')) : Promise.resolve()
  );
  const h = setupAuthority(undefined, { override });
  const message = {
    timestamp: new Date(0).toISOString(),
    settings: {
      selectedModel: 'first',
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
  await expect(h.service.setSessionModel('session', 'second', 'user')).rejects.toThrow(
    'desired settings unavailable'
  );
  expect(h.handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
    'second'
  );
  expect(h.models()).toEqual([]);
  expect(h.service.resolveQueuedMessageSettings('session', message).selectedModel).toBe('second');
  const invoke = vi.fn(async () => undefined);
  await expect(h.service.withPromptConfiguration('session', invoke)).rejects.toThrow(
    'desired settings unavailable'
  );
  expect(invoke).not.toHaveBeenCalled();
  unavailable = false;
  await h.service.withPromptConfiguration('session', invoke);
  expect(invoke).toHaveBeenCalledOnce();
  expect(override).toHaveBeenLastCalledWith(
    'session',
    expect.any(Number),
    expect.objectContaining({ selectedModel: 'second' })
  );
});

it('retains an accepted inactive snapshot and fences admission when desired persistence fails', async () => {
  let unavailable = true;
  const override = vi.fn(() =>
    unavailable ? Promise.reject(new Error('desired settings unavailable')) : Promise.resolve()
  );
  const h = setupAuthority(undefined, { override });
  await h.service.persistAcpConfigSnapshot('session', {
    provider: 'CODEX',
    providerSessionId: 'thread',
    configOptions: h.handle.configOptions,
  });
  h.runtime.getClient.mockReturnValue(undefined);
  await expect(h.service.setSessionModel('session', 'second', 'user')).rejects.toThrow(
    'desired settings unavailable'
  );
  expect(h.row().model).toBe('second');
  expect(h.models()).toEqual([]);
  const message = olderMessage();
  expect(h.service.resolveQueuedMessageSettings('session', message).selectedModel).toBe('second');
  h.runtime.getClient.mockReturnValue(h.handle);
  const invoke = vi.fn(() => Promise.resolve());
  await expect(h.service.withPromptConfiguration('session', invoke)).rejects.toThrow(
    'desired settings unavailable'
  );
  expect(invoke).not.toHaveBeenCalled();
  unavailable = false;
  h.runtime.getClient.mockReturnValue(h.handle);
  await h.service.withPromptConfiguration('session', invoke);
  expect(invoke).toHaveBeenCalledOnce();
});

it('does not retain desired settings for a provider-rejected edit', async () => {
  const override = vi.fn(async () => undefined);
  const h = setupAuthority(undefined, { override });
  h.connection.setSessionConfigOption.mockRejectedValueOnce(new Error('provider rejected edit'));
  await expect(h.service.setSessionModel('session', 'second', 'user')).rejects.toThrow(
    'provider rejected edit'
  );
  expect(override).not.toHaveBeenCalled();
  const invoke = vi.fn(async () => undefined);
  await h.service.withPromptConfiguration('session', invoke);
  expect(invoke).toHaveBeenCalledOnce();
  expect(override).not.toHaveBeenCalled();
});

function olderMessage() {
  return {
    timestamp: new Date(0).toISOString(),
    settings: {
      selectedModel: 'first',
      reasoningEffort: null,
      thinkingEnabled: false,
      planModeEnabled: false,
    },
  };
}

it('does not retain an inactive edit when the guarded snapshot fails', async () => {
  let desired = 'first';
  const override = vi.fn((_id, _requestedAt, settings) => {
    desired = settings.selectedModel;
    return Promise.resolve();
  });
  const h = setupAuthority(undefined, { override });
  await h.service.persistAcpConfigSnapshot('session', {
    provider: 'CODEX',
    providerSessionId: 'thread',
    configOptions: h.handle.configOptions,
  });
  h.runtime.getClient.mockReturnValue(undefined);
  h.hooks.cas = () => Promise.reject(new Error('snapshot unavailable'));
  await expect(h.service.setSessionModel('session', 'second', 'user')).rejects.toThrow(
    'snapshot unavailable'
  );
  expect(h.row().model).toBe('first');
  expect(desired).toBe('first');
  expect(h.service.resolveQueuedMessageSettings('session', olderMessage()).selectedModel).toBe(
    'first'
  );
});

it('preserves prior desired settings when a precommit runtime handoff rejects the inactive edit', async () => {
  let desired = 'first';
  const override = vi.fn((_id, _requestedAt, settings) => {
    desired = settings.selectedModel;
    return Promise.resolve();
  });
  const h = setupAuthority(undefined, { override });
  await h.service.persistAcpConfigSnapshot('session', {
    provider: 'CODEX',
    providerSessionId: 'thread',
    configOptions: h.handle.configOptions,
  });
  h.runtime.getClient.mockReturnValue(undefined);
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const persist = h.repository.updateSession.bind(h.repository);
  vi.spyOn(h.repository, 'updateSession').mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return persist(...args);
  });
  h.connection.setSessionConfigOption.mockRejectedValueOnce(new Error('provider rejected edit'));
  const pending = h.service.setSessionModel('session', 'second', 'user');
  const rejected = expect(pending).rejects.toThrow('provider rejected edit');
  await entered.promise;
  h.runtime.getClient.mockReturnValue(h.handle);
  release.resolve();
  await rejected;
  expect(h.connection.setSessionConfigOption).toHaveBeenCalledOnce();
  expect(h.row().model).toBe('first');
  expect(desired).toBe('first');
  expect(h.service.resolveQueuedMessageSettings('session', olderMessage()).selectedModel).toBe(
    'first'
  );
});

it('does not resubmit an accepted inactive edit when a runtime appears during desired persistence', async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  const override = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const h = setupAuthority(undefined, { override });
  await h.service.persistAcpConfigSnapshot('session', {
    provider: 'CODEX',
    providerSessionId: 'thread',
    configOptions: h.handle.configOptions,
  });
  h.runtime.getClient.mockReturnValue(undefined);
  h.connection.setSessionConfigOption.mockRejectedValueOnce(new Error('provider rejected edit'));
  const pending = h.service.setSessionModel('session', 'second', 'user');
  const completed = expect(pending).resolves.toBeUndefined();
  await entered.promise;
  h.runtime.getClient.mockReturnValue(h.handle);
  release.resolve();
  await completed;
  expect(h.connection.setSessionConfigOption).not.toHaveBeenCalled();
  expect(h.row().model).toBe('second');
  expect(h.models()).toEqual([]);
  expect(h.service.resolveQueuedMessageSettings('session', olderMessage()).selectedModel).toBe(
    'second'
  );
});
