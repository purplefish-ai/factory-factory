import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const environmentModule = new URL('./environment.mjs', import.meta.url).href;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A stand-in recorder: it registers a temp directory holding a fake sign-in
// copy and a tracked child, reports both, then waits to be interrupted.
async function interruptedRun(signal: NodeJS.Signals) {
  const directory = mkdtempSync(join(tmpdir(), 'ff-abort-test-'));
  directories.push(directory);
  const secrets = join(directory, 'run');
  const script = `
    import { spawn } from 'node:child_process';
    import { mkdirSync, writeFileSync } from 'node:fs';
    const { installAbortCleanup, removeOnAbort, trackChild } = await import(${JSON.stringify(environmentModule)});
    mkdirSync(${JSON.stringify(secrets)});
    writeFileSync(${JSON.stringify(join(secrets, 'auth.json'))}, '{}');
    removeOnAbort.add(${JSON.stringify(secrets)});
    installAbortCleanup();
    const tool = trackChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']));
    tool.once('spawn', () => process.stdout.write(String(tool.pid) + '\\n'));
    setInterval(() => {}, 1000);
  `;
  const scriptPath = join(directory, 'recorder.mjs');
  writeFileSync(scriptPath, script);
  const recorder = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const toolPid = await new Promise<number>((resolve) => {
    recorder.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
  const exited = new Promise<number | null>((resolve) =>
    recorder.once('exit', (code) => resolve(code))
  );
  recorder.kill(signal);
  const code = await exited;
  // SIGKILL is delivered at once, but the kernel may report the child a moment later.
  for (let attempt = 0; attempt < 50 && isRunning(toolPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { code, secretsLeft: existsSync(secrets), toolRunning: isRunning(toolPid) };
}

describe('installAbortCleanup', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('removes the temp directory and stops the tools on %s', async (signal, code) => {
    await expect(interruptedRun(signal)).resolves.toEqual({
      code,
      secretsLeft: false,
      toolRunning: false,
    });
  });
});
