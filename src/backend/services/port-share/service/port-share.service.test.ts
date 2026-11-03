import { once } from 'node:events';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortShareError, PortShareService } from './port-share.service';
import { ShareRecordStore } from './share-records';

/** Mimics foreground `tailscale serve`: listed in `serve status` until signalled. */
const FAKE_TAILSCALE = `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = process.env.FAKE_TAILSCALE_STATE;
const read = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { ports: {} }; } };
const write = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
const [command, sub, target] = process.argv.slice(2);
if (command === 'serve' && sub === 'status') {
  const tcp = {};
  for (const port of Object.keys(read().ports)) tcp[port] = { HTTPS: true };
  console.log(JSON.stringify({ TCP: tcp }));
  process.exit(0);
}
if (command === 'serve') {
  if (process.env.FAKE_TAILSCALE_FAIL) { console.error('serve config denied'); process.exit(1); }
  const port = sub.replace('--https=', '');
  const state = read();
  state.ports[port] = { target, pid: process.pid };
  write(state);
  const stop = () => { const next = read(); delete next.ports[port]; write(next); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setInterval(() => {}, 1000);
}
`;

const config = {
  origin: 'https://mac.tail123.ts.net',
  hostname: 'mac.tail123.ts.net',
  httpsPort: 443,
};

describe.skipIf(process.platform === 'win32')('PortShareService', () => {
  let directory: string;
  let statePath: string;
  let command: string;
  let service: PortShareService;
  const servers: Server[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ff-port-share-'));
    statePath = join(directory, 'state.json');
    command = join(directory, 'tailscale');
    await writeFile(command, FAKE_TAILSCALE);
    await chmod(command, 0o755);
    vi.stubEnv('FAKE_TAILSCALE_STATE', statePath);
    service = createService();
  });

  afterEach(async () => {
    await service.cleanup();
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
    );
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  function createService(
    overrides: { backendPort?: number; tailscale?: typeof config | null } = {}
  ) {
    return new PortShareService({
      getTailscaleConfig: () => (overrides.tailscale === undefined ? config : overrides.tailscale),
      getBackendPort: () => overrides.backendPort ?? 3001,
      records: new ShareRecordStore(join(directory, 'records'), 999),
      tailscaleCommand: command,
      readyTimeoutMs: 5000,
    });
  }

  async function listen(
    handler: Parameters<typeof createServer>[1] = (_req, res) => res.end('ok')
  ) {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('no address');
    }
    return address.port;
  }

  async function readState(): Promise<{ ports: Record<string, { target: string; pid: number }> }> {
    return JSON.parse(await readFile(statePath, 'utf8'));
  }

  async function expectFailure(promise: Promise<unknown>, reason: string) {
    await expect(promise).rejects.toSatisfy(
      (error) => error instanceof PortShareError && error.reason === reason
    );
  }

  it('shares a port once through a Host-rewriting forwarder and stops it on cleanup', async () => {
    const port = await listen((req, res) => res.end(req.headers.host));
    const [first, second] = await Promise.all([service.ensure(port), service.ensure(port)]);
    expect(first).toBe(`https://mac.tail123.ts.net:${port}`);
    expect(second).toBe(first);
    expect(await service.ensure(port)).toBe(first);

    const shares = (await readState()).ports;
    expect(Object.keys(shares)).toEqual([String(port)]);
    const target = shares[String(port)]?.target ?? '';
    expect(target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(target)).text()).toBe(`localhost:${port}`);
    expect(await readdir(join(directory, 'records'))).toEqual(['999.json']);

    await service.cleanup();
    expect((await readState()).ports).toEqual({});
    expect(await readdir(join(directory, 'records'))).toEqual([]);
    await expect(fetch(target)).rejects.toThrow();
  });

  it('refuses ports it must never share', async () => {
    await expectFailure(service.ensure(80), 'PRIVILEGED');
    await expectFailure(service.ensure(3001), 'FACTORY_FACTORY');
    await expectFailure(
      createService({ tailscale: { ...config, httpsPort: 8443 } }).ensure(8443),
      'FACTORY_FACTORY'
    );
    await expectFailure(service.ensure(5432), 'SERVICE');
    const backend = await listen((_req, res) =>
      res.end(JSON.stringify({ status: 'ok', service: 'factoryfactory-backend' }))
    );
    await expectFailure(service.ensure(backend), 'FACTORY_FACTORY');
  });

  it('shares servers whose /health response is large', async () => {
    const port = await listen((_req, res) => res.end('x'.repeat(64 * 1024)));
    await expect(service.ensure(port)).resolves.toBe(`https://mac.tail123.ts.net:${port}`);
  });

  it('reports a port with nothing listening', async () => {
    const port = await listen();
    await new Promise((resolve) => servers.pop()?.close(resolve));
    await expectFailure(service.ensure(port), 'NOT_LISTENING');
  });

  it('is unavailable outside ff tailscale', async () => {
    service = createService({ tailscale: null });
    expect(service.isAvailable()).toBe(false);
    await expectFailure(service.ensure(6173), 'DISABLED');
  });

  it('does not take over a Serve port configured elsewhere', async () => {
    const port = await listen();
    await writeFile(statePath, JSON.stringify({ ports: { [port]: { target: 'x', pid: 1 } } }));
    await expectFailure(service.ensure(port), 'PORT_IN_USE');
  });

  it('surfaces Serve failures and keeps no share', async () => {
    vi.stubEnv('FAKE_TAILSCALE_FAIL', '1');
    const port = await listen();
    await expect(service.ensure(port)).rejects.toThrow('serve config denied');
    expect(service.listSharedPorts()).toEqual([]);
  });

  it('forgets a share whose Serve process exits', async () => {
    const port = await listen();
    await service.ensure(port);
    const pid = (await readState()).ports[String(port)]?.pid;
    expect(pid).toBeDefined();
    process.kill(pid ?? 0, 'SIGTERM');
    await vi.waitFor(() => expect(service.listSharedPorts()).toEqual([]));
  });
});
