import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from './config.service';
import { crashAt } from './crash-point';

const ORIGINAL_ENV = { ...process.env };

describe('crashAt', () => {
  let dir: string;
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ff-crash-points-'));
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    kill.mockRestore();
    process.env = { ...ORIGINAL_ENV };
    configService.reload();
    rmSync(dir, { recursive: true, force: true });
  });

  function configure(env: { scenario?: string; dir?: string }) {
    Reflect.deleteProperty(process.env, 'FF_SANDBOX_SCENARIO');
    Reflect.deleteProperty(process.env, 'FF_SANDBOX_CRASH_POINT_DIR');
    if (env.scenario) {
      process.env.FF_SANDBOX_SCENARIO = env.scenario;
    }
    if (env.dir) {
      process.env.FF_SANDBOX_CRASH_POINT_DIR = env.dir;
    }
    configService.reload();
  }

  it('kills the process with SIGKILL once, at an armed point in the sandbox', () => {
    configure({ scenario: 'echo', dir });
    writeFileSync(join(dir, 'after-test-step'), '');
    crashAt('after-test-step');
    expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGKILL');
    // Disarmed by the crash, so the restarted server passes the point.
    expect(existsSync(join(dir, 'after-test-step'))).toBe(false);
    crashAt('after-test-step');
    expect(kill).toHaveBeenCalledOnce();
  });

  it('passes a point that is not armed', () => {
    configure({ scenario: 'echo', dir });
    writeFileSync(join(dir, 'another-point'), '');
    crashAt('after-test-step');
    expect(kill).not.toHaveBeenCalled();
  });

  it('is inert outside the sandbox even when a point is armed', () => {
    configure({ dir });
    writeFileSync(join(dir, 'after-test-step'), '');
    crashAt('after-test-step');
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'after-test-step'))).toBe(true);
  });
});
