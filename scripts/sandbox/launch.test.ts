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

  it('signals its own unreaped server group when ps fails during a stop, and keeps the directory', async () => {
    for (const exitsOnTerm of [true, false]) {
      const h = harness();
      const kills: string[] = [];
      let spawnedServer = false;
      // Never a real process: the injected kill only records.
      const child = Object.assign(new EventEmitter(), {
        pid: 424_242,
        exitCode: null as number | null,
        signalCode: null as string | null,
        stdout: null,
        stderr: null,
      });
      let time = 0;
      const code = await run(
        { scenario: 'echo', keep: false },
        {
          ...h.deps,
          system: {
            ...realSystem,
            // From the server's spawn on, `ps` cannot run.
            listProcesses: () => {
              if (spawnedServer) {
                throw new Error('spawn ps EAGAIN');
              }
              return realSystem.listProcesses();
            },
            now: () => time,
            sleep: (ms: number) => {
              time += ms;
              return Promise.resolve();
            },
          },
          spawnImpl: (_command: string, args: string[]) => {
            h.spawned.push(args);
            spawnedServer = true;
            return child;
          },
          kill: (target: number, signal: string) => {
            kills.push(`${signal} ${target}`);
            if (exitsOnTerm) {
              child.signalCode = signal;
            }
          },
        }
      );
      expect(code).toBe(1);
      expect(kills).toEqual(
        exitsOnTerm ? ['SIGTERM -424242'] : ['SIGTERM -424242', 'SIGKILL -424242']
      );
      // The processes using the directory cannot be checked, so it stays.
      const [dir] = h.sandboxDirs();
      expect(dir).toBeDefined();
      expect(h.logs.join('\n')).toContain(
        `kept ${join(h.root, dir ?? '')}: run pnpm dev:sandbox --clean once ps works`
      );
    }
  }, 60_000);

  it('signals its own unreaped server group when only the environment listing fails during a stop', async () => {
    const h = harness();
    const kills: string[] = [];
    // A real group, so the process listing finds members; nothing is signalled
    // for real, the injected kill only records.
    const group = spawnSleeper();
    try {
      let spawnedServer = false;
      let hidLeader = false;
      const child = Object.assign(new EventEmitter(), {
        pid: group.pid,
        exitCode: null as number | null,
        signalCode: null as string | null,
        stdout: null,
        stderr: null,
      });
      const code = await run(
        { scenario: 'echo', keep: false },
        {
          ...h.deps,
          system: {
            ...realSystem,
            // The first listing after the spawn misses the leader, so its start
            // time is never recorded and stopping must read environments.
            listProcesses: () => {
              const processes = realSystem.listProcesses();
              if (spawnedServer && !hidLeader) {
                hidLeader = true;
                return processes.filter((p) => p.pid !== group.pid);
              }
              return processes;
            },
            processesWithEnvironment: () => {
              throw new Error('spawn ps EAGAIN');
            },
          },
          spawnImpl: (_command: string, args: string[]) => {
            h.spawned.push(args);
            spawnedServer = true;
            setTimeout(() => child.emit('exit', 1, null), 50);
            return child;
          },
          kill: (target: number, signal: string) => {
            kills.push(`${signal} ${target}`);
            child.signalCode = signal;
          },
        }
      );
      expect(code).toBe(1);
      expect(kills).toEqual([`SIGTERM -${group.pid}`]);
      const [dir] = h.sandboxDirs();
      expect(dir).toBeDefined();
      expect(h.logs.join('\n')).toContain(
        `kept ${join(h.root, dir ?? '')}: run pnpm dev:sandbox --clean once ps works`
      );
    } finally {
      group.kill('SIGKILL');
    }
  }, 60_000);

  it('signals nothing when ps fails during a stop and its server has already exited', async () => {
    const h = harness();
    const kills: string[] = [];
    let spawnedServer = false;
    // Reaped already: Node has recorded its exit code.
    const child = Object.assign(new EventEmitter(), {
      pid: 424_242,
      exitCode: 1,
      signalCode: null,
      stdout: null,
      stderr: null,
    });
    const code = await run(
      { scenario: 'echo', keep: false },
      {
        ...h.deps,
        system: {
          ...realSystem,
          listProcesses: () => {
            if (spawnedServer) {
              throw new Error('spawn ps EAGAIN');
            }
            return realSystem.listProcesses();
          },
        },
        spawnImpl: () => {
          spawnedServer = true;
          return child;
        },
        kill: (target: number, signal: string) => kills.push(`${signal} ${target}`),
      }
    );
    expect(code).toBe(1);
    expect(kills).toEqual([]);
    const [dir] = h.sandboxDirs();
    expect(h.logs.join('\n')).toContain(
      `kept ${join(h.root, dir ?? '')}: run pnpm dev:sandbox --clean once ps works`
    );
    // The egress recorder is closed on this path too.
    const record = readSandboxRecord(join(h.root, dir ?? '', 'sandbox.json'));
    const response = await fetch(`http://127.0.0.1:${record?.egressPort}/`).then(
      () => 'answered',
      () => 'refused'
    );
    expect(response).toBe('refused');
  }, 60_000);

  it('treats one port found twice as a failed attempt and retries', async () => {
    const h = harness();
    // The first attempt's probes return the same port; the second's differ.
    const ports = [42_001, 42_001, 42_002, 42_003];
    const code = await run(
      { scenario: 'echo', keep: false },
      {
        ...h.deps,
        findPort: () => Promise.resolve(ports.shift() ?? 0),
        spawnImpl: failingSpawn(h.spawned),
      }
    );
    // The retry reached the server: one spawn, on the fresh pair.
    expect(code).toBe(1);
    expect(h.spawned).toHaveLength(1);
    const args = h.spawned[0] ?? [];
    expect([args[args.indexOf('--port') + 1], args[args.indexOf('--backend-port') + 1]]).toEqual([
      '42002',
      '42003',
    ]);
    expect(h.logs).toContain(
      'attempt 1: port discovery returned 42001 twice; retrying with fresh ports'
    );
    expect(h.sandboxDirs()).toEqual([]);
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
