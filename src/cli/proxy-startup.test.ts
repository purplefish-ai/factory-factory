import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

// The fake backend binds a decoy port D and its real port P = D * 10 + 7 itself
// (retrying on conflicts), so a startup line cut off before P's last digit names
// a port that accepts connections. Both stay bound until the process is killed.
const SPLIT_LINE_BACKEND = `const { createServer } = require('node:http');
const listen = (port, body) => new Promise((resolve) => {
  const server = createServer((_req, res) => res.end(body));
  server.once('error', () => resolve(null));
  server.listen(port, '127.0.0.1', () => resolve(server));
});
(async () => {
  for (let decoyPort = 4100; decoyPort < 6500; decoyPort += 37) {
    const decoy = await listen(decoyPort, 'decoy');
    if (!decoy) continue;
    const port = decoyPort * 10 + 7;
    if (await listen(port, 'backend')) {
      const line = 'BACKEND_PORT:' + port;
      process.stdout.write(line.slice(0, -1));
      setTimeout(() => process.stdout.write(line.slice(-1) + '\\n'), 300);
      return;
    }
    decoy.close();
  }
  process.exit(1);
})();
`;

it('waits for the complete BACKEND_PORT line when stdout splits it across chunks', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'ff-proxy-split-'));
  let backend: Awaited<ReturnType<typeof startFactoryFactoryServer>> | undefined;
  try {
    await mkdir(join(projectRoot, 'dist', 'client'), { recursive: true });
    await mkdir(join(projectRoot, 'dist', 'src', 'backend'), { recursive: true });
    await writeFile(join(projectRoot, 'dist', 'src', 'backend', 'index.js'), SPLIT_LINE_BACKEND);

    backend = await startFactoryFactoryServer({
      projectRoot,
      databasePath: join(projectRoot, 'data.db'),
      requestedPort: 3001,
    });
    // A truncated port would reach the decoy instead of the backend.
    const response = await fetch(`http://127.0.0.1:${backend.port}`);
    expect(await response.text()).toBe('backend');
  } finally {
    if (backend && backend.process.exitCode === null && backend.process.signalCode === null) {
      const exited = once(backend.process, 'exit');
      backend.process.kill();
      await exited;
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it('confines Tailscale proxy trust and origin settings to its loopback backend', async () => {
  vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://unrelated.example');
  vi.stubEnv('DISABLE_CORS_CHECKS', 'true');
  vi.stubEnv('DOTENV_OVERRIDE', 'true');
  const projectRoot = await mkdtemp(join(tmpdir(), 'ff-tailscale-startup-'));
  await mkdir(join(projectRoot, 'dist', 'client'), { recursive: true });
  await mkdir(join(projectRoot, 'dist', 'src', 'backend'), { recursive: true });
  await writeFile(
    join(projectRoot, '.env'),
    'TRUST_PROXY_HEADERS=false\nCORS_ALLOWED_ORIGINS=https://wrong.example\nDISABLE_CORS_CHECKS=true\n'
  );
  await writeFile(
    join(projectRoot, 'dist', 'src', 'backend', 'index.js'),
    `
require(${JSON.stringify(createRequire(import.meta.url).resolve('dotenv/config'))});
const { createServer } = require('node:http');
const server = createServer((_req, res) => res.end(JSON.stringify({
  host: process.env.BACKEND_HOST,
  trust: process.env.TRUST_PROXY_HEADERS,
  origin: process.env.CORS_ALLOWED_ORIGINS,
  disableChecks: process.env.DISABLE_CORS_CHECKS
})));
server.listen(0, process.env.BACKEND_HOST, () => console.log('BACKEND_PORT:' + server.address().port));
`
  );
  let backend: Awaited<ReturnType<typeof startFactoryFactoryServer>> | undefined;
  try {
    backend = await startFactoryFactoryServer({
      projectRoot,
      databasePath: join(projectRoot, 'data.db'),
      requestedPort: 3001,
      trustedProxyOrigin: 'https://mac.tail123.ts.net',
    });
    expect(await (await fetch(`http://127.0.0.1:${backend.port}`)).json()).toEqual({
      host: '127.0.0.1',
      trust: 'true',
      origin: 'https://mac.tail123.ts.net',
      disableChecks: 'false',
    });
  } finally {
    if (backend && backend.process.exitCode === null && backend.process.signalCode === null) {
      const exited = once(backend.process, 'exit');
      backend.process.kill();
      await exited;
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});

it('cancels startup after the backend port signal without an unhandled error', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'ff-startup-abort-'));
  await mkdir(join(projectRoot, 'dist', 'client'), { recursive: true });
  await mkdir(join(projectRoot, 'dist', 'src', 'backend'), { recursive: true });
  await writeFile(
    join(projectRoot, 'dist', 'src', 'backend', 'index.js'),
    `
console.log('BACKEND_PORT:1');
setInterval(() => {}, 1000);
`
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await expect(
      startFactoryFactoryServer({
        projectRoot,
        databasePath: join(projectRoot, 'data.db'),
        requestedPort: 3001,
        signal: controller.signal,
      })
    ).rejects.toThrow(/abort/i);
  } finally {
    clearTimeout(timer);
    await rm(projectRoot, { recursive: true, force: true });
  }
}, 2000);
