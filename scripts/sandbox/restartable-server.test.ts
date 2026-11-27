import { existsSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildServeEnv } from '@/cli/serve-env';
import { sandboxPaths } from './paths.mjs';
import { findFreePort } from './ports.mjs';
import { realSystem } from './process-group.mjs';
import { backendEnv, defaultCommands, runRestartableServer } from './restartable-server.mjs';
import { HELPER_LIFETIME_MS, temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

// Stand-ins for the backend and Vite: each listens on its port at localhost, and ends by itself
// after HELPER_LIFETIME_MS if a test is interrupted. The backend reports its port as the real
// one does, and answers every request with its own pid.
const listener = (portVariable: string, report: boolean) => `
const { createServer } = require('node:http');
const port = Number(process.env.${portVariable});
createServer((_request, response) => response.end(String(process.pid))).listen(port, 'localhost', () => {
  ${report ? "process.stdout.write('BACKEND_PORT:' + port + '\\n');" : ''}
});
setTimeout(() => process.exit(0), ${HELPER_LIFETIME_MS}).unref();
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;

const statusSchema = z.object({
  state: z.string(),
  pid: z.number().nullable(),
  generation: z.number(),
  lastExit: z.object({ code: z.number().nullable(), signal: z.string().nullable() }).nullable(),
});

/** One request; resolves with the status code and the parsed body. */
function call(url: string, options: { method?: string; token?: string; body?: object } = {}) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
        agent: false,
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) })
        );
      }
    );
    outgoing.on('error', reject);
    outgoing.end(options.body ? JSON.stringify(options.body) : undefined);
  });
}

async function started() {
  const baseDir = temporary.create('ff-restartable-');
  const paths = sandboxPaths(baseDir);
  const ports = { frontend: await findFreePort(), backend: await findFreePort() };
  const env = backendEnv({ PATH: process.env.PATH }, ports, paths.databasePath);
  const node = (source: string) => ({
    command: process.execPath,
    args: ['-e', source],
    cwd: baseDir,
    env: { ...env, FRONTEND_PORT_FOR_TEST: String(ports.frontend) },
  });
  let stopSignal: (() => void) | undefined;
  const logs: string[] = [];
  const done = runRestartableServer({
    baseDir,
    ports,
    commands: {
      migrate: node(''),
      backend: node(listener('BACKEND_PORT', true)),
      frontend: node(listener('FRONTEND_PORT_FOR_TEST', false)),
    },
    onSignal: (signal: string, handler: () => void) => {
      if (signal === 'SIGTERM') {
        stopSignal = handler;
      }
    },
    log: (text: string) => logs.push(text),
    startupTimeoutMs: 30_000,
  });
  const deadline = Date.now() + 30_000;
  while (!existsSync(paths.portFile) && Date.now() < deadline) {
    await realSystem.sleep(50);
  }
  const { url, token } = z
    .object({ url: z.string(), token: z.string() })
    .parse(JSON.parse(readFileSync(paths.backendControl, 'utf8')));
  const control = async (method: string, path: string, body?: object) => {
    const response = await call(`${url}${path}`, { method, token, ...(body ? { body } : {}) });
    return { status: response.status, body: response.body };
  };
  const status = async () => statusSchema.parse((await control('GET', '/status')).body);
  const backendPid = async () => Number((await call(`http://localhost:${ports.backend}/`)).body);
  return {
    baseDir,
    paths,
    ports,
    url,
    done,
    logs,
    control,
    status,
    backendPid,
    stop: () => stopSignal?.(),
  };
}

describe('the restartable server', () => {
  it('keeps the frontend when the backend is killed, and restarts the backend on the same port', async () => {
    const server = await started();
    try {
      expect(readFileSync(server.paths.portFile, 'utf8')).toBe(String(server.ports.frontend));
      expect(statSync(server.paths.backendControl).mode & 0o777).toBe(0o600);
      const first = await server.status();
      expect(first).toMatchObject({ state: 'running', generation: 1, lastExit: null });
      // A connection to the killed backend leaves the port in TIME_WAIT.
      expect(await server.backendPid()).toBe(first.pid);

      expect(await server.control('POST', '/signal', { signal: 'SIGKILL' })).toMatchObject({
        status: 200,
        body: { state: 'exited', lastExit: { code: null, signal: 'SIGKILL' } },
      });
      expect(await call(`http://localhost:${server.ports.frontend}/`)).toMatchObject({
        status: 200,
      });
      expect(await server.control('POST', '/signal', { signal: 'SIGSTOP' })).toMatchObject({
        status: 409,
      });

      expect(await server.control('POST', '/restart')).toMatchObject({
        status: 200,
        body: { state: 'running', generation: 2 },
      });
      const second = await server.status();
      expect(second.pid).not.toBe(first.pid);
      expect(await server.backendPid()).toBe(second.pid);
      expect(await server.control('POST', '/restart')).toMatchObject({ status: 409 });
    } finally {
      server.stop();
    }
    expect(await server.done).toBe(0);
    expect(existsSync(server.paths.backendControl)).toBe(false);
  });

  it('pauses and continues the backend, and continues it to stop', async () => {
    const server = await started();
    try {
      expect(await server.control('POST', '/signal', { signal: 'SIGSTOP' })).toMatchObject({
        status: 200,
        body: { state: 'paused' },
      });
      expect(await server.control('POST', '/signal', { signal: 'SIGCONT' })).toMatchObject({
        status: 200,
        body: { state: 'running' },
      });
      expect(await server.control('POST', '/signal', { signal: 'SIGSTOP' })).toMatchObject({
        status: 200,
      });
    } finally {
      // A stopped backend handles SIGTERM only once it continues.
      server.stop();
    }
    expect(await server.done).toBe(0);
  });

  it('refuses requests without its token, and signals it does not know', async () => {
    const server = await started();
    try {
      expect(await call(`${server.url}/status`)).toMatchObject({ status: 403 });
      expect(await call(`${server.url}/status`, { token: 'wrong' })).toMatchObject({ status: 403 });
      expect(await server.control('POST', '/signal', { signal: 'SIGUSR1' })).toMatchObject({
        status: 400,
      });
      expect(await server.status()).toMatchObject({ state: 'running', generation: 1 });
    } finally {
      server.stop();
    }
    expect(await server.done).toBe(0);
  });
});

describe('the restartable server commands', () => {
  it('give the backend the environment ff serve --dev gives it', () => {
    const env = { PATH: '/bin', BASE_DIR: '/tmp/ff-sandbox/sb-1' };
    const ports = { frontend: 4100, backend: 4101 };
    const commands = defaultCommands({ baseDir: '/tmp/ff-sandbox/sb-1', ports, env });
    expect(commands.backend.env).toEqual(
      buildServeEnv(
        { dev: true, host: 'localhost' },
        '/tmp/ff-sandbox/sb-1/data.db',
        4100,
        4101,
        env
      )
    );
    expect(commands.frontend.env).toMatchObject({ BACKEND_URL: 'http://localhost:4101' });
    expect(commands.backend.args.at(-1)).toMatch(/src\/backend\/index\.ts$/);
  });
});
