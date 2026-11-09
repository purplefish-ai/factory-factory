import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/backend/routers/websocket', () => ({
  createChatUpgradeHandler: vi.fn(() => vi.fn()),
  createTerminalUpgradeHandler: vi.fn(() => vi.fn()),
  createSetupTerminalUpgradeHandler: vi.fn(() => vi.fn()),
  createDevLogsUpgradeHandler: vi.fn(() => vi.fn()),
  createPostRunLogsUpgradeHandler: vi.fn(() => vi.fn()),
  createSnapshotsUpgradeHandler: vi.fn(() => vi.fn()),
  createVoiceUpgradeHandler: vi.fn(() => vi.fn()),
  disposeChatTransportForApplication: vi.fn(),
  disposeSnapshotsHandlerState: vi.fn(),
}));

vi.mock('@/backend/trpc/index', () => ({
  appRouter: {},
  createContext: vi.fn(() => () => ({})),
}));

vi.mock('@trpc/server/adapters/express', () => ({
  createExpressMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createServer } from './server';
import { createTestHarness } from './server.test-helpers';

const servers: ReturnType<typeof createServer>[] = [];
const blockers: NetServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(
    blockers.splice(0).map((blocker) => new Promise((resolve) => blocker.close(resolve)))
  );
});

async function listenBlocker(port: number, host: string): Promise<NetServer> {
  const blocker = createNetServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, host, resolve);
  });
  blockers.push(blocker);
  return blocker;
}

function portOf(server: NetServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address');
  }
  return address.port;
}

/** Asks the OS for a currently free loopback port. */
async function findFreePort(): Promise<number> {
  const probe = await listenBlocker(0, '127.0.0.1');
  const port = portOf(probe);
  blockers.splice(blockers.indexOf(probe), 1);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function getHealthStatus(host: string, port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    httpRequest({ host, port, path: '/health', agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    })
      .on('error', reject)
      .end();
  });
}

async function isIpv6LoopbackAvailable(): Promise<boolean> {
  try {
    const probe = await listenBlocker(0, '::1');
    blockers.splice(blockers.indexOf(probe), 1);
    await new Promise((resolve) => probe.close(resolve));
    return true;
  } catch {
    return false;
  }
}

const ipv6Available = await isIpv6LoopbackAvailable();

describe('server bind address', () => {
  it('binds loopback only and advertises localhost when BACKEND_HOST is unset', async () => {
    const port = await findFreePort();
    const harness = createTestHarness({ backendHost: undefined });
    const server = createServer(harness.application, port);
    servers.push(server);

    await expect(server.start()).resolves.toBe(`http://localhost:${port}`);

    expect(server.getHttpServer().address()).toMatchObject({ address: '127.0.0.1', port });
    await expect(getHealthStatus('127.0.0.1', port)).resolves.toBe(200);
    if (ipv6Available) {
      await expect(getHealthStatus('::1', port)).resolves.toBe(200);
    }

    await server.stop();
    await expect(getHealthStatus('127.0.0.1', port)).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
    if (ipv6Available) {
      await expect(getHealthStatus('::1', port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }
  });

  it.runIf(ipv6Available)(
    'moves to the next port when only the IPv6 loopback port is taken',
    async () => {
      const port = await findFreePort();
      await listenBlocker(port, '::1');
      const harness = createTestHarness({ backendHost: undefined });
      const server = createServer(harness.application, port);
      servers.push(server);

      await expect(server.start()).resolves.toBe(`http://localhost:${port + 1}`);
      expect(harness.logger.warn).toHaveBeenCalledWith('Requested port in use, using alternative', {
        requestedPort: port,
        actualPort: port + 1,
      });
    }
  );

  it('binds an explicitly configured host as given', async () => {
    const port = await findFreePort();
    const harness = createTestHarness({ backendHost: '0.0.0.0' });
    const server = createServer(harness.application, port);
    servers.push(server);

    await expect(server.start()).resolves.toBe(`http://0.0.0.0:${port}`);
    expect(server.getHttpServer().address()).toMatchObject({ address: '0.0.0.0', port });
  });
});
