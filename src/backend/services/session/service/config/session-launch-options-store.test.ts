import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@/test-utils/deferred';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
  };
});
import { LaunchOptionsStore } from './session-launch-options-store';

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(mkdir).mockReset();
  vi.mocked(writeFile).mockReset();
  vi.mocked(rename).mockReset();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'launch-cache-'));
  roots.push(root);
  const path = join(root, 'cache', 'launch-options.json');
  return { store: new LaunchOptionsStore(path), path };
}
const entries = [
  {
    input: { provider: 'CLAUDE' as const, model: 'opus' },
    capturedAt: 123,
    value: {
      provider: 'CLAUDE' as const,
      model: 'opus',
      reasoning: { options: [] },
      planMode: { supported: true, selected: false },
    },
  },
];
describe('durable launcher options', () => {
  it('restores successful capabilities in a new store instance', async () => {
    const { store, path } = await fixture();
    expect(await store.load()).toEqual([]);
    await store.save(entries);
    expect(await new LaunchOptionsStore(path).load()).toEqual(entries);
  });
  it('writes capability metadata only, never a runtime environment', async () => {
    const { store, path } = await fixture();
    const input = { provider: 'CLAUDE' as const, model: 'opus', env: { CODEX_HOME: '/secret' } };
    await store.save(entries.map((entry) => ({ ...entry, input })));
    expect(await readFile(path, 'utf8')).not.toContain('secret');
    expect(await store.load()).toEqual(entries);
  });
  it('rejects corrupt data and unsupported versions', async () => {
    const { store, path } = await fixture();
    await store.save(entries);
    for (const data of [
      'invalid JSON',
      JSON.stringify({ version: 2, entries }),
      JSON.stringify({ version: 1, entries: [{ ...entries[0], value: {} }] }),
    ]) {
      await writeFile(path, data);
      expect(await store.load()).toEqual([]);
    }
  });
  it('serializes writes even when the first rename is blocked', async () => {
    const { store } = await fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rename)
      .mockResolvedValue(undefined)
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
      });
    const first = store.save(entries);
    await entered.promise;
    const second = store.save([]);
    try {
      // Filesystem operations are resolved mocks: a complete event-loop turn
      // drains every runnable continuation, without relying on disk timing.
      await new Promise((resolve) => setImmediate(resolve));
      expect(rename).toHaveBeenCalledTimes(1);
      expect(writeFile).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    expect(rename).toHaveBeenCalledTimes(2);
    expect(vi.mocked(writeFile).mock.calls[1]?.[1]).toBe(
      JSON.stringify({ version: 1, entries: [] })
    );
  });

  it('keeps valid entries when another entry exceeds the option bound', async () => {
    const { store } = await fixture();
    const valid = entries[0]!;
    const oversized = {
      ...valid,
      value: {
        ...valid.value,
        reasoning: {
          options: Array.from({ length: 129 }, (_, i) => ({ value: String(i), label: String(i) })),
        },
      },
    };
    await store.save([oversized, valid]);
    expect(await store.load()).toEqual(entries);
  });

  it('drops the oldest entries so a large snapshot still loads after restart', async () => {
    const { store, path } = await fixture();
    // About 100 KiB per entry: twelve entries exceed what load() reads back.
    const large = Array.from({ length: 12 }, (_, i) => ({
      ...entries[0]!,
      input: { provider: 'CLAUDE' as const, model: `model-${i}` },
      value: {
        ...entries[0]!.value,
        model: `model-${i}`,
        reasoning: {
          options: Array.from({ length: 100 }, (_unused, j) => ({
            value: `level-${j}`,
            label: `Level ${j}`,
            description: 'x'.repeat(1000),
          })),
        },
      },
    }));
    await store.save(large);
    const restored = await new LaunchOptionsStore(path).load();
    expect(restored.length).toBeGreaterThan(0);
    expect(restored.length).toBeLessThan(large.length);
    expect(restored.map((entry) => entry.input.model)).toEqual(
      large.slice(-restored.length).map((entry) => entry.input.model)
    );
  });
  it('rejects snapshots above the entry bound asynchronously', async () => {
    const { store } = await fixture();
    const invalid = Array.from({ length: 129 }, () => entries[0]!);
    let writing: Promise<void> | undefined;
    expect(() => {
      writing = store.save(invalid);
    }).not.toThrow();
    await expect(writing).rejects.toThrow();
  });
});
