import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import type { SessionLaunchOptions } from '@/shared/session-launch';
import type { StoredLaunchOptions } from './session-launch-options-store';
import { SessionLaunchOptionsService } from './session-launch-options.service';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock('@/backend/services/logger.service', () => ({ createLogger: () => logs }));

type Input = { provider: 'CLAUDE' | 'CODEX'; model?: string; codexAccountId?: string };
type Select = (models: readonly string[]) => readonly string[];

/** Directly discovered options know the model's thinking default. */
function direct(model: string): SessionLaunchOptions {
  return {
    provider: 'CLAUDE',
    model,
    reasoning: { options: [{ value: 'high', label: 'High' }], defaultValue: 'high' },
    planMode: { supported: true, selected: false },
  };
}
/** Swept options only list the choices. */
function swept(model: string): SessionLaunchOptions {
  return {
    provider: 'CLAUDE',
    model,
    reasoning: { options: [{ value: 'low', label: 'Low' }] },
    planMode: { supported: false, selected: false },
  };
}

const ADVERTISED = ['opus', 'sonnet', 'haiku'];

function fixture(
  sweep: (input: Input, select: Select) => Promise<SessionLaunchOptions[]> = (input, select) =>
    Promise.resolve(select(ADVERTISED.filter((model) => model !== input.model)).map(swept))
) {
  const selections: string[][] = [];
  const fetchOptions = vi.fn((input: Input, _signal?: AbortSignal, select?: Select) => {
    const choose: Select = (models) => {
      const chosen = select?.(models) ?? [];
      selections.push([...chosen]);
      return chosen;
    };
    const additional = sweep(input, choose);
    return Promise.resolve({
      result: Promise.resolve(direct(input.model ?? 'opus')),
      additional,
      drained: additional.then(() => undefined),
    });
  });
  const save = vi.fn<(entries: StoredLaunchOptions[]) => Promise<void>>(() => Promise.resolve());
  const service = new SessionLaunchOptionsService({
    fetchOptions,
    getSettings: () => Promise.resolve({}),
    store: { load: () => Promise.resolve([]), save },
  });
  return { service, fetchOptions, selections, save };
}

describe('launch discovery model sweep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves swept models from cache and refreshes them precisely in the background', async () => {
    const f = fixture();
    await f.service.getOptions({ provider: 'CLAUDE', model: 'opus' });
    await vi.advanceTimersByTimeAsync(0);
    // The requested model is already pending, so it is never swept.
    expect(f.selections).toEqual([['sonnet', 'haiku']]);

    expect(await f.service.getOptions({ provider: 'CLAUDE', model: 'sonnet' })).toEqual(
      swept('sonnet')
    );
    // Returned from cache; the first use starts a direct refresh without waiting for it.
    expect(f.fetchOptions).toHaveBeenCalledTimes(2);
    expect(f.fetchOptions.mock.calls[1]?.[0]).toEqual({ provider: 'CLAUDE', model: 'sonnet' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.service.getOptions({ provider: 'CLAUDE', model: 'sonnet' })).toEqual(
      direct('sonnet')
    );
    // Everything advertised is cached now, so the refresh swept nothing.
    expect(f.selections[1]).toEqual([]);
    expect(f.fetchOptions).toHaveBeenCalledTimes(2);
  });

  it('persists swept models so they survive a restart', async () => {
    const f = fixture();
    await f.service.getOptions({ provider: 'CLAUDE', model: 'opus' });
    await vi.advanceTimersByTimeAsync(0);
    const saved = f.save.mock.calls.at(-1)?.[0].map((entry) => entry.input.model);
    expect(saved).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('never replaces a model discovered directly while the sweep was running', async () => {
    const sweepResult = createDeferred<SessionLaunchOptions[]>();
    const f = fixture((input, select) => {
      if (input.model !== 'opus') {
        return Promise.resolve([]);
      }
      // Sonnet is chosen before its direct discovery and captured after it.
      const chosen = select(['sonnet']);
      return sweepResult.promise.then(() => chosen.map(swept));
    });
    await f.service.getOptions({ provider: 'CLAUDE', model: 'opus' });
    expect(f.selections).toEqual([['sonnet']]);
    await f.service.getOptions({ provider: 'CLAUDE', model: 'sonnet' });
    sweepResult.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.service.getOptions({ provider: 'CLAUDE', model: 'sonnet' })).toEqual(
      direct('sonnet')
    );
  });

  it('keeps swept models separate per Codex account', async () => {
    const f = fixture((input, select) =>
      Promise.resolve(
        select(['a', 'b'].filter((model) => model !== input.model)).map((model) => ({
          ...swept(model),
          provider: 'CODEX' as const,
        }))
      )
    );
    await f.service.getOptions({ provider: 'CODEX', model: 'a', codexAccountId: 'one' });
    await vi.advanceTimersByTimeAsync(0);
    await f.service.getOptions({ provider: 'CODEX', model: 'b', codexAccountId: 'one' });
    expect(f.fetchOptions.mock.calls.map(([input]) => input)).toEqual([
      { provider: 'CODEX', model: 'a', codexAccountId: 'one' },
      // Stale swept entry: served from cache, refreshed in the background.
      { provider: 'CODEX', model: 'b', codexAccountId: 'one' },
    ]);
    await f.service.getOptions({ provider: 'CODEX', model: 'b', codexAccountId: 'two' });
    expect(f.fetchOptions).toHaveBeenCalledTimes(3);
  });

  it('sweeps only into free cache capacity, keeping a slot for the requested model', async () => {
    // Record what each probe may sweep, without caching anything extra.
    const f = fixture((_input, select) => {
      select(['w', 'x', 'y', 'z']);
      return Promise.resolve([]);
    });
    for (let i = 0; i < 128; i++) {
      await f.service.getOptions({ provider: 'CODEX', model: `model-${i}` });
    }
    // Probe i runs with i cached entries and reserves one slot for its own result.
    expect(f.selections[0]).toEqual(['w', 'x', 'y', 'z']);
    expect(f.selections[125]).toEqual(['w', 'x']);
    expect(f.selections[126]).toEqual(['w']);
    expect(f.selections[127]).toEqual([]);
  });
});
