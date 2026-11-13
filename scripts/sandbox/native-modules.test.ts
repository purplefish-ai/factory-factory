import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ensureNativeModules } from './native-modules.mjs';

/** A stand-in for the build script's process: prints `stdout`, then closes. */
function fakeBuild(stdout: string, code: number | null = 0) {
  const calls: { args: string[]; options: object }[] = [];
  const children: (EventEmitter & { pid: number; stdout: EventEmitter })[] = [];
  const spawnImpl = (_command: string, args: string[], options: object) => {
    calls.push({ args, options });
    const child = Object.assign(new EventEmitter(), { pid: 5150, stdout: new EventEmitter() });
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

  it('runs in its own process group and signals the whole group when aborted', async () => {
    const build = fakeBuild('', null);
    const kills: string[] = [];
    const abort = new AbortController();
    const result = ensureNativeModules({
      signal: abort.signal,
      spawnImpl: build.spawnImpl,
      output: quiet,
      kill: (target: number, signal: string) => kills.push(`${signal} ${target}`),
    });
    expect(build.calls[0]?.options).toMatchObject({ detached: true });
    abort.abort();
    // The group's members end, then the script's process closes.
    build.children[0]?.emit('close', null, 'SIGTERM');
    await expect(result).rejects.toThrow('Building the native modules failed (SIGTERM)');
    expect(kills).toEqual(['SIGTERM -5150']);
  });
});
