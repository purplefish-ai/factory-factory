import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import { SessionLaunchOptionsService } from './session-launch-options.service';
function native(provider: 'CLAUDE' | 'CODEX', model: string): SessionLaunchOptions {
  return {
    provider,
    model,
    reasoning: {
      options: [
        { value: 'low', label: 'Low' },
        { value: 'xhigh', label: 'Extra high' },
      ],
      selected: 'low',
      defaultValue: 'low',
    },
    planMode: { supported: true, selected: false },
  };
}
function drainedFetch(
  fetchOptions: (input: {
    provider: 'CLAUDE' | 'CODEX';
    model?: string;
    codexAccountId?: string;
  }) => Promise<SessionLaunchOptions>
) {
  return (input: Parameters<typeof fetchOptions>[0]) => {
    const result = fetchOptions(input);
    return Promise.resolve({
      result,
      drained: result.then(
        () => undefined,
        () => undefined
      ),
    });
  };
}
describe('selected-model launch discovery', () => {
  it('isolates probes for the same model on different Codex accounts', async () => {
    const fetchOptions = vi.fn().mockResolvedValue(native('CODEX', 'model'));
    const service = new SessionLaunchOptionsService({
      fetchOptions: drainedFetch(fetchOptions),
      getSettings: vi.fn().mockResolvedValue({}),
    });
    await Promise.all(
      ['a', 'b', 'a'].map((codexAccountId) =>
        service.getOptions({ provider: 'CODEX', model: 'model', codexAccountId })
      )
    );
    expect(fetchOptions).toHaveBeenCalledTimes(2);
    expect(fetchOptions).toHaveBeenCalledWith({
      provider: 'CODEX',
      model: 'model',
      codexAccountId: 'a',
    });
    expect(fetchOptions).toHaveBeenCalledWith({
      provider: 'CODEX',
      model: 'model',
      codexAccountId: 'b',
    });
  });
  it('coalesces native discovery while applying fresh saved provider defaults', async () => {
    const fetchOptions = vi.fn(({ provider, model }) => Promise.resolve(native(provider, model)));
    const getSettings = vi.fn().mockResolvedValue({
      defaultClaudeReasoningEffort: 'xhigh',
      defaultCodexReasoningEffort: 'unavailable',
    });
    const service = new SessionLaunchOptionsService({
      fetchOptions: drainedFetch(fetchOptions),
      getSettings,
    });
    const [a, b] = await Promise.all([
      service.getOptions({ provider: 'CLAUDE', model: 'sonnet' }),
      service.getOptions({ provider: 'CLAUDE', model: 'sonnet' }),
    ]);
    expect(fetchOptions).toHaveBeenCalledOnce();
    expect(a.reasoning.selected).toBe('xhigh');
    expect(b.reasoning.defaultValue).toBe('low');
    expect(
      (await service.getOptions({ provider: 'CODEX', model: 'codex' })).reasoning.selected
    ).toBe('low');
    getSettings.mockResolvedValue({ defaultClaudeReasoningEffort: 'low' });
    expect(
      (await service.getOptions({ provider: 'CLAUDE', model: 'sonnet' })).reasoning.selected
    ).toBe('low');
    expect(fetchOptions).toHaveBeenCalledTimes(2);
  });
  it('does not cache failures or invent choices', async () => {
    const fetchOptions = vi
      .fn()
      .mockRejectedValueOnce(new Error('Provider unavailable'))
      .mockResolvedValue(native('CLAUDE', 'haiku'));
    const service = new SessionLaunchOptionsService({
      fetchOptions: drainedFetch(fetchOptions),
      getSettings: vi.fn().mockResolvedValue({}),
    });
    await expect(service.getOptions({ provider: 'CLAUDE', model: 'haiku' })).rejects.toThrow(
      'Provider unavailable'
    );
    await expect(service.getOptions({ provider: 'CLAUDE', model: 'haiku' })).resolves.toMatchObject(
      { model: 'haiku' }
    );
    expect(fetchOptions).toHaveBeenCalledTimes(2);
  });
  it('bounds simultaneous probes and releases admission after their lifetimes drain', async () => {
    const pending = createDeferred<SessionLaunchOptions>();
    const fetchOptions = vi.fn().mockReturnValue(pending.promise);
    const service = new SessionLaunchOptionsService({
      fetchOptions: drainedFetch(fetchOptions),
      getSettings: vi.fn().mockResolvedValue({}),
    });
    const running = Array.from({ length: 8 }, (_, index) =>
      service.getOptions({ provider: 'CODEX', model: `model-${index}` })
    );
    await vi.waitFor(() => expect(fetchOptions).toHaveBeenCalledTimes(8));
    await expect(service.getOptions({ provider: 'CODEX', model: 'extra' })).rejects.toThrow('busy');
    pending.resolve(native('CODEX', 'model'));
    await Promise.all(running);
    await service.getOptions({ provider: 'CODEX', model: 'extra' });
    expect(fetchOptions).toHaveBeenCalledTimes(9);
  });

  it('expires after 30 seconds and isolates returned objects', async () => {
    vi.useFakeTimers();
    try {
      const fetchOptions = vi.fn().mockResolvedValue(native('CODEX', 'model'));
      const service = new SessionLaunchOptionsService({
        fetchOptions: drainedFetch(fetchOptions),
        getSettings: vi.fn().mockResolvedValue({}),
      });
      const first = await service.getOptions({ provider: 'CODEX', model: 'model' });
      first.reasoning.options.length = 0;
      expect(
        (await service.getOptions({ provider: 'CODEX', model: 'model' })).reasoning.options
      ).toHaveLength(2);
      vi.advanceTimersByTime(30_001);
      await service.getOptions({ provider: 'CODEX', model: 'model' });
      expect(fetchOptions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest success when the 33rd distinct result is cached', async () => {
    const fetchOptions = vi.fn(({ provider, model }) => Promise.resolve(native(provider, model)));
    const service = new SessionLaunchOptionsService({
      fetchOptions: drainedFetch(fetchOptions),
      getSettings: vi.fn().mockResolvedValue({}),
    });
    for (let i = 0; i < 33; i++) {
      await service.getOptions({ provider: 'CODEX', model: `model-${i}` });
    }
    await service.getOptions({ provider: 'CODEX', model: 'model-1' });
    expect(fetchOptions).toHaveBeenCalledTimes(33);
    await service.getOptions({ provider: 'CODEX', model: 'model-0' });
    expect(fetchOptions).toHaveBeenCalledTimes(34);
  });
});
