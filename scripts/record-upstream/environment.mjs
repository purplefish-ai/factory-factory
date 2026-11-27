// Shared plumbing for the upstream recorder: versions, clean environments,
// the throwaway repository and line capture.
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const appRequire = createRequire(join(process.cwd(), 'package.json'));

export const PROVIDERS = {
  claude: {
    adapter: '@agentclientprotocol/claude-agent-acp',
    adapterBinary: 'claude-agent-acp',
    runtime: '@anthropic-ai/claude-agent-sdk',
  },
  codex: {
    adapter: '@agentclientprotocol/codex-acp',
    adapterBinary: 'codex-acp',
    runtime: '@openai/codex',
  },
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Mirrors scripts/prepare-runtime-metadata.mjs, which cannot be imported
// because it rewrites package.json when loaded.
function runtimeManifestPath(fromAdapter, runtime) {
  try {
    return fromAdapter.resolve(`${runtime}/package.json`);
  } catch {
    let directory = dirname(fromAdapter.resolve(runtime));
    while (true) {
      const path = join(directory, 'package.json');
      try {
        if (readJson(path).name === runtime) {
          return path;
        }
      } catch {
        /* The exported entrypoint may be nested inside its package. */
      }
      const parent = dirname(directory);
      if (parent === directory) {
        throw new Error(`Unable to locate ${runtime} package metadata`);
      }
      directory = parent;
    }
  }
}

/** Adapter and runtime versions, the runtime resolved from the adapter as shipped. */
export function resolveVersions(provider) {
  const { adapter, adapterBinary, runtime } = PROVIDERS[provider];
  const adapterManifestPath = appRequire.resolve(`${adapter}/package.json`);
  const adapterManifest = readJson(adapterManifestPath);
  const fromAdapter = createRequire(adapterManifestPath);
  const bin =
    typeof adapterManifest.bin === 'string'
      ? adapterManifest.bin
      : adapterManifest.bin[adapterBinary];
  return {
    adapter,
    adapterVersion: adapterManifest.version,
    adapterEntrypoint: join(dirname(adapterManifestPath), bin),
    runtime,
    runtimeVersion: readJson(runtimeManifestPath(fromAdapter, runtime)).version,
    fromAdapter,
  };
}

/** The recorder runs POSIX tools from fixed paths; it does not support Windows. */
export function assertSupportedPlatform() {
  if (process.platform === 'win32') {
    throw new Error('The upstream recorder runs on macOS and Linux only');
  }
}

/**
 * A minimal environment built from nothing, so none of the recorder's own
 * variables (database paths, session sockets and tokens) reach a recorded tool.
 * Git reads only an empty global configuration and no system one. `user` is
 * the account name the tool sees; only Claude needs the real one, for its
 * keychain sign-in.
 */
export function cleanEnvironment({ home, tmp, user = 'user', extra = {} }) {
  const gitConfig = join(tmp, 'empty-gitconfig');
  writeFileSync(gitConfig, '');
  return {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: home,
    USER: user,
    TMPDIR: tmp,
    TERM: 'dumb',
    LANG: 'en_US.UTF-8',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    // What Factory Factory adds when it spawns an adapter.
    BROWSER: 'none',
    ELECTRON_RUN_AS_NODE: '1',
    ...extra,
  };
}

// Process groups the recorder owns: each tool runs as the leader of its own
// group, so its descendants (the Claude CLI under the adapter, Codex under
// codex-acp) are signalled with it. A group stays here until it is empty.
const groups = new Set();
const GROUP_STOP_MS = 2000;

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false; // ESRCH: nothing left in the group.
  }
}

function groupAlive(pgid) {
  return signalGroup(pgid, 0);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Spawns a tool as the leader of a new process group the recorder owns, so a
 * stop or an abort reaches everything the tool started.
 */
export function spawnTool(command, args, options) {
  const child = spawn(command, args, { ...options, detached: true });
  if (child.pid !== undefined) {
    groups.add(child.pid);
  }
  return child;
}

/**
 * Ends a tool: closes its stdin and waits `graceMs` for it to exit, then
 * signals its whole group with SIGTERM and, after as long again, SIGKILL.
 * Once the leader has gone, anything left in the group gets the same.
 */
export async function stopChild(child, exited, graceMs) {
  const pgid = child.pid;
  child.stdin?.end();
  const term = setTimeout(() => signalGroup(pgid, 'SIGTERM'), graceMs);
  const kill = setTimeout(() => signalGroup(pgid, 'SIGKILL'), graceMs * 2);
  await exited;
  clearTimeout(term);
  clearTimeout(kill);
  if (groupAlive(pgid)) {
    signalGroup(pgid, 'SIGTERM');
    for (let waited = 0; waited < graceMs && groupAlive(pgid); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    signalGroup(pgid, 'SIGKILL');
  }
  groups.delete(pgid);
}

function isInside(child, parent) {
  const path = relative(parent, child);
  return path === '' || !(path.startsWith('..') || isAbsolute(path));
}

function assertPrivate(stats) {
  if (stats.uid !== process.getuid?.()) {
    throw new Error('--keep-raw directory belongs to another user; name a new directory');
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      '--keep-raw directory is readable by others; run chmod 700 on it or name a new directory'
    );
  }
}

/**
 * Creates `directory` itself (not its parents) 0700. If anything appeared at
 * that path since it was checked, mkdir fails with EEXIST and the run stops;
 * what was created must be a real directory, ours, with no group or other bits.
 */
export function createPrivateDirectory(directory) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('--keep-raw directory appeared while it was being created; try again');
    }
    throw error;
  }
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) {
    throw new Error('--keep-raw must name a directory');
  }
  assertPrivate(stats);
}

