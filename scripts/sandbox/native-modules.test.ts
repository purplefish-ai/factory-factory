import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ensureNativeModules } from './native-modules.mjs';

type FakeChild = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  stdout: EventEmitter;
};

/** A stand-in for the build script's process: prints `stdout`, then closes unless `code` is null. */
function fakeBuild(stdout: string, code: number | null = 0) {
  const calls: { args: string[]; options: object }[] = [];
  const children: FakeChild[] = [];
  const spawnImpl = (_command: string, args: string[], options: object) => {
    calls.push({ args, options });
    const child: FakeChild = Object.assign(new EventEmitter(), {
      pid: 5150,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
    });
    children.push(child);
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      if (code !== null) {
        child.emit('close', code, null);
      }
    });
    return child;
  };
  return { spawnImpl, calls, children };
}

/** A clock that fires only when a test says so. */
function manualTimers() {
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  return {
    timers,
    schedule: (run: () => void, ms: number) => timers.push({ run, ms, cleared: false }) - 1,
    cancel: (id: number) => {
      const timer = timers[id];
      if (timer) {
        timer.cleared = true;
      }
    },
  };
}

const quiet = { write: () => undefined };

describe('building the native modules', () => {
  it('reports a rebuild, and nothing to do when the script says so', async () => {
    const rebuild = fakeBuild('Switching native modules: unknown -> node\n');
    expect(
      await ensureNativeModules({ spawnImpl: rebuild.spawnImpl, output: quiet, kill: () => 0 })
    ).toEqual({ rebuilt: true });
    expect(rebuild.calls[0]?.args.slice(-1)).toEqual(['node']);

    const nothing = fakeBuild('Native modules already built for node (ABI 147)\n');
    expect(
      await ensureNativeModules({ spawnImpl: nothing.spawnImpl, output: quiet, kill: () => 0 })
    ).toEqual({ rebuilt: false });
  });

  it('forwards the script output and rejects when it fails', async () => {
    const written: string[] = [];
    const failing = fakeBuild('pnpm rebuild failed\n', 1);
    await expect(
      ensureNativeModules({
        spawnImpl: failing.spawnImpl,
        output: { write: (chunk: string | Buffer) => written.push(String(chunk)) },
        kill: () => 0,
      })
    ).rejects.toThrow('Building the native modules failed (exit code 1)');
    expect(written).toEqual(['pnpm rebuild failed\n']);
  });

  describe('when aborted', () => {
    function abortable(options: Partial<Parameters<typeof ensureNativeModules>[0]> = {}) {
      const build = fakeBuild('', null);
      const kills: string[] = [];
      const clock = manualTimers();
      const abort = new AbortController();
      const result = ensureNativeModules({
        signal: abort.signal,
        spawnImpl: build.spawnImpl,
        output: quiet,
        kill: (target: number, signal: string) => kills.push(`${signal} ${target}`),
        schedule: clock.schedule,
        cancel: clock.cancel,
        graceMs: 1000,
        ...options,
      });
      // Settled by the tests that expect it; the rest read the outcome here.
      const outcome = result.then(
        () => 'resolved',
        (error: Error) => error.message
      );
      return { build, kills, clock, abort, outcome, child: () => build.children[0] as FakeChild };
    }

    it('runs in its own process group and signals the whole group of an unreaped build', async () => {
      const { build, kills, abort, outcome, child } = abortable();
      expect(build.calls[0]?.options).toMatchObject({ detached: true });
      abort.abort();
      expect(kills).toEqual(['SIGTERM -5150']);
      child().signalCode = 'SIGTERM';
      child().emit('close', null, 'SIGTERM');
      expect(await outcome).toContain('Building the native modules failed (SIGTERM)');
    });

    it('signals nothing once the build leader has exited, even before it closes', async () => {
      const { kills, clock, abort, outcome, child } = abortable();
      // Reaped: its pid, and so its group ID, may already belong to someone else.
      child().exitCode = 0;
      abort.abort();
      expect(kills).toEqual([]);
      expect(clock.timers).toEqual([]);
      child().emit('close', 0, null);
      expect(await outcome).toBe('resolved');
    });

    it('does not swallow an error other than ESRCH from the signal', async () => {
      const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      const { abort, outcome } = abortable({
        kill: () => {
          throw denied;
        },
      });
      abort.abort();
      expect(await outcome).toBe('kill EPERM');
    });

    it('ignores ESRCH, the group having ended on its own', async () => {
      const gone = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      const { abort, outcome, child } = abortable({
        kill: () => {
          throw gone;
        },
      });
      abort.abort();
      child().signalCode = 'SIGTERM';
      child().emit('close', null, 'SIGTERM');
      expect(await outcome).toContain('Building the native modules failed (SIGTERM)');
    });

    it('sends SIGKILL to the group after the grace period if the build is still running', async () => {
      const { kills, clock, abort, outcome, child } = abortable();
      abort.abort();
      expect(clock.timers.map((timer) => timer.ms)).toEqual([1000]);
      clock.timers[0]?.run();
      expect(kills).toEqual(['SIGTERM -5150', 'SIGKILL -5150']);
      child().signalCode = 'SIGKILL';
      child().emit('close', null, 'SIGKILL');
      expect(await outcome).toContain('(SIGKILL)');
    });

    it('does not send SIGKILL to a build that exited within the grace period', async () => {
      const { kills, clock, abort, outcome, child } = abortable();
      abort.abort();
      child().signalCode = 'SIGTERM';
      child().emit('close', null, 'SIGTERM');
      await outcome;
      expect(clock.timers[0]?.cleared).toBe(true);
      // Even a timer that fires anyway finds the leader reaped.
      clock.timers[0]?.run();
      expect(kills).toEqual(['SIGTERM -5150']);
    });
  });
});
