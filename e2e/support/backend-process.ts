import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  armCrashPoint as arm,
  declaredCrashPoints,
  disarmCrashPoint as disarm,
} from '../../scripts/sandbox/crash-points.mjs';
import { sandboxPaths } from '../../scripts/sandbox/paths.mjs';
import { readSandbox } from '../sandbox/sandbox';

// Control of the sandbox's backend process, for specs that kill it, stop it or crash it and then
// start it again. The global setup runs the sandbox in restart mode (`--restartable`), where the
// server process is scripts/sandbox/restartable-server.mjs: it holds the backend as its child and
// keeps Vite and the data directory when the backend exits. This spec process reaches it over
// HTTP on 127.0.0.1, at the URL and with the bearer token it writes to
// `<baseDir>/backend-control.json` (mode 0600). It signals only that child, through its handle.
//
// The rule for every spec that kills or stops the backend: end with `ensureBackendRunning()` in an
// `afterEach` (or `finally`), pass or fail, because every later spec shares this backend.
//
// Crash points are armed by a file, which the server reads at `crashAt('<name>')` (see
// src/backend/services/crash-point.ts); names are checked against the source.

const controlSchema = z.object({ url: z.url(), token: z.string().min(1) });
const exitSchema = z.object({ code: z.number().nullable(), signal: z.string().nullable() });
const statusSchema = z.object({
  state: z.enum(['starting', 'running', 'paused', 'exited']),
  pid: z.number().nullable(),
  generation: z.number(),
  lastExit: exitSchema.nullable(),
});
const errorSchema = z.object({ error: z.string() });

export type BackendStatus = z.infer<typeof statusSchema>;
export type BackendSignal = 'SIGKILL' | 'SIGTERM' | 'SIGINT' | 'SIGSTOP' | 'SIGCONT';

/** A restart compiles the backend under load: allow what the launcher allows a first start. */
const RESTART_TIMEOUT_MS = 180_000;
const POLL_MS = 100;

function paths() {
  return sandboxPaths(readSandbox().baseDir);
}

async function control(method: 'GET' | 'POST', path: string, body?: object) {
  const file = paths().backendControl;
  if (!existsSync(file)) {
    throw new Error(`${file} is missing: the sandbox is not running in restart mode.`);
  }
  const { url, token } = controlSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(RESTART_TIMEOUT_MS + 10_000),
  });
  const json: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${errorSchema.parse(json).error}`);
  }
  return statusSchema.parse(json);
}

export function backendStatus(): Promise<BackendStatus> {
  return control('GET', '/status');
}

/**
 * Sends `signal` to the backend. SIGKILL, SIGTERM and SIGINT resolve once it has exited (a crash,
 * or a graceful stop); SIGSTOP freezes it with its sockets open and SIGCONT resumes it.
 */
export function killBackend(signal: BackendSignal): Promise<BackendStatus> {
  return control('POST', '/signal', { signal });
}

/** Starts the backend again on the same port and resolves once it answers `/health`. */
export async function restartBackend(): Promise<BackendStatus> {
  const status = await control('POST', '/restart');
  await waitForBackendHealth();
  return status;
}

/** Resolves once the backend's `/health` answers 200. */
export async function waitForBackendHealth(timeoutMs = RESTART_TIMEOUT_MS) {
  const { backendUrl } = readSandbox();
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        return;
      }
      last = `status ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`The backend did not answer /health within ${timeoutMs} ms (${last}).`);
}

/** Resolves with how the backend ended, once it has (after a crash point, for example). */
export async function waitForBackendExit(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await backendStatus();
    if (status.state === 'exited' && status.lastExit) {
      return status.lastExit;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`The backend was still running ${timeoutMs} ms later.`);
}

/**
 * Leaves the backend running and healthy whatever state a spec left it in: continued if stopped,
 * restarted if exited. Call it from `afterEach` in every spec that kills or stops the backend.
 */
export async function ensureBackendRunning() {
  let status = await backendStatus();
  if (status.state === 'paused') {
    status = await killBackend('SIGCONT');
  }
  if (status.state === 'exited') {
    await control('POST', '/restart');
  }
  await waitForBackendHealth();
}

/**
 * Arms a crash point: the next time the server reaches `crashAt(name)` it dies with SIGKILL, and
 * the point disarms itself, so the server restarts unarmed. Throws for a name no code declares.
 */
export function armCrashPoint(name: string) {
  arm(paths().crashPointDir, name, declaredCrashPoints());
}

export function disarmCrashPoint(name: string) {
  disarm(paths().crashPointDir, name);
}

/** Whether `name` is armed: false once the server has crashed there. */
export function isCrashPointArmed(name: string) {
  return existsSync(join(paths().crashPointDir, name));
}

const logRecordSchema = z.object({
  level: z.string(),
  timestamp: z.string(),
  message: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});
export type ServerLogRecord = z.infer<typeof logRecordSchema>;

/**
 * The backend's structured log (`<baseDir>/logs/server.log`, info and above), oldest first, across
 * restarts. Records are JSON lines; any other line is skipped.
 */
export function readServerLog(): ServerLogRecord[] {
  const file = paths().serverLog;
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const record = logRecordSchema.safeParse(JSON.parse(line));
        return record.success ? [record.data] : [];
      } catch {
        return [];
      }
    });
}

/** What the server process wrote to its stdout and stderr (crash point lines go there). */
export function readServerOutput(): string {
  const file = paths().serverOutput;
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
