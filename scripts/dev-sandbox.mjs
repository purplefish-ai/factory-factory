#!/usr/bin/env node
// Starts the real application (`serve --dev`) in complete isolation so an agent
// can drive it without touching the developer's data, credentials or any
// external service. See USAGE below.
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE_CODEX = join(
  REPO_ROOT,
  'src',
  'backend',
  'testing',
  'fixtures',
  'fake-codex-app-server.mjs'
);
const GH_SHIM = join(REPO_ROOT, 'scripts', 'sandbox', 'gh-shim.mjs');
const STARTUP_TIMEOUT_MS = 180_000;

export const USAGE = `Usage: pnpm dev:sandbox [--scenario <name>] [--keep]
       pnpm dev:sandbox --clean

Starts the real app (serve --dev) in a new directory under <os tmpdir>/ff-sandbox/
with its own HOME, database, worktrees, Codex home and Claude configuration. Codex is
the fake app-server, gh records its calls and fails, update checks and Slack
intake are off, and no Anthropic or Claude credential reaches the server. Seeds
one project on a fresh Git repository with Codex as the default provider, then
prints one line: SANDBOX_READY <path to sandbox.json>.

On Ctrl+C, SIGTERM or server exit it stops every process it started and deletes
the sandbox directory.

  --scenario <name>  Passed to the fake Codex app-server as FF_SANDBOX_SCENARIO.
  --keep             Keep the sandbox directory after stopping.
  --clean            Stop and delete sandboxes whose launcher is no longer running.

macOS and Linux only.
`;

/** The directory every sandbox lives in. */
export function sandboxRoot(tempDir = tmpdir()) {
  return join(tempDir, 'ff-sandbox');
}

/**
 * True when `path` exists strictly inside the OS temporary directory. Real
 * paths are compared, since macOS temporary paths are symlinked.
 */
export function isInsideTempDir(path, tempDir = tmpdir()) {
  let target;
  let root;
  try {
    target = realpathSync(path);
    root = realpathSync(tempDir);
  } catch {
    return false;
  }
  const rel = relative(root, target);
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

export function assertInsideTempDir(path, tempDir = tmpdir()) {
  if (!isInsideTempDir(path, tempDir)) {
    throw new Error(
      `Refusing to use ${path} as BASE_DIR: it is not inside the OS temporary directory ${tempDir}.`
    );
  }
}

export function parseArgs(argv) {
  const options = { mode: 'run', scenario: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      return { ...options, mode: 'help' };
    }
    if (arg === '--clean') {
      options.mode = 'clean';
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--scenario') {
      const name = argv[index + 1];
      if (!(name && /^[A-Za-z0-9._-]+$/.test(name))) {
        throw new Error('--scenario needs a name made of letters, digits, ".", "_" or "-".');
      }
      options.scenario = name;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.mode === 'clean' && (options.keep || options.scenario)) {
    throw new Error('--clean takes no other options.');
  }
  return options;
}

/** Parent variables the server keeps; everything else, including credentials, is dropped. */
const INHERITED_VARIABLES = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG', 'TZ'];

/** Lets a caller point the release check at a local registry; never one carrying credentials. */
function registryUrlWithoutCredentials(value) {
  if (!(value && URL.canParse(value))) {
    return undefined;
  }
  const url = new URL(value);
  return url.username || url.password ? undefined : value;
}

export function sandboxPaths(baseDir) {
  return {
    baseDir,
    binDir: join(baseDir, 'bin'),
    home: join(baseDir, 'home'),
    worktreeBaseDir: join(baseDir, 'worktrees'),
    codexHome: join(baseDir, 'codex-home'),
    claudeConfigDir: join(baseDir, 'claude-config'),
    gitConfig: join(baseDir, 'gitconfig'),
    dotenv: join(baseDir, 'sandbox.env'),
    repoPath: join(baseDir, 'repo'),
    ghLog: join(baseDir, 'gh-calls.log'),
    serverOutput: join(baseDir, 'server-output.log'),
    portFile: join(baseDir, '.factory-factory-port'),
    sandboxJson: join(baseDir, 'sandbox.json'),
  };
}

/**
 * The complete server environment. Only the variables above are inherited, so
 * no API key, OAuth token or other credential in the launcher's environment
 * reaches the server, its providers or `git`, and `HOME` is inside the sandbox.
 * `nodeDir` (this Node's directory) precedes the rest of `PATH`, so `node`
 * never resolves to a version-manager shim that needs the real `HOME`.
 */
export function buildServerEnv({
  parentEnv,
  baseDir,
  scenario,
  nodeDir = dirname(process.execPath),
}) {
  const paths = sandboxPaths(baseDir);
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && (INHERITED_VARIABLES.includes(name) || name.startsWith('LC_'))) {
      env[name] = value;
    }
  }
  const registryUrl = registryUrlWithoutCredentials(parentEnv.FF_NPM_REGISTRY_URL);
  return {
    ...env,
    ...(registryUrl ? { FF_NPM_REGISTRY_URL: registryUrl } : {}),
    PATH: [paths.binDir, nodeDir, parentEnv.PATH].filter(Boolean).join(delimiter),
    HOME: paths.home,
    BASE_DIR: baseDir,
    WORKTREE_BASE_DIR: paths.worktreeBaseDir,
    CODEX_HOME: paths.codexHome,
    CODEX_PATH: join(paths.binDir, 'codex'),
    CLAUDE_CONFIG_DIR: paths.claudeConfigDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // The backend loads dotenv from the checkout; read an empty file instead.
    DOTENV_PATH: paths.dotenv,
    DOTENV_QUIET: 'true',
    FF_EMIT_BACKEND_PORT: '1',
    FF_UPDATE_CHECKS_ENABLED: 'false',
    AGENT_SLACK_INTAKE_ENABLED: 'false',
    ...(scenario ? { FF_SANDBOX_SCENARIO: scenario } : {}),
  };
}