/**
 * Prepares the `--keep-raw` directory. Raw captures hold account details, so
 * the directory must be outside `checkout`, and either not exist yet (it is
 * created 0700) or be empty and private already. An existing directory is
 * never changed, so every capture is a new 0600 file and nothing is appended
 * to an older one.
 */
export function prepareRawDirectory(directory, checkout) {
  const realCheckout = realpathSync(checkout);
  // Resolve symlinks in the part of the path that exists before creating anything.
  let existing = resolve(directory);
  const missing = [];
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  if (isInside(join(realpathSync(existing), ...missing), realCheckout)) {
    throw new Error('--keep-raw must name a directory outside this repository');
  }
  if (!existsSync(directory)) {
    mkdirSync(dirname(resolve(directory)), { recursive: true, mode: 0o700 });
    createPrivateDirectory(directory);
  } else {
    if (!statSync(directory).isDirectory()) {
      throw new Error('--keep-raw must name a directory');
    }
    if (readdirSync(directory).length > 0) {
      throw new Error(
        '--keep-raw needs an empty directory; delete the old captures or name a new directory'
      );
    }
    assertPrivate(statSync(directory));
  }
  // A symlink can still lead into the checkout.
  const real = realpathSync(directory);
  if (isInside(real, realCheckout)) {
    throw new Error('--keep-raw must name a directory outside this repository');
  }
  return real;
}

/** Paths an interrupted run removes: the temp directory (sign-in copy, raw captures), a half-written fixture directory. */
export const removeOnAbort = new Set();

/**
 * On SIGINT, SIGTERM, SIGHUP or an uncaught error: signals every owned
 * process group with SIGTERM and then SIGKILL, removes every path in
 * `removeOnAbort` synchronously, then exits. Returns a function that
 * uninstalls the handlers.
 */
export function installAbortCleanup() {
  const abort = (code) => {
    for (const pgid of groups) {
      signalGroup(pgid, 'SIGTERM');
    }
    for (let waited = 0; waited < GROUP_STOP_MS && [...groups].some(groupAlive); waited += 50) {
      sleepSync(50);
    }
    for (const pgid of groups) {
      signalGroup(pgid, 'SIGKILL');
    }
    // The tools are gone before the sign-in copy and captures are removed.
    for (const path of removeOnAbort) {
      rmSync(path, { recursive: true, force: true });
    }
    process.exit(code);
  };
  const fail = (error) => {
    console.error(error);
    abort(1);
  };
  const handlers = {
    SIGINT: () => abort(130),
    SIGTERM: () => abort(143),
    SIGHUP: () => abort(129),
    uncaughtException: fail,
    unhandledRejection: fail,
  };
  for (const [event, handler] of Object.entries(handlers)) {
    process.on(event, handler);
  }
  return () => {
    for (const [event, handler] of Object.entries(handlers)) {
      process.off(event, handler);
    }
  };
}

export const REPOSITORY_FILES = {
  'README.md':
    '# Lighthouse Notes\n\nAn invented project used only to record a synthetic agent session.\nIt keeps short notes about imaginary lighthouses.\n',
  'notes.txt':
    'Cape Example lighthouse: red and white stripes.\nPoint Sample lighthouse: a green lamp.\n',
  'count-words.sh':
    '#!/bin/sh\n# Prints the word count of the two text files.\nwc -w README.md notes.txt\n',
};

/** Creates the throwaway git repository the sessions run in. */
export function createThrowawayRepository(directory, gitHome) {
  mkdirSync(directory, { recursive: true });
  mkdirSync(gitHome, { recursive: true });
  for (const [name, content] of Object.entries(REPOSITORY_FILES)) {
    writeFileSync(join(directory, name), content);
  }
  chmodSync(join(directory, 'count-words.sh'), 0o755);
  // An empty HOME keeps the owner's git configuration (signing, identity) out.
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: gitHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const git = (...args) => {
    const result = spawnSync(
      'git',
      ['-c', 'user.name=recorder', '-c', 'user.email=recorder', ...args],
      {
        cwd: directory,
        env,
        stdio: 'ignore',
      }
    );
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed in the throwaway repository`);
    }
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'Add lighthouse notes');
}

/** Splits a byte stream into lines and hands each non-empty line to `onLine`. */
export function lineSplitter(onLine) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return (chunk) => {
    buffer += decoder.write(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        onLine(line);
      }
      index = buffer.indexOf('\n');
    }
  };
}

/** Writes records as JSON lines; `mode` 0o600 for raw captures. */
export function writeJsonLines(path, records, mode = 0o644) {
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode });
}

export function readJsonLines(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
