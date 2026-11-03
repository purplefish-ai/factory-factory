import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareRecordStore, type StaleShareDependencies } from './share-records';

describe.skipIf(process.platform === 'win32')('ShareRecordStore', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ff-port-shares-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function dependencies(overrides: Partial<StaleShareDependencies> = {}): StaleShareDependencies {
    return {
      isRunning: vi.fn(async () => false),
      listProcesses: vi.fn(async () => [
        {
          pgid: 4242,
          args: '/bin/sh /usr/local/bin/tailscale serve --https=6173 http://127.0.0.1:50123',
        },
        { pgid: 4242, args: 'Tailscale serve --https=6173 http://127.0.0.1:50123' },
        { pgid: 5000, args: 'node unrelated.js' },
      ]),
      killGroup: vi.fn(),
      ...overrides,
    };
  }

  it('records shares per owner and removes the file when none remain', async () => {
    const store = new ShareRecordStore(directory, 111);
    await store.write([{ pgid: 4242, httpsPort: 6173, forwarderPort: 50_123 }]);
    expect(JSON.parse(await readFile(join(directory, '111.json'), 'utf8'))).toEqual({
      ownerPid: 111,
      shares: [{ pgid: 4242, httpsPort: 6173, forwarderPort: 50_123 }],
    });
    await store.write([]);
    expect(await readdir(directory)).toEqual([]);
  });

  it('stops Serve groups left by a backend that is no longer running', async () => {
    await new ShareRecordStore(directory, 111).write([
      { pgid: 4242, httpsPort: 6173, forwarderPort: 50_123 },
    ]);
    const deps = dependencies();
    const stopped = await new ShareRecordStore(directory, 222).stopStaleShares(deps);
    expect(stopped).toBe(1);
    expect(deps.killGroup).toHaveBeenCalledWith(4242);
    expect(await readdir(directory)).toEqual([]);
  });

  it('leaves shares of running backends and reused process groups alone', async () => {
    await new ShareRecordStore(directory, 111).write([
      { pgid: 4242, httpsPort: 6173, forwarderPort: 50_123 },
    ]);
    const running = dependencies({ isRunning: vi.fn(async () => true) });
    expect(await new ShareRecordStore(directory, 222).stopStaleShares(running)).toBe(0);
    expect(await readdir(directory)).toEqual(['111.json']);

    const reused = dependencies({
      listProcesses: vi.fn(async () => [{ pgid: 4242, args: 'vim notes.txt' }]),
    });
    expect(await new ShareRecordStore(directory, 222).stopStaleShares(reused)).toBe(0);
    expect(reused.killGroup).not.toHaveBeenCalled();
  });

  it('discards unreadable record files', async () => {
    await writeFile(join(directory, '333.json'), 'not json');
    const deps = dependencies();
    expect(await new ShareRecordStore(directory, 222).stopStaleShares(deps)).toBe(0);
    expect(await readdir(directory)).toEqual([]);
  });
});
