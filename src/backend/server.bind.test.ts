import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '@/test-utils/deferred';

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

async function releaseBlocker(blocker: NetServer): Promise<void> {
  const index = blockers.indexOf(blocker);
  if (index >= 0) {
    blockers.splice(index, 1);
  }
  await new Promise((resolve) => blocker.close(resolve));
}

/**
 * Holds the `count` ports starting at `port` on every loopback family, or
 * releases them all and returns null when one is taken.
 */
async function holdPorts(port: number, count: number): Promise<NetServer[] | null> {
  const hosts = ipv6Available ? ['127.0.0.1', '::1'] : ['127.0.0.1'];
  const held: NetServer[] = [];
  for (let offset = 0; offset < count; offset++) {
    for (const host of hosts) {
      const blocker = await listenBlocker(port + offset, host).catch(() => null);
      if (!blocker) {
        await Promise.all(held.map(releaseBlocker));
        return null;
      }
      held.push(blocker);
    }
  }
  return held;
}

// Below every operating system's ephemeral range (Linux from 32768, macOS and
// Windows from 49152), so no port the kernel assigns can be one of these.
const FIXED_PORT_FIRST = 20_000;
const FIXED_PORT_END = 30_000;

/**
 * Finds `count` consecutive ports free on both loopback families and returns
 * the first. Candidates come from outside the ephemeral ranges, so a
 * neighbour's `listen(0)` or outbound connection can never be given one. The
 * server must bind the ports itself, so they are released before it starts:
 * only a process that binds one of them by number in that gap can take it.
 */
async function findFreePorts(count: number): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const span = FIXED_PORT_END - FIXED_PORT_FIRST - count + 1;
    const port = FIXED_PORT_FIRST + Math.floor(Math.random() * span);
    const held = await holdPorts(port, count);
    if (held) {
      await Promise.all(held.map(releaseBlocker));
      return port;
    }
  }
  throw new Error(`Could not find ${count} consecutive ports free on both loopback families`);
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
    await releaseBlocker(await listenBlocker(0, '::1'));
    return true;
  } catch {
    return false;
  }
}

const ipv6Available = await isIpv6LoopbackAvailable();

describe('server bind address', () => {
  it('warms launcher capabilities without waiting for provider discovery', async () => {
    const harness = createTestHarness();
    const warming = deferred<undefined>();
    harness.services.sessionConfigService.warmLaunchOptions.mockImplementation(
      () => warming.promise
    );
    const server = createServer(harness.application, 0);
    servers.push(server);
    try {
      await server.start();
      expect(harness.services.sessionConfigService.warmLaunchOptions).toHaveBeenCalledOnce();
    } finally {
      warming.resolve(undefined);
    }
  });

  it('warms both model catalogs without waiting for them', async () => {
    const harness = createTestHarness();
    const listing = deferred<never[]>();
    harness.services.claudeModelCatalogService.getModels.mockImplementation(() => listing.promise);
    harness.services.codexModelCatalogService.getModels.mockImplementation(() => listing.promise);
    const server = createServer(harness.application, 0);
    servers.push(server);
    try {
      await server.start();
      expect(harness.services.claudeModelCatalogService.getModels).toHaveBeenCalledOnce();
      expect(harness.services.codexModelCatalogService.getModels).toHaveBeenCalledOnce();
    } finally {
      listing.resolve([]);
    }
  });

  it('binds loopback only and advertises localhost when BACKEND_HOST is unset', async () => {
    const port = await findFreePorts(1);
    const harness = createTestHarness({ backendHost: undefined });
    const server = createServer(harness.application, port);
    servers.push(server);

    await expect(server.start()).resolves.toBe(`http://localhost:${port}`);

    // Rotated server logs are pruned with the other startup log cleanups.
    expect(harness.services.cleanupOldLogFiles).toHaveBeenCalledOnce();
    expect(harness.services.sessionFileLogger.cleanupOldLogs).toHaveBeenCalledOnce();
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
      const port = await findFreePorts(2);
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
    const port = await findFreePorts(1);
    const harness = createTestHarness({ backendHost: '0.0.0.0' });
    const server = createServer(harness.application, port);
    servers.push(server);

    await expect(server.start()).resolves.toBe(`http://0.0.0.0:${port}`);
    expect(server.getHttpServer().address()).toMatchObject({ address: '0.0.0.0', port });
  });
});
