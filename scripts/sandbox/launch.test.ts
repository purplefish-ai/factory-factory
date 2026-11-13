import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_PORT_ATTEMPTS, run } from './launch.mjs';
import { findProcess, realSystem } from './process-group.mjs';
import { readSandboxRecord } from './record.mjs';
import { launch, launcherEnv, spawnSleeper, temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

type Handler = () => void;

/** In-process launcher dependencies; signals are captured, never installed. */
function harness() {
  const tempDir = temporary.create('ffsb-');
  const root = join(tempDir, 'ff-sandbox');
  const handlers = new Map<string, Handler>();
  const logs: string[] = [];
  const spawned: string[][] = [];
  let nextPort = 41_000;
  return {
    tempDir,
    root,
    logs,
    spawned,
    handlers,
    deps: {
      root,
      tempDir,
      parentEnv: { PATH: process.env.PATH },
      system: realSystem,
      onSignal: (signal: string, handler: Handler) => handlers.set(signal, handler),
      log: (text: string) => logs.push(text),
      print: () => undefined,
      findPort: () => {
        nextPort += 1;
        return Promise.resolve(nextPort);
      },
      startupTimeoutMs: 20_000,
    },
    sandboxDirs: () => (existsSync(root) ? readdirSync(root) : []),
  };
}

/** A child process that never started: no pid, and an `'error'` on the next tick. */
function failingSpawn(spawned: string[][]) {
  return (_command: string, args: string[]) => {
    spawned.push(args);
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: null, stderr: null });
    setImmediate(() => child.emit('error', new Error('spawn node ENOENT')));
    return child;
  };
}

