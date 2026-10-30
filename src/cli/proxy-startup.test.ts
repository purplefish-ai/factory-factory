import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startFactoryFactoryServer } from './proxy';

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['default dotenv behavior', undefined, undefined],
  ['legacy dotenv override', 'true', undefined],
  ['current dotenv override', undefined, 'true'],
] as const)(
  'disables inherited forwarded-header trust with %s for both tunnel modes',
  async (_name, legacyOverride, override) => {
    vi.stubEnv('TRUST_PROXY_HEADERS', 'true');
    vi.stubEnv('DOTENV_CONFIG_OVERRIDE', legacyOverride);
    vi.stubEnv('DOTENV_OVERRIDE', override);
    const projectRoot = await mkdtemp(join(tmpdir(), 'ff-proxy-startup-'));
    await writeFile(join(projectRoot, '.env'), 'TRUST_PROXY_HEADERS=true\n');
    await mkdir(join(projectRoot, 'dist', 'client'), { recursive: true });
    await mkdir(join(projectRoot, 'dist', 'src', 'backend'), { recursive: true });
    await writeFile(
      join(projectRoot, 'dist', 'src', 'backend', 'index.js'),
      `require(${JSON.stringify(createRequire(import.meta.url).resolve('dotenv/config'))});
const { createServer } = require('node:http');
const server = createServer((_req, res) => res.end(process.env.TRUST_PROXY_HEADERS));
server.listen(0, '127.0.0.1', () => console.log('BACKEND_PORT:' + server.address().port));
`
    );
    let backend: Awaited<ReturnType<typeof startFactoryFactoryServer>> | undefined;
    try {
      backend = await startFactoryFactoryServer({
        projectRoot,
        databasePath: join(projectRoot, 'data.db'),
        requestedPort: 3001,
      });
      const response = await fetch(`http://127.0.0.1:${backend.port}`);
      expect(await response.text()).toBe('false');
    } finally {
      if (backend && backend.process.exitCode === null && backend.process.signalCode === null) {
        const exited = once(backend.process, 'exit');
        backend.process.kill();
        await exited;
      }
      await rm(projectRoot, { recursive: true, force: true });
    }
  }
);

function listen(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end('decoy'));
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function isFree(port: number): Promise<boolean> {
  const server = await listen(port);
  if (!server) {
    return false;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return true;
}

// Finds a listening decoy port D and a free port P = D * 10 + 7, so a startup
// line cut off before P's last digit names a port that accepts connections.
async function reserveDecoyPortPair(): Promise<{ decoy: Server; decoyPort: number; port: number }> {
  for (let decoyPort = 4100; decoyPort < 6500; decoyPort += 37) {
    const port = decoyPort * 10 + 7;
    if (!(await isFree(port))) {
      continue;
    }
    const decoy = await listen(decoyPort);
    if (decoy) {
      return { decoy, decoyPort, port };
    }
  }
  throw new Error('Could not reserve a decoy/backend port pair');
}

it('waits for the complete BACKEND_PORT line when stdout splits it across chunks', async () => {
  const { decoy, decoyPort, port } = await reserveDecoyPortPair();
  vi.stubEnv('FF_TEST_BACKEND_PORT', String(port));
  const projectRoot = await mkdtemp(join(tmpdir(), 'ff-proxy-split-'));
  await mkdir(join(projectRoot, 'dist', 'client'), { recursive: true });
  await mkdir(join(projectRoot, 'dist', 'src', 'backend'), { recursive: true });
  await writeFile(
    join(projectRoot, 'dist', 'src', 'backend', 'index.js'),
    `const { createServer } = require('node:http');
const port = Number(process.env.FF_TEST_BACKEND_PORT);
const server = createServer((_req, res) => res.end('backend'));
server.listen(port, '127.0.0.1', () => {
  const line = 'BACKEND_PORT:' + port;
  process.stdout.write(line.slice(0, -1));
  setTimeout(() => process.stdout.write(line.slice(-1) + '\\n'), 300);
});
`
  );

  let backend: Awaited<ReturnType<typeof startFactoryFactoryServer>> | undefined;
  try {
    backend = await startFactoryFactoryServer({
      projectRoot,
      databasePath: join(projectRoot, 'data.db'),
      requestedPort: port,
    });
    expect(backend.port).not.toBe(decoyPort);
    expect(backend.port).toBe(port);
  } finally {
    if (backend && backend.process.exitCode === null && backend.process.signalCode === null) {
      const exited = once(backend.process, 'exit');
      backend.process.kill();
      await exited;
    }
    await new Promise<void>((resolve) => decoy.close(() => resolve()));
    await rm(projectRoot, { recursive: true, force: true });
  }
});
