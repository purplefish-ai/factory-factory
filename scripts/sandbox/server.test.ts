import { EventEmitter } from 'node:events';
import { readFileSync, rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { sandboxPaths } from './paths.mjs';
import { signalOwnServerGroup, startServer } from './server.mjs';
import { temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

describe('the sandbox server process', () => {
  it('drops output that arrives after the sandbox directory is gone', () => {
    const paths = sandboxPaths(temporary.create('ffsb-'));
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout, stderr });
    const server = startServer({
      paths,
      env: {},
      ports: { frontend: 41_001, backend: 41_002 },
      onExit: () => undefined,
      onError: () => undefined,
      spawnImpl: () => child,
    });
    stdout.emit('data', Buffer.from('BACKEND_PORT:41002\n'));
    expect(readFileSync(paths.serverOutput, 'utf8')).toBe('BACKEND_PORT:41002\n');
    expect(server.backendPort).toBe(41_002);
    // The launcher deletes the directory once the group has stopped; the pipes
    // can still deliver what the server wrote before it exited.
    rmSync(paths.baseDir, { recursive: true, force: true });
    expect(() => stdout.emit('data', Buffer.from('late output\n'))).not.toThrow();
    expect(() => stderr.emit('data', Buffer.from('late error\n'))).not.toThrow();
  });
});

/** A spawned child as Node reports it: `exitCode`/`signalCode` stay null until it is reaped. */
function childProcess(pid = 424_242) {
  return { pid, exitCode: null as number | null, signalCode: null as string | null };
}

/** A clock that advances only when the code under test sleeps. */
function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: (ms: number) => {
      time += ms;
      return Promise.resolve();
    },
  };
}

describe('stopping the launcher’s own server without a process listing', () => {
  it('signals the group of its unreaped child, escalating after the grace period', async () => {
    const polite = childProcess();
    const politeKills: string[] = [];
    const stopped = await signalOwnServerGroup(polite, {
      system: clock(),
      kill: (target: number, signal: string) => {
        politeKills.push(`${signal} ${target}`);
        // Node reaps the leader and records how it ended in one step.
        polite.signalCode = signal;
      },
    });
    expect(stopped).toBe(true);
    expect(politeKills).toEqual(['SIGTERM -424242']);

    const stubborn = childProcess();
    const stubbornKills: string[] = [];
    await signalOwnServerGroup(stubborn, {
      system: clock(),
      graceMs: 1000,
      kill: (target: number, signal: string) => stubbornKills.push(`${signal} ${target}`),
    });
    expect(stubbornKills).toEqual(['SIGTERM -424242', 'SIGKILL -424242']);
  });

  it('signals nothing once the child has been reaped', async () => {
    const kills: string[] = [];
    const kill = (target: number, signal: string) => kills.push(`${signal} ${target}`);
    const exited = { ...childProcess(), exitCode: 1 };
    const killed = { ...childProcess(), signalCode: 'SIGTERM' };
    expect(await signalOwnServerGroup(exited, { system: clock(), kill })).toBe(false);
    expect(await signalOwnServerGroup(killed, { system: clock(), kill })).toBe(false);
    expect(await signalOwnServerGroup(null, { system: clock(), kill })).toBe(false);
    expect(kills).toEqual([]);
  });
});
