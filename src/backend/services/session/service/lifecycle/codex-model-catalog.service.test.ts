import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexModelCatalogService } from './codex-model-catalog.service';
import { createDeferred } from './session-lifecycle.test-helpers';

function catalog() {
  return [
    {
      id: 'codex-test',
      displayName: 'Codex Test',
      description: 'Test model',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
      inputModalities: ['text'],
      isDefault: true,
    },
  ];
}

describe('CodexModelCatalogService', () => {
  it('isolates concurrent and cached catalogs by saved account', async () => {
    const fetchModels = vi.fn(async () => catalog());
    const service = new CodexModelCatalogService({ fetchModels });
    await Promise.all([service.getModels('a'), service.getModels('b'), service.getModels('a')]);
    await service.getModels('a');
    await service.getModels('b');
    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(fetchModels).toHaveBeenCalledWith('a');
    expect(fetchModels).toHaveBeenCalledWith('b');
  });
  it('discovers Auto models across accounts and reuses their isolated caches', async () => {
    const fetchModels = vi.fn(async (id?: string) => [{ ...catalog()[0]!, id: `model-${id}` }]);
    const service = new CodexModelCatalogService({
      fetchModels,
      listAccountIds: async () => ['a', 'b'],
    });
    await expect(service.getModels()).resolves.toMatchObject([
      { id: 'model-a' },
      { id: 'model-b' },
    ]);
    await service.getModels();
    await service.getModels('b');
    expect(fetchModels.mock.calls).toEqual([['a'], ['b']]);
  });
  it('keeps available Auto catalogs when another account probe fails', async () => {
    const fetchModels = vi.fn((id?: string) => {
      if (id === 'broken') {
        return Promise.reject(new Error('Account unavailable'));
      }
      return Promise.resolve(catalog());
    });
    const service = new CodexModelCatalogService({
      fetchModels,
      listAccountIds: async () => ['broken', 'a'],
    });
    await expect(service.getModels()).resolves.toEqual(catalog());
    await expect(service.getModels('broken')).rejects.toThrow('Account unavailable');
  });
  it('fails Auto discovery when no account catalog is available', async () => {
    const service = new CodexModelCatalogService({
      fetchModels: vi.fn(),
      listAccountIds: async () => [],
    });
    await expect(service.getModels()).rejects.toThrow('No enabled Codex account');
  });
  afterEach(() => vi.useRealTimers());

  it('shares discovery across concurrent consumers', async () => {
    const pending = createDeferred<ReturnType<typeof catalog>>();
    const fetchModels = vi.fn(() => pending.promise);
    const service = new CodexModelCatalogService({ fetchModels });

    const first = service.getModels();
    const second = service.getModels();
    pending.resolve(catalog());

    await expect(first).resolves.toEqual(catalog());
    await expect(second).resolves.toEqual(catalog());
    expect(fetchModels).toHaveBeenCalledOnce();
  });

  it('keeps successful discovery for 30 seconds from completion', async () => {
    vi.useFakeTimers();
    const pending = createDeferred<ReturnType<typeof catalog>>();
    const fetchModels = vi.fn(() => pending.promise);
    const service = new CodexModelCatalogService({ fetchModels });
    const first = service.getModels();
    await vi.advanceTimersByTimeAsync(5000);
    pending.resolve(catalog());
    await first;

    await vi.advanceTimersByTimeAsync(29_999);
    await expect(service.getModels()).resolves.toEqual(catalog());
    expect(fetchModels).toHaveBeenCalledOnce();
    fetchModels.mockResolvedValue([{ ...catalog()[0]!, id: 'new-model' }]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(service.getModels()).resolves.toMatchObject([{ id: 'new-model' }]);
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it('shares discovery failures and retries on the next request', async () => {
    const pending = createDeferred<ReturnType<typeof catalog>>();
    const fetchModels = vi.fn(() => pending.promise);
    const service = new CodexModelCatalogService({ fetchModels });
    const first = service.getModels();
    const second = service.getModels();
    const error = new Error('Codex unavailable');
    const results = Promise.allSettled([first, second]);
    pending.reject(error);
    await expect(results).resolves.toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    expect(fetchModels).toHaveBeenCalledOnce();

    fetchModels.mockResolvedValue(catalog());
    await expect(service.getModels()).resolves.toEqual(catalog());
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it('retries after a synchronous discovery error', async () => {
    const fetchModels = vi
      .fn<() => Promise<ReturnType<typeof catalog>>>()
      .mockImplementationOnce(() => {
        throw new Error('Failed to spawn');
      })
      .mockResolvedValue(catalog());
    const service = new CodexModelCatalogService({ fetchModels });

    await expect(service.getModels()).rejects.toThrow('Failed to spawn');
    await expect(service.getModels()).resolves.toEqual(catalog());
    expect(fetchModels).toHaveBeenCalledTimes(2);
  });

  it('isolates cached models from the loader and every consumer', async () => {
    const loaded = catalog();
    const service = new CodexModelCatalogService({ fetchModels: vi.fn(async () => loaded) });
    const [first, second] = await Promise.all([service.getModels(), service.getModels()]);

    loaded[0]!.displayName = 'Mutated loader';
    first[0]!.supportedReasoningEfforts[0]!.description = 'Mutated consumer';
    first[0]!.inputModalities.push('image');
    first.push({ ...catalog()[0]!, id: 'mutated-model' });
    expect(second).toEqual(catalog());
    const cached = await service.getModels();
    expect(cached).toEqual(catalog());
    cached[0]!.supportedReasoningEfforts[0]!.description = 'Mutated cache hit';
    await expect(service.getModels()).resolves.toEqual(catalog());
  });

  it('rejects an expired refresh failure and retries without serving stale models', async () => {
    vi.useFakeTimers();
    const fetchModels = vi.fn().mockResolvedValue(catalog());
    const service = new CodexModelCatalogService({ fetchModels });
    await service.getModels();
    await vi.advanceTimersByTimeAsync(30_000);
    fetchModels.mockRejectedValueOnce(new Error('Refresh unavailable'));

    await expect(service.getModels()).rejects.toThrow('Refresh unavailable');
    fetchModels.mockResolvedValue([{ ...catalog()[0]!, id: 'new-model' }]);
    await expect(service.getModels()).resolves.toMatchObject([{ id: 'new-model' }]);
    expect(fetchModels).toHaveBeenCalledTimes(3);
  });

  it('caches an empty successful catalog', async () => {
    const fetchModels = vi.fn(async () => []);
    const service = new CodexModelCatalogService({ fetchModels });

    await expect(service.getModels()).resolves.toEqual([]);
    await expect(service.getModels()).resolves.toEqual([]);
    expect(fetchModels).toHaveBeenCalledOnce();
  });
});
