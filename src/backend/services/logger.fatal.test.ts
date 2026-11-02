import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLogger } from './logger.service';

const logRecordSchema = z.object({
  message: z.string(),
  error: z.object({ message: z.string() }).optional(),
});
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe('fatal logging', () => {
  it('writes the terminal error synchronously without echoing to stderr', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ff-fatal-log-'));
    temporaryDirectories.push(baseDir);
    vi.stubEnv('BASE_DIR', baseDir);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('write EPIPE');
    });

    createLogger('test').fatal('Terminal failure', new Error('original cause'));

    expect(stderr).not.toHaveBeenCalled();
    const content = await readFile(join(baseDir, 'logs/server.log'), 'utf8');
    expect(logRecordSchema.parse(JSON.parse(content))).toMatchObject({
      message: 'Terminal failure',
      error: { message: 'original cause' },
    });
  });

  it('still sends ordinary errors to a healthy console sink without accumulating listeners', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ff-healthy-stderr-'));
    temporaryDirectories.push(baseDir);
    vi.stubEnv('BASE_DIR', baseDir);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const listenersBefore = process.stderr.listenerCount('error');
    for (let index = 0; index < 50; index++) {
      createLogger(`healthy-${index}`).error('visible error');
    }
    expect(stderr).toHaveBeenCalledTimes(50);
    expect(process.stderr.listenerCount('error')).toBeLessThanOrEqual(listenersBefore + 1);
  });

  it.each(['throw', 'event'] as const)(
    'keeps a failed sink disabled across instances and module reloads (%s)',
    async (failure) => {
      const baseDir = await mkdtemp(join(tmpdir(), 'ff-broken-stderr-'));
      temporaryDirectories.push(baseDir);
      const code = `
        const failure = ${JSON.stringify(failure)};
        let calls = 0;
        console.error = () => {
          calls++;
          if (failure === 'throw') throw new Error('write EPIPE');
        };
        const first = await import('./src/backend/services/logger.service.ts?reload=0');
        first.createLogger('first').error('first failure');
        if (failure === 'event') process.stderr.emit('error', new Error('write EPIPE'));
        first.createLogger('second').error('second failure');
        const reloaded = await import('./src/backend/services/logger.service.ts?reload=1');
        reloaded.createLogger('reloaded').error('failure after reload');
        console.log(JSON.stringify({ calls }));
      `;
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', code],
        {
          cwd: process.cwd(),
          env: { ...process.env, BASE_DIR: baseDir, NODE_ENV: 'production' },
          encoding: 'utf8',
          timeout: 10_000,
        }
      );
      expect(child.status, child.stderr).toBe(0);
      expect(z.object({ calls: z.number() }).parse(JSON.parse(child.stdout))).toEqual({ calls: 1 });
    }
  );

  it('survives a closed stderr pipe and retains one fatal record before immediate exit', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ff-closed-stderr-'));
    temporaryDirectories.push(baseDir);
    const code = `
      import { createLogger } from './src/backend/services/logger.service.ts';
      import { registerFatalErrorHandlers } from './src/backend/fatal-error-handlers.ts';
      const logger = createLogger('pipe-regression');
      registerFatalErrorHandlers({ logger, process, server: { stop: async () => {} } });
      process.stdin.once('data', () => {
        logger.error('ordinary error after stderr closes');
        setTimeout(() => { throw new Error('terminal cause'); }, 25);
      });
      process.stdout.write('ready');
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, BASE_DIR: baseDir, NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      child.stderr.destroy();
      child.stdin.end('go');
      expect(await exited).toEqual([1, null]);
      const records = (await readFile(join(baseDir, 'logs/server.log'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => logRecordSchema.parse(JSON.parse(line)));
      expect(records.filter((entry) => entry.message === 'Uncaught exception')).toEqual([
        expect.objectContaining({ error: { message: 'terminal cause' } }),
      ]);
      expect(records).toHaveLength(2);
    } finally {
      child.kill('SIGKILL');
    }
  }, 10_000);
});
