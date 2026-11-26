// Run via npm exec in an isolated consumer directory, with the tarball on PATH.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [cachePath, phase = 'cold'] = process.argv.slice(2);
const cache = realpathSync(cachePath);
const bin = (process.env.PATH ?? '').split(delimiter).find((dir) => {
  const keyDir = dirname(dirname(dir));
  return (
    existsSync(join(dir, 'factory-factory')) &&
    existsSync(keyDir) &&
    dirname(realpathSync(keyDir)) === join(cache, '_npx')
  );
});
if (!bin) {
  throw new Error('Factory Factory executable missing from isolated npx entry');
}
const entry = dirname(dirname(bin));
const packageRoot = join(dirname(bin), 'factory-factory');
const requireInstalled = createRequire(join(packageRoot, 'package.json'));
const { WebSocket } = requireInstalled('ws');
const { z } = requireInstalled('zod');
const marker = join(entry, '.factory-factory-smoke-runtime');
if (phase === 'upgrade') {
  const previous = readFileSync(marker, 'utf8');
  if (previous === process.version) {
    throw new Error('Expected a different cached Node runtime');
  }
  console.log(`Reusing ${entry} across Node ${previous} -> ${process.version}`);
} else {
  writeFileSync(marker, process.version);
}
writeFileSync('installed-package.txt', packageRoot);

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((done) => socket.close(done));
  return port;
}

const terminalMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('created') }),
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('exit'), exitCode: z.number() }),
]);

async function verifyTerminal(origin) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/setup-terminal`, { origin });
  try {
    await new Promise((done, fail) => {
      let output = '';
      socket.on('open', () => socket.send(JSON.stringify({ type: 'create' })));
      socket.on('error', fail);
      socket.on('close', () => fail(new Error('Setup terminal disconnected')));
      socket.on('message', (data) => {
        try {
          const message = terminalMessage.parse(JSON.parse(data.toString()));
          if (message.type === 'created') {
            // The expected line never appears in the echoed shell command.
            socket.send(JSON.stringify({ type: 'input', data: "printf 'packed-%s\\n' ready\r" }));
          } else if (message.type === 'output') {
            output = (output + message.data).slice(-8192);
            if (output.includes('packed-ready')) {
              done();
            }
          } else {
            fail(new Error(`Setup terminal: ${JSON.stringify(message)}`));
          }
        } catch (error) {
          fail(error);
        }
      });
      const timer = setTimeout(() => fail(new Error('Setup terminal timed out')), 15_000);
      timer.unref();
      socket.once('close', () => clearTimeout(timer));
    });
  } finally {
    socket.terminate();
  }
}

const consumerHome = resolve('home');
mkdirSync(consumerHome, { recursive: true });
const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const child = spawn(
  join(bin, 'factory-factory'),
  ['serve', '--no-open', '--host', '127.0.0.1', '--port', String(port)],
  {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      PATH: process.env.PATH,
      HOME: consumerHome,
      TMPDIR: process.env.TMPDIR,
      npm_config_cache: cache,
      CI: 'true',
      BASE_DIR: resolve('data'),
      DATABASE_PATH: resolve('data', 'test.db'),
      SHELL: '/bin/sh',
    },
  }
);
const exited = once(child, 'exit');
async function verifyServer() {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Server exited during startup');
    }
    const response = await fetch(`${origin}/health/database`, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => undefined);
    if (response?.ok) {
      z.object({ database: z.literal('connected') }).parse(await response.json());
      const page = await fetch(origin, { signal: AbortSignal.timeout(5000) });
      if (!page.ok || !(await page.text()).includes('id="root"')) {
        throw new Error('Missing packed UI');
      }
      await verifyTerminal(origin);
      return;
    }
    await delay(500);
  }
  throw new Error('Timeout waiting for packed database and UI');
}

function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

try {
  await Promise.race([
    verifyServer(),
    exited.then(([code, signal]) => {
      throw new Error(`serve exited: ${code ?? signal}`);
    }),
  ]);
  console.log(`Packed UI, database and setup terminal passed on Node ${process.version}`);
} finally {
  if (child.pid) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        signalGroup('SIGTERM');
      }
      await Promise.race([exited, delay(5000, null, { ref: false })]);
    } finally {
      signalGroup('SIGKILL');
    }
  }
}
