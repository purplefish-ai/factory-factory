// Shared plumbing for the upstream recorder: versions, clean environments,
// the throwaway repository and line capture.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

const children = new Set();

/** Registers a child process so an interrupted run can kill it. */
export function trackChild(child) {
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

/** Paths an interrupted run removes: the temp directory (sign-in copy, raw captures), a half-written fixture directory. */
export const removeOnAbort = new Set();

/**
 * On SIGINT, SIGTERM, SIGHUP or an uncaught error: kills the tracked tools,
 * removes every path in `removeOnAbort` synchronously, then exits. Returns a
 * function that uninstalls the handlers.
 */
export function installAbortCleanup() {
  const abort = (code) => {
    for (const child of children) {
      child.kill('SIGKILL');
    }
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

/**
 * Ends a child: closes its stdin, sends SIGTERM after `graceMs`, and SIGKILL
 * after as long again, so a child that ignores SIGTERM cannot hang the run.
 */
export async function stopChild(child, exited, graceMs) {
  child.stdin?.end();
  const term = setTimeout(() => child.kill('SIGTERM'), graceMs);
  const kill = setTimeout(() => child.kill('SIGKILL'), graceMs * 2);
  await exited;
  clearTimeout(term);
  clearTimeout(kill);
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
