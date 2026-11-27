import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPrivateDirectory,
  prepareRawDirectory,
  spawnTool,
  stopChild,
} from './environment.mjs';

const environmentModule = new URL('./environment.mjs', import.meta.url).href;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ff-recorder-test-')));
  directories.push(directory);
  return directory;
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pids: number[]) {
  // A killed process can be reported by the kernel a moment after the signal.
  for (let attempt = 0; attempt < 100 && pids.some(isRunning); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return pids.filter(isRunning);
}

// A tool that starts a grandchild (as the Claude adapter starts the CLI),
// prints both PIDs and then ignores the end of its stdin.
const TOOL_SOURCE = `
  const { spawn } = require('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stdout.write(process.pid + ' ' + grandchild.pid + '\\n');
  setInterval(() => {}, 1000);
`;

function readPids(stream: NodeJS.ReadableStream) {
  return new Promise<number[]>((resolve) => {
    stream.once('data', (chunk: Buffer) => resolve(chunk.toString().trim().split(' ').map(Number)));
  });
}

// A stand-in recorder: it registers a temp directory holding a fake sign-in
// copy, starts the tool in an owned process group, reports the PIDs, then
// waits to be interrupted.
async function interruptedRun(signal: NodeJS.Signals) {
  const directory = temporaryDirectory();
  const secrets = join(directory, 'run');
  const script = `
    import { mkdirSync, writeFileSync } from 'node:fs';
    const { installAbortCleanup, removeOnAbort, spawnTool } = await import(${JSON.stringify(environmentModule)});
    mkdirSync(${JSON.stringify(secrets)});
    writeFileSync(${JSON.stringify(join(secrets, 'auth.json'))}, '{}');
    removeOnAbort.add(${JSON.stringify(secrets)});
    installAbortCleanup();
    const tool = spawnTool(process.execPath, ['-e', ${JSON.stringify(TOOL_SOURCE)}], { stdio: ['pipe', 'pipe', 'inherit'] });
    tool.stdout.pipe(process.stdout);
    setInterval(() => {}, 1000);
  `;
  const scriptPath = join(directory, 'recorder.mjs');
  writeFileSync(scriptPath, script);
  const recorder = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const pids = await readPids(recorder.stdout);
  const exited = new Promise<number | null>((resolve) =>
    recorder.once('exit', (code) => resolve(code))
  );
  recorder.kill(signal);
  const code = await exited;
  return { code, secretsLeft: existsSync(secrets), running: await waitUntilGone(pids) };
}

describe('installAbortCleanup', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)(
    'removes the temp directory and stops the tool and its descendants on %s',
    async (signal, code) => {
      await expect(interruptedRun(signal)).resolves.toEqual({
        code,
        secretsLeft: false,
        running: [],
      });
    }
  );
});

describe('stopChild', () => {
  it('stops a tool that ignores its stdin, and its descendants, through the process group', async () => {
    const tool = spawnTool(process.execPath, ['-e', TOOL_SOURCE], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const pids = await readPids(tool.stdout);
    const exited = new Promise((resolve) => tool.once('close', resolve));
    await stopChild(tool, exited, 200);
    expect(await waitUntilGone(pids)).toEqual([]);
  });
});

describe('prepareRawDirectory', () => {
  it('creates a missing directory 0700', () => {
    const raw = join(temporaryDirectory(), 'raw');
    const checkout = temporaryDirectory();
    expect(prepareRawDirectory(raw, checkout)).toBe(raw);
    expect(statSync(raw).mode & 0o777).toBe(0o700);
  });

  it('accepts an empty private directory without changing it', () => {
    const raw = join(temporaryDirectory(), 'raw');
    mkdirSync(raw, { mode: 0o700 });
    expect(prepareRawDirectory(raw, temporaryDirectory())).toBe(raw);
  });

  it('refuses a directory that already holds captures', () => {
    const raw = join(temporaryDirectory(), 'raw');
    mkdirSync(raw, { mode: 0o700 });
    writeFileSync(join(raw, 'acp.raw.jsonl'), '{}\n');
    expect(() => prepareRawDirectory(raw, temporaryDirectory())).toThrow(/empty directory/);
  });

  it('refuses a directory others can read, and leaves its mode alone', () => {
    const raw = join(temporaryDirectory(), 'raw');
    mkdirSync(raw);
    chmodSync(raw, 0o755);
    expect(() => prepareRawDirectory(raw, temporaryDirectory())).toThrow(/chmod 700/);
    expect(statSync(raw).mode & 0o777).toBe(0o755);
  });

  it('stops when something appears at the path before it is created', () => {
    const raced = join(temporaryDirectory(), 'raw');
    mkdirSync(raced, { mode: 0o755 });
    expect(() => createPrivateDirectory(raced)).toThrow(/appeared while it was being created/);
    expect(statSync(raced).mode & 0o777).toBe(0o755);
    const link = join(temporaryDirectory(), 'link');
    symlinkSync(temporaryDirectory(), link);
    expect(() => createPrivateDirectory(link)).toThrow(/appeared while it was being created/);
  });

  it('creates missing parents as well as the directory', () => {
    const raw = join(temporaryDirectory(), 'a', 'b', 'raw');
    expect(prepareRawDirectory(raw, temporaryDirectory())).toBe(raw);
    expect(statSync(raw).mode & 0o777).toBe(0o700);
  });

  it('refuses a directory inside the checkout, also through a symlink', () => {
    const checkout = temporaryDirectory();
    expect(() => prepareRawDirectory(join(checkout, 'raw'), checkout)).toThrow(/outside/);
    expect(existsSync(join(checkout, 'raw'))).toBe(false);
    const elsewhere = temporaryDirectory();
    symlinkSync(checkout, join(elsewhere, 'link'));
    expect(() => prepareRawDirectory(join(elsewhere, 'link', 'raw'), checkout)).toThrow(/outside/);
    expect(existsSync(join(checkout, 'raw'))).toBe(false);
  });
});
