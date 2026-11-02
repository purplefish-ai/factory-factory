import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  existsSync: () => true,
  mkdirSync: vi.fn(),
  createWriteStream: () => ({ on: vi.fn(), write: vi.fn() }),
}));

afterEach(() => vi.unstubAllEnvs());

describe('console logging across module reloads', () => {
  it('keeps one stream error listener when integration fixtures reset modules', async () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('NODE_ENV', 'test');
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const stdoutListenersBefore = process.stdout.listenerCount('error');
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const listenersBefore = process.stderr.listenerCount('error');
    for (let index = 0; index < 20; index++) {
      vi.resetModules();
      const { createLogger } =
        await vi.importActual<typeof import('./logger.service')>('./logger.service');
      const logger = createLogger(`reload-${index}`);
      logger.error('synthetic reload error');
      logger.info('synthetic reload info');
    }
    expect(output).toHaveBeenCalledTimes(20);
    expect(info).toHaveBeenCalledTimes(20);
    expect(process.stdout.listenerCount('error')).toBeLessThanOrEqual(stdoutListenersBefore + 1);
    expect(process.stderr.listenerCount('error')).toBeLessThanOrEqual(listenersBefore + 1);
  });
});
