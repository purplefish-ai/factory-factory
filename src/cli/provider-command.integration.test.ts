import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runProviderCommand } from './provider-command';

function killFixtureProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
}

it.skipIf(process.platform === 'win32')(
  'terminates an unresponsive native descendant after its launcher exits',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-cli-process-tree-'));
    const wrapperFile = join(root, 'wrapper.pid');
    const nativeFile = join(root, 'native.pid');
    const nativeScript = `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(nativeFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
    const wrapperScript = `
    require('node:fs').writeFileSync(${JSON.stringify(wrapperFile)}, String(process.pid));
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(nativeScript)}], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `;
    let nativePid: number | undefined;
    let wrapperPid: number | undefined;
    const pending = runProviderCommand({ command: process.execPath, args: ['-e', wrapperScript] });
    try {
      await vi.waitFor(
        () => {
          wrapperPid = z.coerce.number().int().min(2).parse(readFileSync(wrapperFile, 'utf8'));
          nativePid = z.coerce.number().int().min(2).parse(readFileSync(nativeFile, 'utf8'));
        },
        { timeout: 10_000 }
      );
      const signal = process.listeners('SIGTERM').at(-1);
      expect(signal).toBeDefined();
      const shutdownStartedAt = Date.now();
      signal?.('SIGTERM');
      await expect(pending).resolves.toBe(143);
      expect(Date.now() - shutdownStartedAt).toBeLessThan(6000);
      await vi.waitFor(
        () => {
          expect(() => process.kill(nativePid!, 0)).toThrow();
        },
        { timeout: 2000 }
      );
    } finally {
      if (wrapperPid !== undefined) {
        killFixtureProcess(-wrapperPid);
      }
      for (const pid of [nativePid, wrapperPid]) {
        if (pid === undefined) {
          continue;
        }
        killFixtureProcess(pid);
      }
      await pending.catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000
);
