import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ff-running-marker-'));
  roots.push(root);
  const path = join(root, '.factory-factory-running-test');
  const moduleUrl = pathToFileURL(
    fileURLToPath(new URL('./application-server-marker.ts', import.meta.url))
  ).href;
  const setup = `import {registerApplicationServerMarker} from ${JSON.stringify(moduleUrl)};const release=registerApplicationServerMarker(${JSON.stringify(path)});`;
  return { path, setup };
}
it('removes a running marker even when migration code exits immediately with failure', () => {
  const { path, setup } = fixture();
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', `${setup}process.exit(1);`],
    { encoding: 'utf8' }
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(1);
  expect(existsSync(path)).toBe(false);
});
it('removes a running marker when startup receives SIGINT', async () => {
  const { path, setup } = fixture();
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `${setup}console.log('ready');setTimeout(()=>{},10000);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  try {
    const ended = new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once('exit', (_code, signal) => resolve(signal));
      child.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Child exited before startup marker was ready')));
    });
    expect(existsSync(path)).toBe(true);
    child.kill('SIGINT');
    expect(await ended).toBe('SIGINT');
    expect(existsSync(path)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});
it('releases cleanup listeners without interfering with existing graceful shutdown handlers', () => {
  const { path, setup } = fixture();
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `${setup}process.on('SIGTERM',()=>{release();console.log('graceful');});process.emit('SIGTERM');`,
    ],
    { encoding: 'utf8' }
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('graceful');
  expect(existsSync(path)).toBe(false);
});
