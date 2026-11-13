// The sandbox's `ff serve --dev` process: start it in its own process group,
// follow its output, and wait until it reports the ports it actually uses.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { checkReportedPorts, parseBackendPort, parsePortFile } from './ports.mjs';
import { STOP_GRACE_MS, stopProcessGroup } from './process-group.mjs';

export const STARTUP_TIMEOUT_MS = 180_000;

/**
 * Starts the server with `detached: true`, so its pid is its process group ID.
 * Spawn failures arrive through `onError` (an `'error'` event without a
 * listener would crash the launcher); `child.pid` is then undefined.
 *
 * @param {object} options
 * @param {ReturnType<typeof import('./paths.mjs').sandboxPaths>} options.paths
 * @param {NodeJS.ProcessEnv} options.env
 * @param {{ frontend: number, backend: number }} options.ports
 * @param {(code: number | null, signal: string | null) => void} options.onExit
 * @param {(error: Error) => void} options.onError
 * @param {(command: string, args: string[], options: object) => any} [options.spawnImpl]
 */
export function startServer({ paths, env, ports, onExit, onError, spawnImpl = spawn }) {
  const child = spawnImpl(
    process.execPath,
    [
      join(REPO_ROOT, 'src', 'cli', 'bootstrap.mjs'),
      'serve',
      '--dev',
      '--no-open',
      '--port',
      String(ports.frontend),
      '--backend-port',
      String(ports.backend),
    ],
    // cwd is the sandbox, so `ff serve` writes its port file there and loads no .env.
    { cwd: paths.baseDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const server = { child, exited: false, retiring: false, backendPort: null };
  child.on('error', (error) => onError(error));
  child.once('exit', (code, signal) => {
    server.exited = true;
    onExit(code, signal);
  });
  // The output is diagnostic only. The pipes can deliver it after the stopped
  // sandbox's directory is deleted, and a write can fail for other reasons (a
  // full disk); throwing here would crash the launcher before it cleans up.
  const keepOutput = (chunk) => {
    try {
      appendFileSync(paths.serverOutput, chunk);
    } catch {
      // Dropped: nowhere to keep it.
    }
  };
  // The backend reports its port once; keep only enough output to find that line.
  let pendingOutput = '';
  child.stdout?.on('data', (chunk) => {
    const output = pendingOutput + chunk.toString();
    server.backendPort ??= parseBackendPort(output);
    pendingOutput = output.slice(output.lastIndexOf('\n') + 1).slice(-4096);
    keepOutput(chunk);
  });
  child.stderr?.on('data', keepOutput);
  return server;
}

/**
 * Resolves `{ status: 'ready', ports }` once the server reports the requested
 * ports, or `{ status: 'mismatch', message }` as soon as it reports another.
 */
export async function waitForServer({
  paths,
  server,
  requested,
  system,
  timeoutMs = STARTUP_TIMEOUT_MS,
}) {
  const deadline = system.now() + timeoutMs;
  while (system.now() < deadline) {
    if (server.exited) {
      throw new Error('The server exited during startup.');
    }
    const frontend = existsSync(paths.portFile)
      ? parsePortFile(readFileSync(paths.portFile, 'utf8'))
      : null;
    const check = checkReportedPorts(requested, { frontend, backend: server.backendPort });
    if (check.status === 'ready') {
      return { status: 'ready', ports: requested };
    }
    if (check.status === 'mismatch') {
      return check;
    }
    await system.sleep(250);
  }
  throw new Error(`The server was not ready within ${timeoutMs / 1000} seconds.`);
}

/**
 * Stops a started server's whole group, identified by its leader's start time
 * or, before that is known, by `baseDir` in a member's environment.
 */
export async function stopServer(server, system, baseDir) {
  if (server?.pgid) {
    await stopProcessGroup(server.pgid, {
      system,
      leaderStartedAt: server.startedAt,
      baseDir,
    });
  }
}

/**
 * The fallback when the process table cannot be read during a stop: signals
 * the group of the server child this launcher spawned, SIGTERM then SIGKILL
 * after the grace period, but only while that child is unreaped. Resolves
 * whether it signalled. Never used for a group recorded by another launcher.
 *
 * @param {{ pid?: number, exitCode: number | null, signalCode: string | null } | null | undefined} child
 * @param {{ system: Pick<import('./process-group.mjs').ProcessSystem, 'now' | 'sleep'>, kill?: (target: number, signal: string) => unknown, graceMs?: number, pollMs?: number }} options
 * @returns {Promise<boolean>}
 */
export async function signalOwnServerGroup(
  child,
  {
    system,
    kill = (target, signal) => process.kill(target, signal),
    graceMs = STOP_GRACE_MS,
    pollMs = 200,
  }
) {
  // Node reaps a child and records `exitCode`/`signalCode` in one step, so both
  // still null means the leader is unreaped: its pid, and so its group ID,
  // cannot belong to anyone else yet. Checked in the same step as each kill.
  const unreaped = () =>
    Boolean(child?.pid) && child.exitCode === null && child.signalCode === null;
  const signal = (name) => {
    if (!unreaped()) {
      return false;
    }
    try {
      kill(-child.pid, name);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
    return true;
  };
  if (!signal('SIGTERM')) {
    return false;
  }
  const deadline = system.now() + graceMs;
  while (unreaped() && system.now() < deadline) {
    await system.sleep(pollMs);
  }
  signal('SIGKILL');
  return true;
}

export function tail(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-40).join('\n');
  } catch {
    return '';
  }
}
