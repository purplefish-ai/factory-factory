import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Starts one sandbox (`pnpm dev:sandbox`) for the run and stops it afterwards. The spec finds
// its sandbox.json through FF_SANDBOX_JSON.

const repoRoot = resolve(import.meta.dirname, '..');
// Uploaded by CI when the run fails; emptied at the start of each run.
const evidenceDir = join(repoRoot, 'test-results', 'sandbox-logs');
const evidenceFiles = ['server-output.log', 'egress-calls.log', 'gh-calls.log'];
// The launcher writes here directly, not through a pipe to this runner: if the runner dies,
// the launcher can still log while it stops the sandbox.
const launcherLog = join(evidenceDir, 'launcher.log');

// The launcher allows the server 180 s to start, then seeds it; a machine at load 100+ needs most of that.
const READY_TIMEOUT_MS = 300_000;
// How often the launcher's log is read for SANDBOX_READY.
const READY_POLL_MS = 250;
// Stopping signals the server's process group, waits for it and deletes the sandbox directory.
const STOP_TIMEOUT_MS = 60_000;
// Only reached if both the teardown and the owner check fail.
const TTL_MINUTES = 20;
// The launcher's exit code after a SIGTERM it handled by stopping cleanly.
const STOPPED_BY_SIGTERM = 143;

const isRunning = (launcher: ChildProcess) =>
  launcher.exitCode === null && launcher.signalCode === null;

/** Resolves with the path of sandbox.json once the launcher prints SANDBOX_READY. */
function waitForReady(launcher: ChildProcess): Promise<string> {
  return new Promise((resolveReady, reject) => {
    const settle = (result: { path: string } | { error: string }) => {
      clearInterval(poll);
      clearTimeout(timer);
      launcher.off('exit', onExit);
      if ('path' in result) {
        resolveReady(result.path);
      } else {
        reject(new Error(`${result.error} See ${launcherLog}.`));
      }
    };
    const poll = setInterval(() => {
      const path = /^SANDBOX_READY (.+)$/m.exec(readFileSync(launcherLog, 'utf8'))?.[1];
      if (path) {
        settle({ path });
      }
    }, READY_POLL_MS);
    const timer = setTimeout(
      () =>
        settle({
          error: `The sandbox printed no SANDBOX_READY line within ${READY_TIMEOUT_MS} ms.`,
        }),
      READY_TIMEOUT_MS
    );
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle({
        error: `The sandbox launcher exited with ${signal ?? `code ${code}`} before it was ready.`,
      });
    launcher.once('exit', onExit);
  });
}

/** Stops the launcher and confirms it stopped cleanly and removed its sandbox. */
async function stop(launcher: ChildProcess, sandboxDir: string | null) {
  const running = isRunning(launcher);
  if (running) {
    const exited = once(launcher, 'exit');
    launcher.kill('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The sandbox launcher did not exit within ${STOP_TIMEOUT_MS} ms.`)),
        STOP_TIMEOUT_MS
      );
    });
    try {
      await Promise.race([exited, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!running || launcher.exitCode !== STOPPED_BY_SIGTERM) {
    throw new Error(
      `The sandbox launcher ${running ? 'stopped' : 'had already stopped'} with ${launcher.signalCode ?? `code ${launcher.exitCode}`}; see ${launcherLog}.`
    );
  }
  if (sandboxDir && existsSync(sandboxDir)) {
    throw new Error(`The sandbox launcher exited but left ${sandboxDir} behind.`);
  }
}

export default async function globalSetup() {
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });
  const log = openSync(launcherLog, 'a');
  // Owned by this runner: an interrupted run stops the sandbox within seconds.
  const launcher = spawn(
    process.execPath,
    [
      join(repoRoot, 'scripts', 'dev-sandbox.mjs'),
      '--owner-pid',
      String(process.pid),
      '--ttl-minutes',
      String(TTL_MINUTES),
    ],
    { cwd: repoRoot, stdio: ['ignore', log, log] }
  );
  closeSync(log);

  let sandboxJson: string;
  try {
    sandboxJson = await waitForReady(launcher);
  } catch (error) {
    if (isRunning(launcher)) {
      await stop(launcher, null);
    }
    throw error;
  }
  const sandboxDir = dirname(sandboxJson);
  process.env.FF_SANDBOX_JSON = sandboxJson;

  return async () => {
    try {
      // Copied while the sandbox still exists: stopping deletes its directory.
      for (const file of evidenceFiles) {
        if (existsSync(join(sandboxDir, file))) {
          copyFileSync(join(sandboxDir, file), join(evidenceDir, file));
        }
      }
    } finally {
      await stop(launcher, sandboxDir);
    }
  };
}
