import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LIB_LIMITS } from './constants';
import { escapeForOsascript, execCommand } from './shell';

describe('execCommand', () => {
  it('preserves UTF-8 output when stdout bytes are split across chunks', async () => {
    const script = `
      process.stdout.write(Buffer.from([0xf0, 0x9f]));
      setTimeout(() => {
        process.stdout.write(Buffer.from([0x9a, 0x80]));
      }, 10);
    `;

    const result = await execCommand(process.execPath, ['-e', script]);

    expect(result.stdout).toBe('🚀');
    expect(result.code).toBe(0);
  });

  it('preserves UTF-8 output when stderr bytes are split across chunks', async () => {
    const script = `
      process.stderr.write(Buffer.from([0xf0, 0x9f]));
      setTimeout(() => {
        process.stderr.write(Buffer.from([0x9a, 0x80]));
      }, 10);
    `;

    const result = await execCommand(process.execPath, ['-e', script]);

    expect(result.stderr).toBe('🚀');
    expect(result.code).toBe(0);
  });

  it('returns non-zero code when process is terminated by signal', async () => {
    const script = "process.kill(process.pid, 'SIGKILL');";

    const result = await execCommand(process.execPath, ['-e', script]);

    expect(result.code).not.toBe(0);
  });

  it('kills the process and marks the result when timeout expires', async () => {
    const result = await execCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000);'], {
      timeout: 25,
    });

    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain('timed out after 25ms');
  });

  it('does not mark a successful process timed out while waiting for stdio close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ff-shell-stdio-'));
    const pidFile = join(directory, 'pids.json');
    const script = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000);'], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.unref();
      writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
      process.exit(0);
    `;
    const isRunning = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const readPids = () => {
      try {
        return z
          .object({ parent: z.number(), child: z.number() })
          .parse(JSON.parse(readFileSync(pidFile, 'utf8')));
      } catch {
        return undefined;
      }
    };
    let childPid: number | undefined;
    // Fake only execCommand's timer: fire it after the real parent has exited
    // while its detached child still holds stdio, however slowly the parent starts.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = execCommand(process.execPath, ['-e', script], { timeout: 200 });
      // Observe a spawn failure even if the poll below gives up first.
      pending.catch(() => undefined);
      // Poll on a real timer: vi.waitFor would advance the fake clock while waiting.
      // Date is not faked, so the deadline still reports a helper that never exits.
      const deadline = Date.now() + 4000;
      let pids = readPids();
      while (!pids || isRunning(pids.parent)) {
        if (Date.now() > deadline) {
          throw new Error('Helper process did not record its pids and exit in time');
        }
        await delay(10);
        pids = readPids();
      }
      childPid = pids.child;
      vi.advanceTimersByTime(200);
      process.kill(childPid);

      const result = await pending;

      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).not.toContain('timed out after 200ms');
    } finally {
      vi.useRealTimers();
      // Clean up helpers even when the poll gave up before recording the child.
      const pids = readPids();
      for (const pid of [childPid ?? pids?.child, pids?.parent]) {
        if (pid !== undefined && isRunning(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('force-kills the process when it ignores the timeout signal', async () => {
    const script =
      "process.on('SIGTERM', () => {}); process.stdout.write('READY'); setTimeout(() => {}, 5000);";

    const result = await execCommand(process.execPath, ['-e', script], {
      forceKillAfterTimeout: 25,
      // Allow the real Node child to install its handler under full-suite CPU load.
      timeout: 1000,
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain('READY');
    expect(result.signal).toBe('SIGKILL');
    expect(result.timedOut).toBe(true);
  });

  it('kills the process and marks the result when the abort signal fires', async () => {
    const controller = new AbortController();
    const promise = execCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000);'], {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 25).unref();
    const result = await promise;

    expect(result.code).not.toBe(0);
    expect(result.aborted).toBe(true);
    expect(result.stderr).toContain('was aborted');
  });

  it('kills the process and truncates stdout when maxBuffer is exceeded', async () => {
    const script = `
      process.stdout.write('a'.repeat(1024));
      setTimeout(() => {}, 5000);
    `;

    const result = await execCommand(process.execPath, ['-e', script], { maxBuffer: 16 });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('a'.repeat(16));
    expect(result.maxBufferExceeded).toBe(true);
    expect(result.stdoutOverflowed).toBe(true);
    expect(result.stderrOverflowed).toBe(false);
    expect(result.stderr).toContain('exceeded maxBuffer of 16 bytes');
  });

  it('kills the process and truncates stderr when maxBuffer is exceeded', async () => {
    const script = `
      process.stderr.write('b'.repeat(1024));
      setTimeout(() => {}, 5000);
    `;

    const result = await execCommand(process.execPath, ['-e', script], { maxBuffer: 16 });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('b'.repeat(16));
    expect(result.maxBufferExceeded).toBe(true);
    expect(result.stdoutOverflowed).toBe(false);
    expect(result.stderrOverflowed).toBe(true);
    expect(result.stderr).toContain('exceeded maxBuffer of 16 bytes');
  });
});

describe('escapeForOsascript', () => {
  it('does not leave a dangling backslash when truncation boundary ends with a quote', () => {
    const input = `${'a'.repeat(LIB_LIMITS.osascriptEscapedMaxChars - 1)}"`;

    const escaped = escapeForOsascript(input);

    expect(escaped).toBe(`${'a'.repeat(LIB_LIMITS.osascriptEscapedMaxChars - 1)}\\"`);
  });

  it('does not leave a dangling backslash when truncation boundary ends with a backslash', () => {
    const input = `${'a'.repeat(LIB_LIMITS.osascriptEscapedMaxChars - 1)}\\`;

    const escaped = escapeForOsascript(input);

    expect(escaped).toBe(`${'a'.repeat(LIB_LIMITS.osascriptEscapedMaxChars - 1)}\\\\`);
  });
});
