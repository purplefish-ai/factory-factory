import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertInsideTempDir } from './paths.mjs';
import { launch, launcherEnv, temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

describe('the BASE_DIR guard', () => {
  it('refuses a BASE_DIR outside the OS temporary directory', async () => {
    const tempDir = temporary.create('ffsb-');
    const outside = temporary.create('ffsb-outside-');
    expect(() => assertInsideTempDir(outside, tempDir)).toThrow(/Refusing/);
    expect(() => assertInsideTempDir(tempDir, tempDir)).toThrow(/Refusing/);
    expect(() => assertInsideTempDir(join(tempDir, 'missing'), tempDir)).toThrow(/Refusing/);
    mkdirSync(join(tempDir, 'inside'));
    expect(() => assertInsideTempDir(join(tempDir, 'inside'), tempDir)).not.toThrow();
    symlinkSync(outside, join(tempDir, 'link'));
    expect(() => assertInsideTempDir(join(tempDir, 'link'), tempDir)).toThrow(/Refusing/);
    // A sandbox root that leads out of the temporary directory stops the launcher.
    symlinkSync(outside, join(tempDir, 'ff-sandbox'));
    const run = launch([], launcherEnv(tempDir));
    expect(await run.exited).toBe(1);
    expect(run.output()).toMatch(/Refusing to use .* as BASE_DIR/);
    expect(execFileSync('ls', ['-A', outside], { encoding: 'utf8' })).toBe('');
  }, 30_000);
});
