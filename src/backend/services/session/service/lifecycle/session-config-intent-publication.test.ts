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

it('keeps an inactive snapshot unchanged when desired persistence rejects the edit', async () => {
  const override = vi.fn(() => Promise.reject(new Error('desired settings unavailable')));
  const h = setupAuthority(undefined, { override });
  await h.service.persistAcpConfigSnapshot('session', {
    provider: 'CODEX',
    providerSessionId: 'thread',
    configOptions: h.handle.configOptions,
  });
  h.runtime.getClient.mockReturnValue(undefined);
  const before = h.row();
  await expect(h.service.setSessionModel('session', 'second', 'user')).rejects.toThrow(
    'desired settings unavailable'
  );
  expect(h.row().model).toBe(before.model);
  expect(h.row().providerMetadata).toEqual(before.providerMetadata);
  expect(h.models()).toEqual([]);
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
