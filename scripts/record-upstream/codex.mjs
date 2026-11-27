// Records one synthetic Codex session through codex-acp, and the app-server
// reads the backend makes outside a turn.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startAcpSession } from './acp-session.mjs';
import { cleanEnvironment, lineSplitter, writeJsonLines } from './environment.mjs';

export const CODEX_SCENARIOS = [
  {
    scenario: 'plain-reply',
    text: 'Without using any tools, reply with two short sentences about why a README file is useful.',
  },
  {
    scenario: 'approved-command',
    text: 'Run exactly `sh count-words.sh` in this repository. Request escalated permissions for that command so that I am asked to approve it, then tell me its output in one sentence.',
    action: 'The session is in read-only mode; the permission request is answered with allow_once.',
  },
];

// Codex refreshes a sign-in older than eight days and rotates its refresh
// token. A refreshed copy would leave the owner's own auth.json stale.
const MAX_SIGN_IN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Copies the owner's Codex sign-in into an isolated CODEX_HOME (mode 0600). */
function prepareCodexHome(codexHome) {
  const source = join(homedir(), '.codex', 'auth.json');
  const lastRefresh = Date.parse(JSON.parse(readFileSync(source, 'utf8')).last_refresh ?? '');
  if (!(Date.now() - lastRefresh < MAX_SIGN_IN_AGE_MS)) {
    throw new Error('The Codex sign-in is due for a refresh; run Codex once yourself first');
  }
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const copy = join(codexHome, 'auth.json');
  copyFileSync(source, copy);
  chmodSync(copy, 0o600);
  return { copy, before: digest(copy) };
}

// The requests Factory Factory makes outside a turn (codex-accounts
// native-account.ts, session codex-plan-usage-loader.ts and
// codex-model-catalog-loader.ts).
const APP_SERVER_REQUESTS = [
  [
    'initialize',
    {
      clientInfo: { name: 'factory-factory-plan-usage', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    },
  ],
  ['account/read', { refreshToken: false }],
  ['account/rateLimits/read', undefined],
  ['model/list', { cursor: null, limit: 100, includeHidden: false }],
];

async function recordAppServer({ versions, env, cwd }) {
  const records = [];
  const child = spawn(process.execPath, [versions.adapterEntrypoint, 'cli', 'app-server'], {
    cwd,
    env: { ...env, DOTENV_CONFIG_QUIET: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Native stderr may carry account details; it is never kept.
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once('close', resolve));
  const pending = new Map();
  child.stdout.on(
    'data',
    lineSplitter((line) => {
      records.push({ dir: 'server->client', line });
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      } catch {
        /* Diagnostics are kept as lines only. */
      }
    })
  );
  const send = (message) => {
    const line = JSON.stringify(message);
    records.push({ dir: 'client->server', line });
    child.stdin.write(`${line}\n`);
  };
  try {
    let id = 0;
    for (const [method, params] of APP_SERVER_REQUESTS) {
      id += 1;
      const response = new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => reject(new Error(`${method} timed out`)), 30_000).unref();
      });
      send({ id, method, params });
      await response;
      if (method === 'initialize') {
        send({ method: 'initialized' });
      }
    }
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
    await exited;
    clearTimeout(timer);
  }
  return records;
}

function findRollouts(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...findRollouts(path));
    } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      found.push(path);
    }
  }
  return found;
}

/** Runs the scenarios with an isolated CODEX_HOME and HOME; writes raw captures. */
export async function recordCodex({ versions, repository, tmp, rawDir }) {
  const codexHome = join(tmp, 'codex-home');
  const home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const auth = prepareCodexHome(codexHome);
  try {
    const env = cleanEnvironment({
      home,
      tmp,
      extra: {
        CODEX_HOME: codexHome,
        DOTENV_CONFIG_QUIET: 'true',
        DISABLE_MCP_CONFIG_FILTERING: 'true',
      },
    });
    writeJsonLines(
      join(rawDir, 'app-server.raw.jsonl'),
      await recordAppServer({ versions, env, cwd: tmp })
    );
    const session = startAcpSession({
      entrypoint: versions.adapterEntrypoint,
      env,
      cwd: repository,
    });
    try {
      await session.initialize();
      const { sessionId } = await session.newSession({ cwd: repository, mcpServers: [] });
      await session.setMode({ sessionId, modeId: 'read-only' });
      for (const { scenario, text } of CODEX_SCENARIOS) {
        const result = await session.prompt({ sessionId, prompt: [{ type: 'text', text }] });
        console.log(`codex ${scenario}: stopReason=${result.stopReason}`);
      }
    } finally {
      await session.stop();
      writeJsonLines(join(rawDir, 'acp.raw.jsonl'), session.records);
    }
    if (session.permissions.length === 0) {
      console.warn('codex: no permission request was observed');
    }
    const rollouts = findRollouts(join(codexHome, 'sessions'));
    if (rollouts.length !== 1) {
      throw new Error(`Expected one Codex rollout, found ${rollouts.length}`);
    }
    copyFileSync(rollouts[0], join(rawDir, 'history.raw.jsonl'));
  } finally {
    if (digest(auth.copy) !== auth.before) {
      console.warn('codex: the sign-in copy changed during the run (a token refresh)');
    }
    rmSync(codexHome, { recursive: true, force: true });
  }
  return { createdOutsideTemp: [] };
}
