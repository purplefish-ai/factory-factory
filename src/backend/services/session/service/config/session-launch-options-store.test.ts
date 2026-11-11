import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchOptionsStore } from './session-launch-options-store';

const roots: string[] = [];
afterEach(async () => {
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
  it('serializes writes so the newest snapshot wins', async () => {
    const { store, path } = await fixture();
    await Promise.all([store.save(entries), store.save([])]);
    expect(await store.load()).toEqual([]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, entries: [] });
  });
});
