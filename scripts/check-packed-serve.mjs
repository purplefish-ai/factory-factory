// Run via npm exec in an isolated consumer directory, with the tarball on PATH.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { verifySetupTerminal } from './packed-setup-terminal.mjs';
import { stopProcessGroup } from './sandbox/process-group.mjs';

const [cachePath, phase = 'cold'] = process.argv.slice(2);
const windows = process.platform === 'win32';
const executable = windows ? 'factory-factory.cmd' : 'factory-factory';
const cache = realpathSync(cachePath);
const bin = (process.env.PATH ?? '').split(delimiter).find((dir) => {
  const keyDir = dirname(dirname(dir));
  return (
    existsSync(join(dir, executable)) &&
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

async function verifyTerminal(origin) {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/setup-terminal`, { origin });
  try {
    await verifySetupTerminal(socket, { z, windows });
  } finally {
    socket.terminate();
  }
}

function stopWindowsTree(pid) {
  try {
    execFileSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { timeout: 10_000 });
  } catch (error) {
    try {
      process.kill(pid, 0);
    } catch (probeError) {
      if (probeError.code === 'ESRCH') {
        return;
      }
    }
    throw error;
  }
}

const consumerHome = resolve('home');
mkdirSync(consumerHome, { recursive: true });
const baseDir = resolve('data');
const serveArgs = ['serve', '--no-open', '--host', '127.0.0.1'];
const child = spawn(
  windows ? 'cmd.exe' : join(bin, executable),
  windows ? ['/d', '/c', executable, ...serveArgs] : serveArgs,
  {
    detached: !windows,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      PATH: [bin, process.env.PATH].join(delimiter),
      HOME: consumerHome,
      npm_config_cache: cache,
      CI: 'true',
      RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID,
      BASE_DIR: baseDir,
      FF_EMIT_BACKEND_PORT: '1',
      DATABASE_PATH: resolve('data', 'test.db'),
      ...(windows
        ? {
            USERPROFILE: consumerHome,
            APPDATA: join(consumerHome, 'AppData', 'Roaming'),
            LOCALAPPDATA: join(consumerHome, 'AppData', 'Local'),
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            PATHEXT: process.env.PATHEXT,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
          }
        : { SHELL: '/bin/sh', TMPDIR: process.env.TMPDIR }),
    },
  }
);
// The backend reports the port it actually bound, including after a collision.
const lines = createInterface({ input: child.stdout });
let origin;
lines.on('line', (line) => {
  console.log(line);
  const match = /^BACKEND_PORT:(\d+)$/.exec(line);
  if (match) {
    origin = `http://127.0.0.1:${match[1]}`;
  }
});
const exited = once(child, 'exit');
async function verifyServer() {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Server exited during startup');
    }
    if (!origin) {
      await delay(500);
      continue;
    }
    const response = await fetch(`${origin}/health/database`, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => undefined);
    if (response?.status === 200) {
      z.object({ database: z.literal('connected') }).parse(await response.json());
      const page = await fetch(origin, { signal: AbortSignal.timeout(5000) });
      if (page.status !== 200 || !(await page.text()).includes('id="root"')) {
        throw new Error('Missing packed UI');
      }
      await verifyTerminal(origin);
      return;
    }
    await delay(500);
  }
  throw new Error('Timeout waiting for packed database and UI');
}

const cancellation = new AbortController();
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const onCancel = (signal) =>
  cancellation.abort(new Error(`Consumer check interrupted by ${signal}`));
for (const signal of signals) {
  process.on(signal, onCancel);
}

try {
  await Promise.race([
    once(cancellation.signal, 'abort').then(() => cancellation.signal.throwIfAborted()),
    verifyServer(),
    exited.then(([code, signal]) => {
      throw new Error(`serve exited: ${code ?? signal}`);
    }),
  ]);
} finally {
  try {
    if (child.pid) {
      if (windows) {
        if (child.exitCode === null && child.signalCode === null) {
          stopWindowsTree(child.pid);
        }
      } else {
        await stopProcessGroup(child.pid, { baseDir, graceMs: 5000 });
      }
    }
  } finally {
    for (const signal of signals) {
      process.off(signal, onCancel);
    }
  }
}
cancellation.signal.throwIfAborted();
console.log(`Packed UI, database and setup terminal passed on Node ${process.version}`);
