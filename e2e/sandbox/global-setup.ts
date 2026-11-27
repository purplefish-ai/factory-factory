import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';

// Starts one sandbox (`pnpm dev:sandbox --restartable`) for the run and stops it afterwards. Every
// spec in this directory shares it, and finds its sandbox.json through FF_SANDBOX_JSON (see
// `./sandbox.ts`). Restart mode lets a spec kill and restart the backend (e2e/support/
// backend-process.ts); a spec that does must leave it running for the next.

const repoRoot = resolve(import.meta.dirname, '..', '..');
// Uploaded by CI when the run fails; emptied at the start of each run.
const evidenceDir = join(repoRoot, 'test-results', 'sandbox-logs');
const evidenceFiles = [
  'server-output.log',
  'logs/server.log',
  'egress-calls.log',
  'gh-calls.log',
  'claude-calls.log',
];
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

const recordSchema = z.object({ pid: z.number() });
// Reading the session runtime combination counts is informational: it never fails the run.
const COMBINATIONS_TIMEOUT_MS = 10_000;
const backendSchema = z.object({ backendUrl: z.url() });
const healthSchema = z.object({ sessionRuntimeCombinations: z.record(z.string(), z.unknown()) });

/**
 * Prints the sandbox server's session runtime combination counts to the job output, for the
 * runtime state redesign decision. Best effort: any failure (a backend a spec left down, for one)
 * prints a note and the run goes on. Counts start again at each backend restart.
 */
async function printRuntimeCombinations(sandboxJson: string) {
  try {
    const { backendUrl } = backendSchema.parse(JSON.parse(readFileSync(sandboxJson, 'utf8')));
    const response = await fetch(`${backendUrl}/health/all`, {
      signal: AbortSignal.timeout(COMBINATIONS_TIMEOUT_MS),
    });
    const { sessionRuntimeCombinations } = healthSchema.parse(await response.json());
    process.stdout.write(
      `session runtime combinations: ${JSON.stringify(sessionRuntimeCombinations)}\n`
    );
  } catch (error) {
    process.stdout.write(`session runtime combinations: unavailable (${String(error)})\n`);
  }
}

/**
 * Keeps the server's output from a start that fails. The launcher deletes the sandbox directory
 * before this runner can read it, and prints only the last lines of the output, so the file is
 * copied while the launcher waits for the server. The directory is found by the launcher's pid in
 * its record, and only directories changed since this starts: a stale one can carry a reused pid.
 * Best effort: the file and the directory can vanish at any moment.
 */
function startupEvidenceKeeper(launcher: ChildProcess) {
  const root = join(tmpdir(), 'ff-sandbox');
  const since = Date.now() - 5000;
  let sandboxDir: string | null = null;
  const owns = (name: string) => {
    try {
      const record = recordSchema.safeParse(
        JSON.parse(readFileSync(join(root, name, 'sandbox.json'), 'utf8'))
      );
      return (
        record.success &&
        record.data.pid === launcher.pid &&
        statSync(join(root, name)).mtimeMs >= since
      );
    } catch {
      // Another sandbox's record, half written or already removed.
      return false;
    }
  };
  return () => {
    try {
      sandboxDir ??= readdirSync(root).find(owns) ?? null;
      if (sandboxDir) {
        copyFileSync(
          join(root, sandboxDir, 'server-output.log'),
          join(evidenceDir, 'server-output.log')
        );
      }
    } catch {
      // Not there yet, or already gone.
    }
  };
}

const isRunning = (launcher: ChildProcess) =>
  launcher.exitCode === null && launcher.signalCode === null;

/** Resolves with the path of sandbox.json once the launcher prints SANDBOX_READY. */
function waitForReady(launcher: ChildProcess, keepStartupEvidence: () => void): Promise<string> {
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
      keepStartupEvidence();
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
      '--restartable',
    ],
    { cwd: repoRoot, stdio: ['ignore', log, log] }
  );
  closeSync(log);

  let sandboxJson: string;
  try {
    sandboxJson = await waitForReady(launcher, startupEvidenceKeeper(launcher));
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
      await printRuntimeCombinations(sandboxJson);
      // Copied while the sandbox still exists: stopping deletes its directory.
      for (const file of evidenceFiles) {
        if (existsSync(join(sandboxDir, file))) {
          copyFileSync(join(sandboxDir, file), join(evidenceDir, basename(file)));
        }
      }
    } finally {
      await stop(launcher, sandboxDir);
    }
  };
}