/** The port the backend reports with `BACKEND_PORT:<port>`, or null. */
export function parseBackendPort(output) {
  const match = /(?:^|\n)BACKEND_PORT:(\d+)\r?\n/.exec(output);
  return match ? parsePort(match[1]) : null;
}

/** The frontend port `ff serve` writes to `.factory-factory-port` once ready, or null. */
export function parsePortFile(contents) {
  return /^\d+$/.test(contents.trim()) ? parsePort(contents.trim()) : null;
}

function parsePort(text) {
  const port = Number(text);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

const sandboxRecordSchema = z.object({
  baseDir: z.string().min(1),
  frontendUrl: z.string().nullable(),
  backendUrl: z.string().nullable(),
  pid: z.number().int().gt(1),
  pgid: z.number().int().gt(1),
  projectId: z.string().nullable(),
  repoPath: z.string(),
  scenario: z.string().nullable(),
});

export function readSandboxRecord(file) {
  try {
    const parsed = sandboxRecordSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeSandboxRecord(file, record) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temporary, file);
}

function sameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * Sandboxes `--clean` may remove: directories under `root` holding a valid
 * `sandbox.json` that names that same directory as `baseDir`, whose launcher
 * (`pid`) is no longer running.
 */
export function selectSandboxesToClean(root, isLauncherRunning) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const selected = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(root, entry.name);
    const record = readSandboxRecord(join(dir, 'sandbox.json'));
    if (record && sameRealPath(record.baseDir, dir) && !isLauncherRunning(record.pid)) {
      selected.push({ dir, record });
    }
  }
  return selected;
}

/** Parses `ps -A -o pid=,ppid=,pgid=,stat=`. */
export function parseProcessTable(output) {
  const processes = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (match) {
      processes.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        zombie: match[4].startsWith('Z'),
      });
    }
  }
  return processes;
}

/**
 * Live processes in the group plus their descendants, which can leave the
 * group (provider adapters run in their own process groups).
 */
export function collectGroupProcesses(processes, pgid) {
  const live = processes.filter((process) => !process.zombie);
  const found = new Set(live.filter((process) => process.pgid === pgid).map((p) => p.pid));
  let grew = true;
  while (grew) {
    grew = false;
    for (const process of live) {
      if (!found.has(process.pid) && found.has(process.ppid)) {
        found.add(process.pid);
        grew = true;
      }
    }
  }
  return found;
}

export const realSystem = {
  listProcesses: () =>
    parseProcessTable(
      execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8' })
    ),
  signal: (target, signal) => {
    try {
      process.kill(target, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        throw error;
      }
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  /** A live process's environment as text: NUL-separated on Linux, `ps -E` on macOS. */
  readEnvironment: (pid) => {
    try {
      return process.platform === 'linux'
        ? readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join('\n')
        : execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], {
            encoding: 'utf8',
          })
            .split(/\s+/)
            .join('\n');
    } catch {
      return '';
    }
  },
};

/**
 * True when a process of `pgid` (or a descendant) runs with this sandbox's
 * `BASE_DIR`, so a process group whose ID was reused is never signalled.
 */
export function isSandboxProcessGroup(pgid, baseDir, system = realSystem) {
  return [...collectGroupProcesses(system.listProcesses(), pgid)].some((pid) =>
    system.readEnvironment(pid).split('\n').includes(`BASE_DIR=${baseDir}`)
  );
}

export function isProcessRunning(pid, system = realSystem) {
  return system.listProcesses().some((process) => process.pid === pid && !process.zombie);
}