describe('launcher setup and shutdown', () => {
  it('records the sandbox and handles a signal before any other setup', async () => {
    const h = harness();
    let recordAtSignal: unknown = 'unread';
    const run1 = run(
      { scenario: 'echo', keep: false },
      {
        ...h.deps,
        // The first port is chosen after the recorder starts and the repository is seeded.
        findPort: () => {
          const [dir] = h.sandboxDirs();
          recordAtSignal = dir ? readSandboxRecord(join(h.root, dir, 'sandbox.json')) : null;
          h.handlers.get('SIGTERM')?.();
          return h.deps.findPort();
        },
        spawnImpl: failingSpawn(h.spawned),
      }
    );
    expect(await run1).toBe(143);
    expect(recordAtSignal).toMatchObject({ pid: process.pid, pgid: null, pgidStartedAt: null });
    expect(h.spawned).toEqual([]);
    expect(h.sandboxDirs()).toEqual([]);

    // A signal during the very first step creates nothing at all.
    const h2 = harness();
    const run2 = run(
      { scenario: 'echo', keep: false },
      {
        ...h2.deps,
        system: {
          ...realSystem,
          listProcesses: () => {
            h2.handlers.get('SIGINT')?.();
            return realSystem.listProcesses();
          },
        },
      }
    );
    expect(await run2).toBe(130);
    expect(h2.sandboxDirs()).toEqual([]);
  }, 60_000);

  it('stops and cleans up when the server cannot be spawned', async () => {
    const h = harness();
    const code = await run(
      { scenario: 'echo', keep: false },
      { ...h.deps, spawnImpl: failingSpawn(h.spawned) }
    );
    expect(code).toBe(1);
    expect(h.spawned).toHaveLength(1);
    expect(h.logs.join('\n')).toContain('the server could not be started: spawn node ENOENT');
    expect(h.sandboxDirs()).toEqual([]);
  }, 60_000);

  it('records the server group before reading the process table, then its start time', async () => {
    const h = harness();
    // Stands in for the server: a real process group, so stopping it is real.
    const group = spawnSleeper();
    try {
      const recordsAtListing: unknown[] = [];
      let spawnedServer = false;
      const spawnImpl = (_command: string, args: string[]) => {
        h.spawned.push(args);
        spawnedServer = true;
        const child = Object.assign(new EventEmitter(), {
          pid: group.pid,
          stdout: new EventEmitter(),
          stderr: null,
        });
        setTimeout(() => child.emit('exit', 1, null), 50);
        return child;
      };
      const listProcesses = () => {
        if (spawnedServer && recordsAtListing.length === 0) {
          const [dir] = h.sandboxDirs();
          recordsAtListing.push(dir ? readSandboxRecord(join(h.root, dir, 'sandbox.json')) : null);
        }
        return realSystem.listProcesses();
      };
      const code = await run(
        { scenario: 'echo', keep: false },
        { ...h.deps, system: { ...realSystem, listProcesses }, spawnImpl }
      );
      expect(code).toBe(1);
      // A SIGKILL at the first `ps` after spawning finds the group recorded.
      expect(recordsAtListing).toEqual([
        expect.objectContaining({ pgid: group.pid, pgidStartedAt: null }),
      ]);
      // The start time was then recorded and used: the group was stopped.
      expect(findProcess(realSystem.listProcesses(), group.pid ?? 0)).toBeNull();
      expect(h.sandboxDirs()).toEqual([]);
    } finally {
      group.kill('SIGKILL');
    }
  }, 60_000);

  it('retries with fresh ports when the server reports others, then fails naming both', async () => {
    const h = harness();
    // Each attempt's backend reports the next port up, as `ff serve` does when its port was taken.
    const spawnImpl = (_command: string, args: string[]) => {
      h.spawned.push(args);
      const stdout = new EventEmitter();
      const child = Object.assign(new EventEmitter(), { pid: undefined, stdout, stderr: null });
      const requested = Number(args[args.indexOf('--backend-port') + 1]);
      setImmediate(() => stdout.emit('data', Buffer.from(`BACKEND_PORT:${requested + 1}\n`)));
      return child;
    };
    const code = await run({ scenario: 'echo', keep: false }, { ...h.deps, spawnImpl });
    expect(code).toBe(1);
    expect(h.spawned).toHaveLength(MAX_PORT_ATTEMPTS);
    const backendPorts = h.spawned.map((args) => args[args.indexOf('--backend-port') + 1]);
    expect(new Set(backendPorts).size).toBe(MAX_PORT_ATTEMPTS);
    const last = Number(backendPorts.at(-1));
    expect(h.logs.join('\n')).toContain(
      `in ${MAX_PORT_ATTEMPTS} attempts (last: requested backend port ${last} but the server reported ${last + 1})`
    );
    expect(h.sandboxDirs()).toEqual([]);
  }, 60_000);
});

describe('the real launcher', () => {
  it('removes its directory when signalled during setup', async () => {
    const tempDir = temporary.create('ffsb-');
    const root = join(tempDir, 'ff-sandbox');
    const sandbox = launch(['--owner-pid', String(process.pid)], launcherEnv(tempDir));
    // Signal as soon as the directory exists, long before the server is up.
    while (!(existsSync(root) && readdirSync(root).length > 0) && sandbox.child.exitCode === null) {
      await realSystem.sleep(2);
    }
    sandbox.child.kill('SIGTERM');
    expect(await sandbox.exited).toBe(143);
    expect(readdirSync(root)).toEqual([]);
  }, 120_000);

  it('a launcher exits after its owner is killed', async () => {
    const tempDir = temporary.create('ffsb-');
    const root = join(tempDir, 'ff-sandbox');
    const owner = spawnSleeper();
    const sandbox = launch(['--owner-pid', String(owner.pid)], launcherEnv(tempDir));
    try {
      while (
        !(existsSync(root) && readdirSync(root).length > 0) &&
        sandbox.child.exitCode === null
      ) {
        await realSystem.sleep(20);
      }
      expect(findProcess(realSystem.listProcesses(), sandbox.child.pid ?? 0)).not.toBeNull();
      owner.kill('SIGKILL');
      expect(await sandbox.exited).toBe(0);
      expect(sandbox.output()).toContain(`stopping (owner process ${owner.pid} exited)`);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      owner.kill('SIGKILL');
      sandbox.child.kill('SIGKILL');
    }
  }, 180_000);
});
