#!/usr/bin/env node
// The sandbox's server in restart mode (`pnpm dev:sandbox --restartable`), in place of
// `ff serve --dev`: runs the migrations, the backend (directly, not under `tsx watch`, which
// would not restart a killed backend and would reload it on a file change) and Vite, and keeps
// Vite and the data directory when the backend exits. A spec then restarts the backend on the
// same port, which the browser's sockets and Vite's proxy point at.
//
// Control: an HTTP endpoint on 127.0.0.1, whose URL and bearer token are in
// `<baseDir>/backend-control.json` (mode 0600). `GET /status`; `POST /signal {"signal"}` with
// SIGKILL, SIGTERM, SIGINT, SIGSTOP or SIGCONT; `POST /restart`. Signals go to the backend child
// this process spawned, through its handle, never to a pid read elsewhere. e2e/support/
// backend-process.ts is the client.
//
// The launcher runs this as the leader of the sandbox's process group, as it runs `ff serve`, so
// its record, its stop and `--clean` are unchanged; the backend and Vite are in the group too.
// This process ends, and so the sandbox, when it is signalled or when Vite exits.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { REPO_ROOT, sandboxPaths } from './paths.mjs';
import { parseBackendPort } from './ports.mjs';

export const STARTUP_TIMEOUT_MS = 180_000;
/** How long a terminating signal may take to end the backend before the request fails. */
const EXIT_TIMEOUT_MS = 60_000;
const SIGNALS = ['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGSTOP', 'SIGCONT'];
const TERMINATING = new Set(['SIGKILL', 'SIGTERM', 'SIGINT']);
const signalRequestSchema = z.object({ signal: z.enum(SIGNALS) });

/**
 * The backend's environment as `ff serve --dev` builds it (`buildServeEnv` in
 * src/cli/serve-env.ts, for host `localhost`), on top of the sandbox's.
 */
export function backendEnv(env, { frontend, backend }, databasePath) {
  return {
    ...env,
    DATABASE_PATH: databasePath,
    FRONTEND_PORT: String(frontend),
    BACKEND_HOST: 'localhost',
    BACKEND_PORT: String(backend),
    NODE_ENV: 'development',
    CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS || `http://localhost:${frontend}`,
  };
}

/** The three programs, as `ff serve --dev` runs them; tests substitute their own. */
export function defaultCommands({ baseDir, ports, env }) {
  const paths = sandboxPaths(baseDir);
  const serverEnv = backendEnv(env, ports, paths.databasePath);
  return {
    // From the sandbox, as `ff serve` runs: bootstrap.mjs loads tsx through its node_modules link.
    migrate: {
      command: process.execPath,
      args: [
        join(REPO_ROOT, 'src', 'cli', 'bootstrap.mjs'),
        'db:migrate',
        '--database-path',
        paths.databasePath,
      ],
      cwd: baseDir,
      env,
    },
    backend: {
      command: process.execPath,
      args: ['--import', 'tsx', join(REPO_ROOT, 'src', 'backend', 'index.ts')],
      cwd: REPO_ROOT,
      env: serverEnv,
    },
    frontend: {
      command: join(REPO_ROOT, 'node_modules', '.bin', 'vite'),
      args: ['--port', String(ports.frontend), '--strictPort'],
      cwd: REPO_ROOT,
      env: { ...serverEnv, BACKEND_URL: `http://localhost:${ports.backend}` },
    },
  };
}

const describeExit = (exit) => (exit ? (exit.signal ?? `code ${exit.code}`) : 'nothing');

