import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Publish the worker pid by rename: a reader of a plain write can see the
// created but still empty file, and Number('') is 0, which names the test's own
// process group to process.kill.
const PUBLISH_WORKER_PID = `writeFileSync(new URL('./worker.pid.tmp', import.meta.url), String(process.pid));
renameSync(new URL('./worker.pid.tmp', import.meta.url), new URL('./worker.pid', import.meta.url));`;
const directories: string[] = [];
function fixture(minimum: string) {
  const root = mkdtempSync(join(tmpdir(), 'ff-bootstrap-'));
  directories.push(root);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, '.node-minimum'), minimum);
  // Updating the development pin must never raise the consumer requirement.
  writeFileSync(join(root, '.node-version'), '999.0.0');
  for (const file of ['bootstrap.mjs', 'setup-prerequisites.mjs']) {
    copyFileSync(new URL(file, import.meta.url), join(root, file));
  }
  writeFileSync(
    join(root, 'index.js'),
    'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;'
  );
  return root;
}
// Processes a test started. They are killed after the test, not in its
// `finally`: a test that times out while awaiting a hung process never reaches
// its `finally`, and would leave that process running.
const startedProcesses: Array<() => number | undefined> = [];
function killAfterTest(pid: () => number | undefined) {
  startedProcesses.push(pid);
}
afterEach(() => {
  for (const pid of startedProcesses.splice(0)) {
    try {
      const target = pid();
      // Never signal pid 0: it names the test's own process group.
      if (target) {
        process.kill(target, 'SIGKILL');
      }
    } catch {
      /* Not started, or already stopped. */
    }
  }
  for (const root of directories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
it('reports unsupported Node without importing the application or prompting on piped input', () => {
  const root = fixture('999.0.0');
  writeFileSync(join(root, 'index.js'), 'throw new Error("APP WAS LOADED");');
  const result = spawnSync(process.execPath, [join(root, 'bootstrap.mjs'), 'serve'], {
    encoding: 'utf8',
    // Keep prerequisite probes independent of the host's version managers.
    env: { ...process.env, PATH: root },
    timeout: 15_000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requires Node.js 999.0.0');
  expect(result.stderr).not.toContain('APP WAS LOADED');
  expect(result.stdout).not.toContain('[y/N]');
}, 20_000);
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
  const minimum = readFileSync(new URL('../../.node-minimum', import.meta.url), 'utf8').trim();
  expect(pkg.engines.node).toBe(`>=${minimum}`);
  expect(pkg.files).toContain('.node-minimum');
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
      `import { renameSync, writeFileSync } from 'node:fs';
       if (process.argv.includes('--stubborn')) process.on('SIGTERM', () => {});
       ${PUBLISH_WORKER_PID}
       setInterval(() => {}, 1000);`
    );
    writeFileSync(
      join(root, 'index.js'),
      `import { fileURLToPath } from 'node:url';
       import { createSetupIO, confirmFix } from './setup-prerequisites.mjs';
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
    killAfterTest(() => child.pid);
    killAfterTest(() => workerPid);
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
  },
  10_000
);

// The spawned child: it reports that it is ready, and records that SIGTERM
// reached it (a child killed by setup's 5 s SIGKILL fallback leaves no record).
const EXIT_ON_SIGTERM = `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {
  writeFileSync(new URL('./terminated', import.meta.url), 'SIGTERM');
  process.exit(143);
});
writeFileSync(new URL('./child.ready', import.meta.url), '');
setInterval(() => {}, 1000);`;

// Send SIGTERM to this process the instant its first spawn returns, before the
// caller's next statement: the window where a parent that registers its signal
// listener only after spawning dies and orphans the child. First wait, inside
// the same call, until the child has installed its SIGTERM handler.
const SIGTERM_AFTER_FIRST_SPAWN = `import childProcess from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  childProcess.spawn = spawn;
  syncBuiltinESMExports();
  const child = spawn(...args);
  writeFileSync(new URL('./spawned.pid.tmp', import.meta.url), String(child.pid));
  renameSync(new URL('./spawned.pid.tmp', import.meta.url), new URL('./spawned.pid', import.meta.url));
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(new URL('./child.ready', import.meta.url))) Atomics.wait(idle, 0, 0, 5);
  process.kill(process.pid, 'SIGTERM');
  return child;
};
syncBuiltinESMExports();`;

it.skipIf(process.platform === 'win32').each([
  { parent: 'launcher', child: 'application' },
  { parent: 'setup', child: 'installer' },
] as const)(
  'stops the $child when SIGTERM reaches the $parent as it spawns it',
  async ({ parent }) => {
    const root = fixture('1.0.0');
    const hook = join(root, 'sigterm-after-spawn.mjs');
    writeFileSync(hook, SIGTERM_AFTER_FIRST_SPAWN);
    writeFileSync(join(root, 'worker.mjs'), EXIT_ON_SIGTERM);
    writeFileSync(
      join(root, 'index.js'),
      parent === 'launcher'
        ? EXIT_ON_SIGTERM
        : `import './sigterm-after-spawn.mjs';
           import { fileURLToPath } from 'node:url';
           import { createSetupIO, confirmFix } from './setup-prerequisites.mjs';
           const io = createSetupIO();
           io.interactive = true;
           io.ask = async () => 'y';
           await confirmFix([process.execPath, fileURLToPath(new URL('./worker.mjs', import.meta.url))], io);`
    );
    const child = spawn(
      process.execPath,
      [...(parent === 'launcher' ? ['--import', hook] : []), join(root, 'bootstrap.mjs'), 'serve'],
      { stdio: 'ignore' }
    );
    killAfterTest(() => child.pid);
    killAfterTest(() => Number(readFileSync(join(root, 'spawned.pid'), 'utf8')));
    const exit = await new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal }))
    );
    const spawned = Number(readFileSync(join(root, 'spawned.pid'), 'utf8'));
    expect(exit).toEqual({ code: 143, signal: null });
    // The parent waits for its child to exit before it exits itself.
    expect(() => process.kill(spawned, 0)).toThrow();
    // The forwarded SIGTERM stopped the child, not the 5 s SIGKILL fallback.
    expect(readFileSync(join(root, 'terminated'), 'utf8')).toBe('SIGTERM');
  },
  // Starts two or three Node processes, like the SIGTERM test above.
  10_000
);

it('cancels startup on Ctrl+C at the confirmation prompt', () => {
  const root = fixture('1.0.0');
  writeFileSync(
    join(root, 'index.js'),
    `
    import { PassThrough } from 'node:stream';
    import { createSetupIO, confirmFix } from './setup-prerequisites.mjs';
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
    import { renameSync, writeFileSync } from 'node:fs';
    process.on('SIGINT', () => setTimeout(() => {
      writeFileSync(new URL('./graceful', import.meta.url), 'done');
      process.exit(0);
    }, 200));
    ${PUBLISH_WORKER_PID}
    setInterval(() => {}, 1000);
  `
    );
    writeFileSync(
      join(root, 'index.js'),
      `
    import { fileURLToPath } from 'node:url';
    import { createSetupIO, confirmFix } from './setup-prerequisites.mjs';
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
    killAfterTest(() => child.pid);
    killAfterTest(() => workerPid);
    await vi.waitFor(
      () => {
        workerPid = Number(readFileSync(pidFile, 'utf8'));
      },
      { timeout: 5000 }
    );
    process.kill(-child.pid!, 'SIGINT');
    await closed;
    expect(readFileSync(gracefulFile, 'utf8')).toBe('done');
  }
);
