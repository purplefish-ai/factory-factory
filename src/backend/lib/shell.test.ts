import { describe, expect, it } from 'vitest';
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
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500);'], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.unref();
      process.exit(0);
    `;

    const result = await execCommand(process.execPath, ['-e', script], {
      timeout: 200,
    });

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).not.toContain('timed out after 200ms');
  });

  it('force-kills the process when it ignores the timeout signal', async () => {
    const script = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 5000);";

    const result = await execCommand(process.execPath, ['-e', script], {
      forceKillAfterTimeout: 25,
      timeout: 100,
    });

    expect(result.code).not.toBe(0);
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
