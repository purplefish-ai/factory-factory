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
