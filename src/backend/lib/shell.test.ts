import { describe, expect, it } from 'vitest';
import { execCommand } from './shell';

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
});
