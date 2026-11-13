// The sandbox's `ff serve --dev` process: start it in its own process group,
// follow its output, and wait until it reports the ports it actually uses.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { checkReportedPorts, parseBackendPort, parsePortFile } from './ports.mjs';
import { stopProcessGroup } from './process-group.mjs';

export const STARTUP_TIMEOUT_MS = 180_000;

/**
 * Starts the server with `detached: true`, so its pid is its process group ID.
 * Spawn failures arrive through `onError` (an `'error'` event without a
 * listener would crash the launcher); `child.pid` is then undefined.
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
  // The backend reports its port once; keep only enough output to find that line.
  let pendingOutput = '';
  child.stdout?.on('data', (chunk) => {
    const output = pendingOutput + chunk.toString();
    server.backendPort ??= parseBackendPort(output);
    pendingOutput = output.slice(output.lastIndexOf('\n') + 1).slice(-4096);
    appendFileSync(paths.serverOutput, chunk);
  });
  child.stderr?.on('data', (chunk) => appendFileSync(paths.serverOutput, chunk));
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

/** Stops a started server's whole group, identified by its leader's start time. */
export async function stopServer(server, system) {
  if (server?.pgid && server.startedAt) {
    await stopProcessGroup(server.pgid, { system, leaderStartedAt: server.startedAt });
  }
}

export function tail(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-40).join('\n');
  } catch {
    return '';
  }
}