/**
 * Stops every process in `pgid` and its descendants: SIGTERM, then SIGKILL
 * after `graceMs`. Resolves only once none is left; rejects if any survives.
 */
export async function stopProcessGroup(
  pgid,
  { system = realSystem, graceMs = 15_000, killGraceMs = 5000, pollMs = 200 } = {}
) {
  const tracked = collectGroupProcesses(system.listProcesses(), pgid);
  const remaining = () => {
    const processes = system.listProcesses();
    for (const pid of collectGroupProcesses(processes, pgid)) {
      tracked.add(pid);
    }
    const live = new Set(processes.filter((p) => !p.zombie).map((p) => p.pid));
    return [...tracked].filter((pid) => live.has(pid));
  };
  const signalAll = (signal) => {
    system.signal(-pgid, signal);
    for (const pid of remaining()) {
      system.signal(pid, signal);
    }
  };
  const waitForExit = async (timeoutMs) => {
    const deadline = system.now() + timeoutMs;
    while (remaining().length > 0) {
      if (system.now() >= deadline) {
        return false;
      }
      await system.sleep(pollMs);
    }
    return true;
  };
  if (remaining().length === 0) {
    return;
  }
  signalAll('SIGTERM');
  if (await waitForExit(graceMs)) {
    return;
  }
  signalAll('SIGKILL');
  if (!(await waitForExit(killGraceMs))) {
    throw new Error(`Processes still running after SIGKILL: ${remaining().join(', ')}`);
  }
}

/** `--clean`: stop each selected sandbox's processes, then delete its directory. */
export async function cleanSandboxes({
  root = sandboxRoot(),
  tempDir = tmpdir(),
  system = realSystem,
  remove = (dir) => rmSync(dir, { recursive: true, force: true }),
  log = () => undefined,
} = {}) {
  const removed = [];
  for (const { dir, record } of selectSandboxesToClean(root, (pid) =>
    isProcessRunning(pid, system)
  )) {
    assertInsideTempDir(dir, tempDir);
    if (isSandboxProcessGroup(record.pgid, record.baseDir, system)) {
      await stopProcessGroup(record.pgid, { system });
    } else if (collectGroupProcesses(system.listProcesses(), record.pgid).size > 0) {
      log(`Process group ${record.pgid} no longer belongs to ${dir}; leaving it running`);
    }
    remove(dir);
    log(`Removed ${dir}`);
    removed.push(dir);
  }
  return removed;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

function prepareSandbox(baseDir) {
  const paths = sandboxPaths(baseDir);
  for (const dir of [
    paths.binDir,
    paths.home,
    paths.worktreeBaseDir,
    paths.codexHome,
    paths.claudeConfigDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  copyFileSync(GH_SHIM, join(paths.binDir, 'gh'));
  chmodSync(join(paths.binDir, 'gh'), 0o755);
  copyFileSync(FAKE_CODEX, join(paths.binDir, 'codex'));
  chmodSync(join(paths.binDir, 'codex'), 0o755);
  writeFileSync(paths.ghLog, '');
  writeFileSync(paths.dotenv, '');
  // `ff serve` runs in the sandbox, so its port file and .env lookup stay out
  // of the checkout. bootstrap.mjs loads tsx and its path aliases from the
  // working directory; point both at the checkout.
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(baseDir, 'node_modules'));
  writeFileSync(
    join(baseDir, 'tsconfig.json'),
    `${JSON.stringify({ extends: join(REPO_ROOT, 'tsconfig.json') })}\n`
  );
  writeFileSync(
    paths.gitConfig,
    [
      '[user]',
      '\tname = Factory Factory Sandbox',
      '\temail = sandbox@factory-factory.invalid',
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '',
    ].join('\n')
  );
  return paths;
}

function createSeedRepository(paths, env) {
  mkdirSync(paths.repoPath);
  writeFileSync(join(paths.repoPath, 'README.md'), '# Sandbox project\n');
  const git = (...args) =>
    execFileSync('git', args, { cwd: paths.repoPath, env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'Initial commit');
}

const trpcResultSchema = z.object({ result: z.object({ data: z.object({ json: z.unknown() }) }) });

async function trpcMutation(backendUrl, path, input) {
  const response = await fetch(`${backendUrl}/api/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed (HTTP ${response.status}): ${text.slice(0, 500)}`);
  }
  return trpcResultSchema.parse(JSON.parse(text)).result.data.json;
}

/** Seeds through the public tRPC API: one project, Codex as the default provider. */
async function seed(backendUrl, repoPath) {
  const project = z
    .object({ id: z.string() })
    .parse(await trpcMutation(backendUrl, 'project.create', { repoPath }));
  await trpcMutation(backendUrl, 'userSettings.update', { defaultSessionProvider: 'CODEX' });
  return project.id;
}

async function waitForReady(paths, getBackendPort, hasExited) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new Error('The server exited during startup.');
    }
    const backendPort = getBackendPort();
    const frontendPort = existsSync(paths.portFile)
      ? parsePortFile(readFileSync(paths.portFile, 'utf8'))
      : null;
    if (backendPort && frontendPort) {
      return { backendPort, frontendPort };
    }
    await realSystem.sleep(250);
  }
  throw new Error(`The server was not ready within ${STARTUP_TIMEOUT_MS / 1000} seconds.`);
}

