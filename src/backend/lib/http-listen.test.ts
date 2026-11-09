import {
  Agent,
  createServer as createHttpServer,
  request as httpRequest,
  type Server,
} from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenHttpServer } from './http-listen';

type Cleanup = () => Promise<void>;
const cleanups: Cleanup[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function closeServer(server: NetServer): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

function createTestHttpServer(): Server {
  const server = createHttpServer((req, res) => {
    res.end(`ok ${req.socket.remoteAddress}`);
  });
  return server;
}

async function listenAndTrack(server: Server, port: number, host: string | undefined) {
  const closeExtra = await listenHttpServer(server, port, host);
  cleanups.push(async () => {
    server.closeAllConnections();
    await Promise.all([closeExtra(), closeServer(server)]);
  });
  return closeExtra;
}

function boundPort(server: NetServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server is not listening on a TCP port');
  }
  return address.port;
}

function get(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path: '/', agent: false, timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function occupy(port: number, host: string): Promise<NetServer> {
  const blocker = createNetServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, host, resolve);
  });
  cleanups.push(() => closeServer(blocker));
  return blocker;
}

async function isIpv6LoopbackAvailable(): Promise<boolean> {
  const probe = createNetServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '::1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await closeServer(probe);
  }
}

function findNonLoopbackIpv4(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  return undefined;
}

const ipv6Available = await isIpv6LoopbackAvailable();
const nonLoopbackIpv4 = findNonLoopbackIpv4();

describe('listenHttpServer without a configured host', () => {
  it('binds 127.0.0.1 rather than every interface', async () => {
    const server = createTestHttpServer();
    await listenAndTrack(server, 0, undefined);

    expect(server.address()).toMatchObject({ address: '127.0.0.1' });
    await expect(get('127.0.0.1', boundPort(server))).resolves.toBe('ok 127.0.0.1');
  });

  it.runIf(ipv6Available)('also serves ::1 on the same port', async () => {
    const server = createTestHttpServer();
    await listenAndTrack(server, 0, undefined);

    await expect(get('::1', boundPort(server))).resolves.toBe('ok ::1');
  });

  it('serves the localhost name the server advertises', async () => {
    const server = createTestHttpServer();
    await listenAndTrack(server, 0, undefined);

    await expect(get('localhost', boundPort(server))).resolves.toMatch(/^ok (127\.0\.0\.1|::1)$/);
  });

  it.runIf(nonLoopbackIpv4)('is not reachable on a non-loopback interface', async () => {
    const server = createTestHttpServer();
    await listenAndTrack(server, 0, undefined);

    await expect(get(nonLoopbackIpv4 ?? '', boundPort(server))).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    });
  });

  it.runIf(ipv6Available)(
    'reports EADDRINUSE and releases 127.0.0.1 when ::1 is taken',
    async () => {
      const blocker = await occupy(0, '::1');
      const port = boundPort(blocker);
      const server = createTestHttpServer();

      await expect(listenHttpServer(server, port, undefined)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      });
      expect(server.listening).toBe(false);
      // The IPv4 half was released, so the port can be bound there again.
      await occupy(port, '127.0.0.1');
    }
  );

  it('reports EADDRINUSE when 127.0.0.1 is taken', async () => {
    const blocker = await occupy(0, '127.0.0.1');
    const server = createTestHttpServer();

    await expect(listenHttpServer(server, boundPort(blocker), undefined)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    expect(server.listening).toBe(false);
  });

  it.runIf(ipv6Available)('closes the ::1 listener with keep-alive connections open', async () => {
    const server = createTestHttpServer();
    const closeExtra = await listenHttpServer(server, 0, undefined);
    const port = boundPort(server);
    const agent = new Agent({ keepAlive: true });
    cleanups.push(async () => agent.destroy());
    await new Promise<void>((resolve, reject) => {
      httpRequest({ host: '::1', port, agent }, (res) => {
        res.resume();
        res.on('end', resolve);
      })
        .on('error', reject)
        .end();
    });

    // A plain close, as at shutdown: the idle ::1 connection must not block it.
    await Promise.all([closeExtra(), new Promise((resolve) => server.close(resolve))]);

    await expect(get('::1', port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(get('127.0.0.1', port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe('listenHttpServer with a configured host', () => {
  it('binds exactly the configured host', async () => {
    const server = createTestHttpServer();
    const listenSpy = vi.spyOn(server, 'listen');
    await listenAndTrack(server, 0, '0.0.0.0');

    expect(listenSpy).toHaveBeenCalledWith(0, '0.0.0.0');
    expect(server.address()).toMatchObject({ address: '0.0.0.0' });
  });
});
