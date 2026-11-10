import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Application } from './app-context';

// The real tRPC gate and WebSocket upgrade preamble, behind one mutation and
// one channel, so the test exercises exactly what a browser window reaches.
vi.mock('@/backend/trpc/index', async () => {
  const { createContext, publicProcedure, router } =
    await vi.importActual<typeof import('./trpc/trpc')>('./trpc/trpc');
  return {
    appRouter: router({ write: publicProcedure.mutation(() => 'written') }),
    createContext,
  };
});

vi.mock('@/backend/routers/websocket', async () => {
  const { createWebSocketUpgradeHandler } = await vi.importActual<
    typeof import('./routers/websocket/upgrade-utils')
  >('./routers/websocket/upgrade-utils');
  const createChannel = (application: Application) =>
    createWebSocketUpgradeHandler({
      connectionName: 'chat',
      configService: application.services.configService,
      logger: application.services.createLogger('test'),
      onOpen: (ws) => ws.close(1000, 'opened'),
    });
  return {
    createChatUpgradeHandler: createChannel,
    createTerminalUpgradeHandler: createChannel,
    createSetupTerminalUpgradeHandler: createChannel,
    createDevLogsUpgradeHandler: createChannel,
    createPostRunLogsUpgradeHandler: createChannel,
    createSnapshotsUpgradeHandler: createChannel,
    createVoiceUpgradeHandler: createChannel,
    disposeChatTransportForApplication: vi.fn(),
    disposeSnapshotsHandlerState: vi.fn(),
  };
});

import { createServer } from './server';
import { createTestHarness } from './server.test-helpers';
import { configService } from './services/config.service';

const ORIGINAL_ENV = { ...process.env };
const servers: ReturnType<typeof createServer>[] = [];
const blockers: NetServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    blockers.splice(0).map((blocker) => new Promise((resolve) => blocker.close(resolve)))
  );
  process.env = { ...ORIGINAL_ENV };
  configService.reload();
});

async function listenBlocker(port: number, host: string): Promise<number> {
  const blocker = createNetServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, host, resolve);
  });
  blockers.push(blocker);
  const address = blocker.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  return address.port;
}

/**
 * Starts the server with its requested port already taken, as when `ff serve`
 * or another desktop instance holds 3001, so it binds a fallback port that no
 * launcher put in CORS_ALLOWED_ORIGINS.
 */
async function startOnFallbackPort(
  backendHost: string | undefined,
  configuredOrigins: (requestedPort: number) => string = (port) => `http://localhost:${port}`
) {
  const requestedPort = await listenBlocker(0, '127.0.0.1');
  // `localhost` may resolve to `::1`; hold that family too where it exists.
  await listenBlocker(requestedPort, '::1').catch(() => undefined);

  // The real configuration, as a launcher's environment produces it.
  process.env = { ...ORIGINAL_ENV, CORS_ALLOWED_ORIGINS: configuredOrigins(requestedPort) };
  Reflect.deleteProperty(process.env, 'DISABLE_CORS_CHECKS');
  if (backendHost === undefined) {
    Reflect.deleteProperty(process.env, 'BACKEND_HOST');
  } else {
    process.env.BACKEND_HOST = backendHost;
  }
  configService.reload();
  const harness = createTestHarness({ backendHost });
  harness.services.configService.getCorsConfig = () => configService.getCorsConfig();
  harness.services.configService.getBackendHost = () => configService.getBackendHost();

  const server = createServer(harness.application, requestedPort);
  servers.push(server);
  await server.start();
  const port = server.getPort();
  expect(port).not.toBe(requestedPort);
  const address = server.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  // `localhost` binds whichever family resolves first; dial that address.
  return { target: { address: address.address, port }, requestedPort };
}

type Target = { address: string; port: number };

function postMutation(
  { address, port }: Target,
  headers: Record<string, string>
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ json: null });
    httpRequest(
      {
        host: address,
        port,
        method: 'POST',
        path: '/api/trpc/write',
        agent: false,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    )
      .on('error', reject)
      .end(body);
  });
}

/** Resolves `open` when the upgrade succeeds, else the rejecting HTTP status. */
function upgrade({ address, port }: Target, origin: string): Promise<'open' | number> {
  const urlHost = address.includes(':') ? `[${address}]` : address;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${urlHost}:${port}/chat`, {
      origin,
      headers: { host: `localhost:${port}` },
    });
    ws.once('open', () => {
      resolve('open');
      ws.terminate();
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('error', (error) => {
      // A raw-socket rejection (`HTTP/1.1 400`) surfaces as a parse error.
      const match = /Unexpected server response: (\d+)/.exec(error.message);
      if (match?.[1]) {
        resolve(Number(match[1]));
        return;
      }
      reject(error);
    });
  });
}

describe('server own origin on a fallback port', () => {
  it.each([
    ['unset (desktop app)', undefined],
    ['localhost (ff serve)', 'localhost'],
    ['127.0.0.1 (ff proxy)', '127.0.0.1'],
  ])('allows its own loopback origin when BACKEND_HOST is %s', async (_label, backendHost) => {
    const { target } = await startOnFallbackPort(backendHost);

    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      const origin = `http://${hostname}:${target.port}`;
      const results = {
        mutation: await postMutation(target, { origin, host: `${hostname}:${target.port}` }),
        upgrade: await upgrade(target, origin),
      };
      expect(results).toEqual({ mutation: 200, upgrade: 'open' });
    }
  });

  it('still rejects a loopback origin on a port the server did not bind', async () => {
    const { target } = await startOnFallbackPort(undefined);
    const origin = `http://localhost:${target.port + 1}`;

    await expect(postMutation(target, { origin, host: `localhost:${target.port}` })).resolves.toBe(
      403
    );
    await expect(upgrade(target, origin)).resolves.toBe(400);
  });

  it('still rejects a cross-site origin and a DNS-rebound Host', async () => {
    const { target } = await startOnFallbackPort(undefined);
    const host = `localhost:${target.port}`;

    await expect(postMutation(target, { origin: 'https://attacker.example', host })).resolves.toBe(
      403
    );
    await expect(upgrade(target, 'https://attacker.example')).resolves.toBe(400);
    // The rebound page's own origin and Host, with and without an Origin.
    const rebound = `attacker.example:${target.port}`;
    await expect(
      postMutation(target, { origin: `http://${rebound}`, host: rebound })
    ).resolves.toBe(403);
    await expect(postMutation(target, { host: rebound })).resolves.toBe(403);
  });

  it('implies nothing when a public origin is configured (ff tailscale, reverse proxy)', async () => {
    const { target } = await startOnFallbackPort('127.0.0.1', () => 'https://mac.tail123.ts.net');
    // A proxy forwards a remote page on that user's own localhost at this port.
    const origin = `http://localhost:${target.port}`;

    await expect(postMutation(target, { origin, host: `localhost:${target.port}` })).resolves.toBe(
      403
    );
    await expect(upgrade(target, origin)).resolves.toBe(400);
  });

  it('keeps accepting the configured origins', async () => {
    const { target, requestedPort } = await startOnFallbackPort(undefined);
    const origin = `http://localhost:${requestedPort}`;

    await expect(postMutation(target, { origin, host: `localhost:${target.port}` })).resolves.toBe(
      200
    );
    await expect(upgrade(target, origin)).resolves.toBe('open');
  });
});
