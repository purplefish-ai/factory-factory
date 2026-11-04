import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

const directories: string[] = [];
function fixture(minimum: string) {
  const root = mkdtempSync(join(tmpdir(), 'ff-bootstrap-'));
  directories.push(root);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, '.node-version'), minimum);
  for (const file of ['bootstrap.mjs', 'serve-prerequisites.mjs']) {
    copyFileSync(new URL(file, import.meta.url), join(root, file));
  }
  writeFileSync(
    join(root, 'index.js'),
    'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;'
  );
  return root;
}
afterEach(() =>
  directories.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
);
it('reports unsupported Node without importing the application or prompting on piped input', () => {
  const root = fixture('999.0.0');
  writeFileSync(join(root, 'index.js'), 'throw new Error("APP WAS LOADED");');
  const result = spawnSync(process.execPath, [join(root, 'bootstrap.mjs'), 'serve'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requires Node.js 999.0.0');
  expect(result.stderr).not.toContain('APP WAS LOADED');
  expect(result.stdout).not.toContain('[y/N]');
});
it('forwards arguments verbatim and preserves the application exit code', () => {
  const root = fixture('1.0.0');
  const result = spawnSync(
    process.execPath,
    [join(root, 'bootstrap.mjs'), 'serve', '--database-path', 'path with spaces'],
    { encoding: 'utf8', timeout: 15_000 }
  );
  expect(result.status).toBe(7);
  expect(result.stdout.trim()).toBe('["serve","--database-path","path with spaces"]');
});
it('keeps the shipped version floor consistent with package engines', () => {
  const pkg = z
    .object({
      engines: z.object({ node: z.string() }),
      files: z.array(z.string()),
      bin: z.record(z.string(), z.string()),
    })
    .parse(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')));
  const minimum = readFileSync(new URL('../../.node-version', import.meta.url), 'utf8').trim();
  expect(pkg.engines.node).toBe(`>=${minimum}`);
  expect(pkg.files).toContain('.node-version');
  expect(pkg.bin.ff).toBe('./dist/src/cli/bootstrap.mjs');
  expect(pkg.bin['factory-factory']).toBe(pkg.bin.ff);
});

it.skipIf(process.platform === 'win32').each([false, true])(
  'stops setup on SIGTERM, including repeated cancellation (ignores first: %s)',
  async (stubborn) => {
    const root = fixture('1.0.0');
    const worker = join(root, 'worker.mjs');
    const pidFile = join(root, 'worker.pid');
    writeFileSync(
      worker,
      `import { writeFileSync } from 'node:fs';
       if (process.argv.includes('--stubborn')) process.on('SIGTERM', () => {});
       writeFileSync(new URL('./worker.pid', import.meta.url), String(process.pid));
       setInterval(() => {}, 1000);`
    );
    writeFileSync(
      join(root, 'index.js'),
      `import { fileURLToPath } from 'node:url';
       import { createSetupIO, confirmFix } from './serve-prerequisites.mjs';
       const io = createSetupIO();
       io.interactive = true;
       io.ask = async () => 'y';
       const args = process.argv.includes('--stubborn') ? ['--stubborn'] : [];
       await confirmFix([process.execPath, fileURLToPath(new URL('./worker.mjs', import.meta.url)), ...args], io);`
    );
    const child = spawn(
      process.execPath,
      [join(root, 'bootstrap.mjs'), 'serve', ...(stubborn ? ['--stubborn'] : [])],
      {
        stdio: 'ignore',
      }
    );
    const closed = new Promise((resolve) => child.once('exit', resolve));
    let workerPid: number | undefined;
    try {
      await vi.waitFor(
        () => {
          workerPid = Number(readFileSync(pidFile, 'utf8'));
        },
        { timeout: 5000 }
      );
      child.kill('SIGTERM');
      if (stubborn) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        child.kill('SIGTERM');
      }
      await closed;
      await vi.waitFor(() => expect(() => process.kill(workerPid!, 0)).toThrow(), {
        timeout: 5000,
      });
    } finally {
      child.kill('SIGKILL');
      if (workerPid) {
        try {
          process.kill(workerPid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
    }
  },
  10_000
);

it('cancels startup on Ctrl+C at the confirmation prompt', () => {
  const root = fixture('1.0.0');
  writeFileSync(
    join(root, 'index.js'),
    `
    import { PassThrough } from 'node:stream';
    import { createSetupIO, confirmFix } from './serve-prerequisites.mjs';
    const input = new PassThrough();
    const output = new PassThrough();
    output.isTTY = true;
    const io = createSetupIO({ input, output });
    io.interactive = true;
    io.run = async () => { console.log('FIX_RAN'); return true; };
    const pending = confirmFix(['example', 'install'], io);
    input.write(String.fromCharCode(3));
    await pending;
    console.log('SERVER_STARTED');
  `
  );
  const result = spawnSync(process.execPath, [join(root, 'bootstrap.mjs'), 'serve'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status).toBe(130);
  expect(result.stdout).not.toContain('FIX_RAN');
  expect(result.stdout).not.toContain('SERVER_STARTED');
});

it.skipIf(process.platform === 'win32')(
  'delivers a foreground-group Ctrl+C only once to an active installer',
  async () => {
    const root = fixture('1.0.0');
    const pidFile = join(root, 'worker.pid');
    const gracefulFile = join(root, 'graceful');
    writeFileSync(
      join(root, 'worker.mjs'),
      `
    import { writeFileSync } from 'node:fs';
    process.on('SIGINT', () => setTimeout(() => {
      writeFileSync(new URL('./graceful', import.meta.url), 'done');
      process.exit(0);
    }, 200));
    writeFileSync(new URL('./worker.pid', import.meta.url), String(process.pid));
    setInterval(() => {}, 1000);
  `
    );
    writeFileSync(
      join(root, 'index.js'),
      `
    import { fileURLToPath } from 'node:url';
    import { createSetupIO, confirmFix } from './serve-prerequisites.mjs';
    const io = createSetupIO(); io.interactive = true; io.ask = async () => 'y';
    await confirmFix([process.execPath, fileURLToPath(new URL('./worker.mjs', import.meta.url))], io);
  `
    );
    const child = spawn(process.execPath, [join(root, 'bootstrap.mjs'), 'serve'], {
      stdio: 'ignore',
      detached: true,
    });
    const closed = new Promise((resolve) => child.once('exit', resolve));
    let workerPid: number | undefined;
    try {
      await vi.waitFor(
        () => {
          workerPid = Number(readFileSync(pidFile, 'utf8'));
        },
        { timeout: 5000 }
      );
      process.kill(-child.pid!, 'SIGINT');
      await closed;
      expect(readFileSync(gracefulFile, 'utf8')).toBe('done');
    } finally {
      child.kill('SIGKILL');
      if (workerPid) {
        try {
          process.kill(workerPid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
    }
  }
);