/** Resolves with how `child` ended; a child that could not be spawned ends with neither. */
function exitOf(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => {
      if (!child.pid) {
        resolve({ code: null, signal: null });
      }
    });
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Resolves once something accepts connections on `port` at localhost. */
async function waitForListening(port, isAbandoned) {
  while (!isAbandoned()) {
    const open = await new Promise((resolve) => {
      const socket = connect({ port, host: 'localhost' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (open) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Runs until signalled or until the frontend exits; resolves with this process's exit code.
 *
 * @param {object} options
 * @param {string} options.baseDir
 * @param {{ frontend: number, backend: number }} options.ports
 * @param {ReturnType<typeof defaultCommands>} options.commands
 * @param {(signal: string, handler: () => void) => unknown} [options.onSignal]
 * @param {(text: string) => unknown} [options.log]
 * @param {number} [options.startupTimeoutMs]
 */
export async function runRestartableServer({
  baseDir,
  ports,
  commands,
  onSignal = (signal, handler) => process.on(signal, handler),
  log = (text) => process.stderr.write(`restartable-server: ${text}\n`),
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
}) {
  const paths = sandboxPaths(baseDir);
  const children = new Set();
  /** The current backend: { child, generation, ready, paused }, or null before the first start. */
  let backend = null;
  let lastExit = null;
  let generation = 0;
  let restarting = false;
  let frontend = null;
  let control = null;
  let stopping = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const launch = ({ command, args, cwd, env }, stdio) => {
    const child = spawn(command, args, { cwd, env, stdio });
    children.add(child);
    void exitOf(child).then(() => children.delete(child));
    // A spawn failure arrives as 'error', and without a listener would end this process.
    child.on('error', (error) => log(`${command}: ${error.message}`));
    return child;
  };

  const backendAlive = () => backend && backend.child.exitCode === null && !backend.exited;

  const stop = (reason, code) => {
    stopping ??= (async () => {
      log(`stopping (${reason})`);
      if (backendAlive() && backend.paused) {
        backend.child.kill('SIGCONT');
      }
      for (const child of children) {
        child.kill('SIGTERM');
      }
      await Promise.all([...children].map(exitOf));
      control?.close();
      rmSync(paths.backendControl, { force: true });
      resolveDone(code);
    })();
    return stopping;
  };

  /** Starts a backend and resolves once it reports the requested port. */
  const startBackend = async () => {
    generation += 1;
    const child = launch(commands.backend, ['ignore', 'pipe', 'pipe']);
    const current = { child, generation, ready: false, paused: false, exited: false };
    backend = current;
    let output = '';
    let reportedPort = null;
    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
      if (reportedPort === null) {
        output = (output + chunk.toString()).slice(-8192);
        reportedPort = parseBackendPort(output);
      }
    });
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    const exit = exitOf(child).then((result) => {
      current.exited = true;
      lastExit = result;
      if (!stopping && current.ready) {
        log(
          `backend (pid ${child.pid}) exited with ${describeExit(result)}; restart it on request`
        );
      }
      return result;
    });
    const deadline = Date.now() + startupTimeoutMs;
    while (reportedPort === null && !current.exited && !stopping && Date.now() < deadline) {
      await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
    if (reportedPort === ports.backend) {
      current.ready = true;
      return current;
    }
    const failure =
      reportedPort !== null
        ? `the backend was to listen on port ${ports.backend} but reported ${reportedPort}`
        : current.exited
          ? `the backend exited with ${describeExit(lastExit)} during startup`
          : `the backend did not report its port within ${startupTimeoutMs} ms`;
    if (!current.exited) {
      child.kill('SIGKILL');
      await exit;
    }
    throw new Error(failure);
  };

  const reply = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const status = () => ({
    state: !backend
      ? 'starting'
      : backend.exited
        ? 'exited'
        : !backend.ready
          ? 'starting'
          : backend.paused
            ? 'paused'
            : 'running',
    pid: backend?.child.pid ?? null,
    generation,
    lastExit,
  });

  const handleSignal = async (body) => {
    const parsed = signalRequestSchema.safeParse(JSON.parse(body || '{}'));
    if (!parsed.success) {
      return [400, { error: `Send one of ${SIGNALS.join(', ')}.` }];
    }
    const { signal } = parsed.data;
    if (!(backendAlive() && backend.ready)) {
      return [409, { error: `The backend is not running (${status().state}).` }];
    }
    const current = backend;
    current.child.kill(signal);
    if (signal === 'SIGSTOP' || signal === 'SIGCONT') {
      current.paused = signal === 'SIGSTOP';
      return [200, status()];
    }
    if (current.paused && TERMINATING.has(signal)) {
      // A stopped process handles no signal but SIGKILL until it continues.
      current.child.kill('SIGCONT');
      current.paused = false;
    }
    await withTimeout(
      exitOf(current.child),
      EXIT_TIMEOUT_MS,
      `The backend did not exit within ${EXIT_TIMEOUT_MS} ms of ${signal}.`
    );
    return [200, status()];
  };

  const handleRestart = async () => {
    if (backendAlive() || restarting) {
      return [409, { error: `The backend is already ${restarting ? 'restarting' : 'running'}.` }];
    }
    restarting = true;
    try {
      await startBackend();
      log(`backend restarted (pid ${backend.child.pid}, generation ${generation})`);
      return [200, status()];
    } finally {
      restarting = false;
    }
  };

  const startControl = async () => {
    const token = randomBytes(24).toString('hex');
    control = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) {
        reply(response, 403, { error: 'Wrong or missing token.' });
        return;
      }
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const route = `${request.method} ${request.url}`;
        const handler =
          route === 'GET /status'
            ? async () => [200, status()]
            : route === 'POST /signal'
              ? () => handleSignal(body)
              : route === 'POST /restart'
                ? handleRestart
                : async () => [404, { error: `No route ${route}.` }];
        handler().then(
          ([code, result]) => reply(response, code, result),
          (error) =>
            reply(response, 500, { error: error instanceof Error ? error.message : String(error) })
        );
      });
    });
    control.listen(0, '127.0.0.1');
    await once(control, 'listening');
    const address = control.address();
    const temporary = `${paths.backendControl}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token, pid: process.pid })}\n`,
      { mode: 0o600 }
    );
    renameSync(temporary, paths.backendControl);
  };

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    onSignal(signal, () => void stop(signal, 0));
  }

  try {
    if (commands.migrate) {
      const migrate = launch(commands.migrate, 'inherit');
      const result = await exitOf(migrate);
      if (result.code !== 0) {
        throw new Error(`the migrations failed with ${describeExit(result)}`);
      }
    }
    if (!stopping) {
      await startBackend();
    }
    if (!stopping) {
      frontend = launch(commands.frontend, 'inherit');
      void exitOf(frontend).then((result) => {
        if (!stopping) {
          void stop(`the frontend exited with ${describeExit(result)}`, 1);
        }
      });
      await waitForListening(ports.frontend, () => Boolean(stopping) || frontend.exitCode !== null);
    }
    if (!stopping) {
      await startControl();
      // What `ff serve` writes once ready, and the launcher waits for.
      writeFileSync(paths.portFile, String(ports.frontend));
    }
  } catch (error) {
    void stop(`startup failed: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
  return done;
}

function readPort(argv, flag) {
  const value = Number(argv[argv.indexOf(flag) + 1]);
  if (!(argv.includes(flag) && Number.isInteger(value) && value > 0 && value < 65_536)) {
    throw new Error(`${flag} needs a port number.`);
  }
  return value;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', () => undefined);
  }
  const argv = process.argv.slice(2);
  const baseDir = process.env.BASE_DIR;
  if (!baseDir) {
    throw new Error('restartable-server needs BASE_DIR, the sandbox directory.');
  }
  const ports = {
    frontend: readPort(argv, '--frontend-port'),
    backend: readPort(argv, '--backend-port'),
  };
  process.exitCode = await runRestartableServer({
    baseDir,
    ports,
    commands: defaultCommands({ baseDir, ports, env: process.env }),
  });
}