function tail(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-40).join('\n');
  } catch {
    return '';
  }
}

async function run({ scenario, keep }) {
  const log = (message) => process.stderr.write(`dev-sandbox: ${message}\n`);
  const root = sandboxRoot();
  mkdirSync(root, { recursive: true });
  assertInsideTempDir(root);
  const baseDir = realpathSync(mkdtempSync(join(root, 'sb-')));
  assertInsideTempDir(baseDir);
  const env = buildServerEnv({ parentEnv: process.env, baseDir, scenario });
  let paths;
  let frontendPort;
  let backendPort;
  try {
    paths = prepareSandbox(baseDir);
    createSeedRepository(paths, env);
    [frontendPort, backendPort] = [await findFreePort(), await findFreePort()];
  } catch (error) {
    rmSync(baseDir, { recursive: true, force: true });
    throw error;
  }
  const child = spawn(
    process.execPath,
    [
      join(REPO_ROOT, 'src', 'cli', 'bootstrap.mjs'),
      'serve',
      '--dev',
      '--no-open',
      '--port',
      String(frontendPort),
      '--backend-port',
      String(backendPort),
    ],
    // cwd is the sandbox, so `ff serve` writes its port file there and loads no .env.
    { cwd: baseDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const pgid = child.pid;
  let exited = false;
  // The backend reports its port once; keep only enough output to find that line.
  let pendingOutput = '';
  let reportedBackendPort = null;
  child.stdout.on('data', (chunk) => {
    const output = pendingOutput + chunk.toString();
    reportedBackendPort ??= parseBackendPort(output);
    pendingOutput = output.slice(output.lastIndexOf('\n') + 1).slice(-4096);
    appendFileSync(paths.serverOutput, chunk);
  });
  child.stderr.on('data', (chunk) => appendFileSync(paths.serverOutput, chunk));

  const record = {
    baseDir,
    frontendUrl: null,
    backendUrl: null,
    pid: process.pid,
    pgid,
    projectId: null,
    repoPath: paths.repoPath,
    scenario,
  };
  writeSandboxRecord(paths.sandboxJson, record);

  let stopping = null;
  const stop = (reason, exitCode) => {
    stopping ??= (async () => {
      log(`stopping (${reason})`);
      try {
        await stopProcessGroup(pgid);
        if (keep) {
          log(`kept ${baseDir}`);
        } else {
          assertInsideTempDir(baseDir);
          rmSync(baseDir, { recursive: true, force: true });
        }
      } catch (error) {
        log(error instanceof Error ? error.message : String(error));
        exitCode = 1;
      }
      process.exit(exitCode);
    })();
    return stopping;
  };
  process.on('SIGINT', () => void stop('SIGINT', 130));
  process.on('SIGTERM', () => void stop('SIGTERM', 143));
  process.on('SIGHUP', () => void stop('SIGHUP', 129));
  child.once('exit', (code, signal) => {
    exited = true;
    void stop(`server exited with ${signal ?? `code ${code}`}`, 1);
  });

  try {
    const ports = await waitForReady(
      paths,
      () => reportedBackendPort,
      () => exited
    );
    record.backendUrl = `http://localhost:${ports.backendPort}`;
    record.frontendUrl = `http://localhost:${ports.frontendPort}`;
    record.projectId = await seed(record.backendUrl, paths.repoPath);
  } catch (error) {
    log(`startup failed: ${error instanceof Error ? error.message : String(error)}`);
    log(`server output:\n${tail(paths.serverOutput)}`);
    await stop('startup failed', 1);
    return;
  }
  if (stopping) {
    return;
  }
  writeSandboxRecord(paths.sandboxJson, record);
  process.stdout.write(`SANDBOX_READY ${paths.sandboxJson}\n`);
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.mode === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (process.platform === 'win32') {
    process.stderr.write('dev-sandbox supports macOS and Linux only.\n');
    process.exitCode = 1;
    return;
  }
  try {
    if (options.mode === 'clean') {
      await cleanSandboxes({ log: (message) => process.stderr.write(`dev-sandbox: ${message}\n`) });
      return;
    }
    await run(options);
  } catch (error) {
    process.stderr.write(
      `dev-sandbox: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
