import { type ChildProcess, execFileSync, type SpawnOptions, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configService } from '@/backend/services/config.service';
import { AcpClientFactory } from '@/backend/services/session/service/acp/acp-client-factory';
import { fetchClaudeModelCatalogFromAcp } from '@/backend/services/session/service/acp/claude-model-catalog-loader';
import {
  assertInsideTempDir,
  buildServerEnv,
  cleanSandboxes,
  collectGroupProcesses,
  isSandboxProcessGroup,
  parseArgs,
  parseBackendPort,
  parsePortFile,
  parseProcessTable,
  readSandboxRecord,
  realSystem,
  selectSandboxesToClean,
  stopProcessGroup,
} from './dev-sandbox.mjs';

// Both Claude spawn paths run through node:child_process. Record the
// environment they pass and refuse to start the real adapter.
const claudeSpawnEnvs = vi.hoisted((): NodeJS.ProcessEnv[] => []);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const recordingSpawn = (command: string, ...rest: unknown[]): ChildProcess => {
    const [args, options] = Array.isArray(rest[0])
      ? [rest[0] as string[], rest[1] as SpawnOptions | undefined]
      : [[], rest[0] as SpawnOptions | undefined];
    if ([command, ...args].some((part) => part.includes('claude-agent-acp'))) {
      claudeSpawnEnvs.push({ ...options?.env });
      throw new Error('Claude spawn recorded');
    }
    return actual.spawn(command, args, options ?? {});
  };
  return { ...actual, spawn: recordingSpawn };
});

const LAUNCHER = fileURLToPath(new URL('./dev-sandbox.mjs', import.meta.url));
const SECRET = 'planted-secret-value';
const PLANTED_CREDENTIALS = {
  ANTHROPIC_API_KEY: `${SECRET}-api-key`,
  ANTHROPIC_AUTH_TOKEN: `${SECRET}-auth-token`,
  CLAUDE_CODE_OAUTH_TOKEN: `${SECRET}-oauth`,
  // Set, even empty, this points Claude's keychain lookup at the default entry.
  CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_SECRET_ACCESS_KEY: `${SECRET}-aws`,
  GH_TOKEN: `${SECRET}-gh`,
  OPENAI_API_KEY: `${SECRET}-openai`,
};
const CREDENTIAL_NAME = /ANTHROPIC|OAUTH|TOKEN|API_KEY|SECRET|CREDENTIAL|SECURESTORAGE|BEDROCK/;

const temporaryDirectories: string[] = [];
function temporaryDirectory(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(dir);
  return dir;
}

function launcherEnv(tempDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = join(tempDir, 'home');
  mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH,
    USER: process.env.USER,
    HOME: home,
    TMPDIR: tempDir,
    // A user's own Claude configuration directory must not reach the server.
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    ...PLANTED_CREDENTIALS,
    ...extra,
  };
}

type Launch = {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
};

function launch(args: string[], env: NodeJS.ProcessEnv): Launch {
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { child, output: () => output, exited };
}

async function waitForReady(sandbox: Launch): Promise<string> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const match = /^SANDBOX_READY (.+)$/m.exec(sandbox.output());
    if (match?.[1]) {
      return match[1];
    }
    if (sandbox.child.exitCode !== null) {
      break;
    }
    await realSystem.sleep(100);
  }
  throw new Error(`The sandbox did not become ready:\n${sandbox.output()}`);
}

const recordSchema = z.object({
  baseDir: z.string(),
  frontendUrl: z.string(),
  backendUrl: z.string(),
  pid: z.number(),
  pgid: z.number(),
  projectId: z.string(),
  repoPath: z.string(),
  scenario: z.string().nullable(),
});
type Running = { launch: Launch; tempDir: string; env: NodeJS.ProcessEnv } & z.infer<
  typeof recordSchema
> & { sandboxJson: string; readyOutput: string };

async function startSandbox(tempDir: string, env: NodeJS.ProcessEnv): Promise<Running> {
  const sandbox = launch([], env);
  launches.push(sandbox);
  const sandboxJson = await waitForReady(sandbox);
  const record = recordSchema.parse(JSON.parse(readFileSync(sandboxJson, 'utf8')));
  return { ...record, launch: sandbox, tempDir, env, sandboxJson, readyOutput: sandbox.output() };
}

async function trpcQuery(backendUrl: string, path: string) {
  const response = await fetch(`${backendUrl}/api/trpc/${path}`);
  const body = z
    .object({ result: z.object({ data: z.object({ json: z.unknown() }) }) })
    .parse(await response.json());
  return body.result.data.json;
}

function ghCalls(baseDir: string) {
  return readFileSync(join(baseDir, 'gh-calls.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => z.array(z.string()).parse(JSON.parse(line)));
}

/** Environment of a live process, as `NAME=value` entries (best effort on macOS). */
function processEnvironment(pid: number): string {
  if (process.platform === 'linux') {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join('\n');
  }
  return execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
  });
}

const launches: Launch[] = [];
let registry: Server;
const registryRequests: string[] = [];
let shared: Running;
let killedLauncher: Running;

beforeAll(async () => {
  registry = createServer((request: IncomingMessage, response) => {
    registryRequests.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"version":"999.0.0"}');
  });
  await new Promise<void>((resolve) => registry.listen(0, '127.0.0.1', resolve));
  const address = registry.address();
  const registryUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const sharedTemp = temporaryDirectory('ffsb-');
  const killedTemp = temporaryDirectory('ffsb-');
  [shared, killedLauncher] = await Promise.all([
    startSandbox(sharedTemp, launcherEnv(sharedTemp, { FF_NPM_REGISTRY_URL: registryUrl })),
    startSandbox(killedTemp, launcherEnv(killedTemp)),
  ]);
}, 180_000);

afterAll(async () => {
  for (const sandbox of launches) {
    if (sandbox.child.exitCode === null && sandbox.child.signalCode === null) {
      sandbox.child.kill('SIGTERM');
      await sandbox.exited;
    }
  }
  for (const sandbox of [shared, killedLauncher]) {
    if (sandbox) {
      await stopProcessGroup(sandbox.pgid);
    }
  }
  await new Promise((resolve) => registry?.close(resolve));
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

describe('a running sandbox', () => {
  it('prints SANDBOX_READY with a readable sandbox.json', () => {
    expect(shared.readyOutput.match(/^SANDBOX_READY /gm)).toHaveLength(1);
    expect(shared.sandboxJson).toBe(join(shared.baseDir, 'sandbox.json'));
    expect(shared.baseDir.startsWith(`${join(shared.tempDir, 'ff-sandbox')}/`)).toBe(true);
    expect(shared.pid).toBe(shared.launch.child.pid);
    expect(collectGroupProcesses(realSystem.listProcesses(), shared.pgid).has(shared.pgid)).toBe(
      true
    );
    expect(shared.frontendUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(shared.scenario).toBeNull();
  });

  it('seeds one project on a fresh repository', async () => {
    const projects = z
      .array(z.object({ id: z.string(), repoPath: z.string() }))
      .parse(await trpcQuery(shared.backendUrl, 'project.list'));
    expect(projects).toEqual([expect.objectContaining({ id: shared.projectId })]);
    expect(projects[0]?.repoPath).toBe(shared.repoPath);
    expect(shared.repoPath.startsWith(`${shared.baseDir}/`)).toBe(true);
    const commits = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: shared.repoPath,
      encoding: 'utf8',
    });
    expect(commits.trim()).toBe('1');
    const settings = z
      .object({ defaultSessionProvider: z.string() })
      .parse(await trpcQuery(shared.backendUrl, 'userSettings.get'));
    expect(settings.defaultSessionProvider).toBe('CODEX');
  });

  it('never opens the default database', () => {
    // Neither the launcher's HOME nor the sandbox's own HOME gets the default directory.
    expect(existsSync(join(String(shared.env.HOME), 'factory-factory'))).toBe(false);
    expect(existsSync(join(shared.baseDir, 'home', 'factory-factory'))).toBe(false);
    expect(existsSync(join(shared.baseDir, 'data.db'))).toBe(true);
  });

  it('an idle sandbox contacts no external service', async () => {
    // The browser asks for release notices on load and every interval.
    const updates = z
      .object({ notices: z.array(z.unknown()) })
      .parse(await trpcQuery(shared.backendUrl, 'admin.checkUpdates'));
    const legacy = z
      .object({ latestVersion: z.string().nullable() })
      .parse(await trpcQuery(shared.backendUrl, 'admin.checkFactoryUpdate'));
    // Let the immediately-run and five-second background jobs complete a cycle.
    await realSystem.sleep(6000);
    expect(updates.notices).toEqual([]);
    expect(legacy.latestVersion).toBeNull();
    expect(registryRequests).toEqual([]);
    // `ff serve` probes `gh --version` once before the server starts; nothing after.
    expect(ghCalls(shared.baseDir)).toEqual([['--version']]);
  }, 30_000);

  it('records gh calls instead of running them', async () => {
    const auth = z
      .object({ authenticated: z.boolean(), error: z.string().optional() })
      .parse(await trpcQuery(shared.backendUrl, 'project.checkGithubAuth'));
    expect(auth.authenticated).toBe(false);
    expect(auth.error).toContain('sandbox: gh is disabled');
    expect(ghCalls(shared.baseDir)).toContainEqual(['auth', 'status']);
  });

  it("Claude cannot use the user's credentials", async () => {
    const claudeConfigDir = join(shared.baseDir, 'claude-config');
    const assertIsolated = (env: NodeJS.ProcessEnv) => {
      expect(Object.keys(env).filter((name) => CREDENTIAL_NAME.test(name))).toEqual([]);
      expect(Object.values(env).join('\n')).not.toContain(SECRET);
      expect(env.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir);
      expect(env.HOME).toBe(join(shared.baseDir, 'home'));
    };
    // Both spawn paths, run with the environment the launcher gives the server.
    // Its info logs (config reloads, the spawn attempt) are expected here.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const saved = process.env;
    process.env = {
      ...buildServerEnv({ parentEnv: shared.env, baseDir: shared.baseDir, scenario: null }),
    };
    configService.reload();
    claudeSpawnEnvs.length = 0;
    try {
      await expect(fetchClaudeModelCatalogFromAcp()).rejects.toThrow('Claude spawn recorded');
      const factory = new AcpClientFactory();
      // As composed in app-context.ts.
      factory.configureEnvironment({
        childProcessEnvProvider: () => configService.getChildProcessEnv(),
      });
      const never = {
        promise: new Promise<never>(() => undefined),
        dispose: () => undefined,
      };
      await expect(
        factory.createClient({
          sessionId: 'sandbox-session',
          options: {
            provider: 'CLAUDE',
            workingDir: shared.repoPath,
            sessionId: 'sandbox-session',
          },
          handlers: {},
          metadata: { incarnationId: 'sandbox', purpose: 'active', installed: false },
          shutdownSignal: never,
          stopSignal: never,
          shouldDispatchRuntimeError: () => false,
        })
      ).rejects.toThrow('Claude spawn recorded');
    } finally {
      process.env = saved;
      configService.reload();
    }
    expect(claudeSpawnEnvs).toHaveLength(2);
    claudeSpawnEnvs.forEach(assertIsolated);
    // The running server, which both paths inherit from, has the same environment.
    const serverProcesses = [...collectGroupProcesses(realSystem.listProcesses(), shared.pgid)];
    const environments = serverProcesses.map(processEnvironment);
    expect(environments.join('\n')).not.toContain(SECRET);
    expect(environments.some((env) => env.includes(`CLAUDE_CONFIG_DIR=${claudeConfigDir}`))).toBe(
      true
    );
  });

  it('--clean leaves a sandbox whose launcher is running', async () => {
    const clean = launch(['--clean'], launcherEnv(shared.tempDir));
    expect(await clean.exited).toBe(0);
    expect(existsSync(shared.sandboxJson)).toBe(true);
    expect(collectGroupProcesses(realSystem.listProcesses(), shared.pgid).size).toBeGreaterThan(0);
  }, 30_000);

  it('removes baseDir and every descendant process on SIGTERM', async () => {
    const descendants = collectGroupProcesses(realSystem.listProcesses(), shared.pgid);
    // The CLI, Vite and the watching backend at least.
    expect(descendants.size).toBeGreaterThanOrEqual(3);
    shared.launch.child.kill('SIGTERM');
    expect(await shared.launch.exited).toBe(143);
    expect(existsSync(shared.baseDir)).toBe(false);
    // baseDir links the checkout's node_modules; deleting it keeps the target.
    expect(existsSync(fileURLToPath(new URL('../node_modules/tsx', import.meta.url)))).toBe(true);
    const live = new Set(realSystem.listProcesses().map((process) => process.pid));
    expect([...descendants].filter((pid) => live.has(pid))).toEqual([]);
  }, 60_000);
});

describe('--clean', () => {
  it('--clean after the launcher is killed stops its descendants before removing baseDir', async () => {
    const { pgid, baseDir } = killedLauncher;
    killedLauncher.launch.child.kill('SIGKILL');
    await killedLauncher.launch.exited;
    const descendants = collectGroupProcesses(realSystem.listProcesses(), pgid);
    expect(descendants.size).toBeGreaterThanOrEqual(3);
    const liveAtRemoval: number[][] = [];
    const removed = await cleanSandboxes({
      root: join(killedLauncher.tempDir, 'ff-sandbox'),
      tempDir: killedLauncher.tempDir,
      remove: (dir: string) => {
        const live = new Set(realSystem.listProcesses().map((process) => process.pid));
        liveAtRemoval.push([...descendants].filter((pid) => live.has(pid)));
        rmSync(dir, { recursive: true, force: true });
      },
    });
    expect(removed).toEqual([baseDir]);
    expect(liveAtRemoval).toEqual([[]]);
    expect(existsSync(baseDir)).toBe(false);
  }, 60_000);

  it('--clean ignores a directory without a sandbox.json naming itself', async () => {
    const tempDir = temporaryDirectory('ffsb-');
    const root = join(tempDir, 'ff-sandbox');
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      const pgid = sleeper.pid ?? 0;
      const noRecord = join(root, 'sb-none');
      const elsewhere = join(root, 'sb-elsewhere');
      const broken = join(root, 'sb-broken');
      for (const dir of [noRecord, elsewhere, broken]) {
        mkdirSync(dir, { recursive: true });
      }
      // A dead launcher, naming another directory and a live process group.
      const record = { frontendUrl: null, backendUrl: null, projectId: null, scenario: null };
      writeFileSync(
        join(elsewhere, 'sandbox.json'),
        JSON.stringify({ ...record, baseDir: noRecord, pid: 999_999, pgid, repoPath: '' })
      );
      writeFileSync(join(broken, 'sandbox.json'), '{');
      const clean = launch(['--clean'], launcherEnv(tempDir));
      expect(await clean.exited).toBe(0);
      expect([noRecord, elsewhere, broken].map((dir) => existsSync(dir))).toEqual([
        true,
        true,
        true,
      ]);
      expect(sleeper.exitCode).toBeNull();
    } finally {
      sleeper.kill('SIGKILL');
    }
  }, 30_000);
});

describe('--clean and reused process group IDs', () => {
  it('removes a stale sandbox without signalling a group that is no longer its own', async () => {
    const tempDir = temporaryDirectory('ffsb-');
    const dir = join(tempDir, 'ff-sandbox', 'sb-stale');
    mkdirSync(dir, { recursive: true });
    // An unrelated process group that happens to carry the recorded ID.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      writeFileSync(
        join(dir, 'sandbox.json'),
        JSON.stringify({
          baseDir: dir,
          frontendUrl: null,
          backendUrl: null,
          pid: 999_999,
          pgid: unrelated.pid,
          projectId: null,
          repoPath: join(dir, 'repo'),
          scenario: null,
        })
      );
      const clean = launch(['--clean'], launcherEnv(tempDir));
      expect(await clean.exited).toBe(0);
      expect(existsSync(dir)).toBe(false);
      const live = new Set(realSystem.listProcesses().map((process) => process.pid));
      expect(live.has(unrelated.pid ?? 0)).toBe(true);
      expect(clean.output()).toContain('no longer belongs');
    } finally {
      unrelated.kill('SIGKILL');
    }
  }, 30_000);
});

describe('launcher logic', () => {
  it('refuses a BASE_DIR outside the OS temporary directory', async () => {
    const tempDir = temporaryDirectory('ffsb-');
    const outside = temporaryDirectory('ffsb-outside-');
    expect(() => assertInsideTempDir(outside, tempDir)).toThrow(/Refusing/);
    expect(() => assertInsideTempDir(tempDir, tempDir)).toThrow(/Refusing/);
    expect(() => assertInsideTempDir(join(tempDir, 'missing'), tempDir)).toThrow(/Refusing/);
    mkdirSync(join(tempDir, 'inside'));
    expect(() => assertInsideTempDir(join(tempDir, 'inside'), tempDir)).not.toThrow();
    symlinkSync(outside, join(tempDir, 'link'));
    expect(() => assertInsideTempDir(join(tempDir, 'link'), tempDir)).toThrow(/Refusing/);
    // A sandbox root that leads out of the temporary directory stops the launcher.
    symlinkSync(outside, join(tempDir, 'ff-sandbox'));
    const run = launch([], launcherEnv(tempDir));
    expect(await run.exited).toBe(1);
    expect(run.output()).toMatch(/Refusing to use .* as BASE_DIR/);
    expect(execFileSync('ls', ['-A', outside], { encoding: 'utf8' })).toBe('');
  }, 30_000);

  it('builds the server environment from an allowlist and sandbox paths', () => {
    const env = buildServerEnv({
      parentEnv: {
        PATH: '/usr/bin',
        HOME: '/home/me',
        LC_ALL: 'C',
        NODE_OPTIONS: '--inspect',
        BASE_DIR: '/home/me/factory-factory',
        DATABASE_PATH: '/home/me/factory-factory/data.db',
        FF_NPM_REGISTRY_URL: 'http://127.0.0.1:4873',
        ...PLANTED_CREDENTIALS,
      },
      baseDir: '/tmp/ff-sandbox/sb-1',
      scenario: 'slow-turn',
      nodeDir: '/opt/node/bin',
    });
    expect(env).toEqual({
      PATH: '/tmp/ff-sandbox/sb-1/bin:/opt/node/bin:/usr/bin',
      HOME: '/tmp/ff-sandbox/sb-1/home',
      LC_ALL: 'C',
      FF_NPM_REGISTRY_URL: 'http://127.0.0.1:4873',
      BASE_DIR: '/tmp/ff-sandbox/sb-1',
      WORKTREE_BASE_DIR: '/tmp/ff-sandbox/sb-1/worktrees',
      CODEX_HOME: '/tmp/ff-sandbox/sb-1/codex-home',
      CODEX_PATH: '/tmp/ff-sandbox/sb-1/bin/codex',
      CLAUDE_CONFIG_DIR: '/tmp/ff-sandbox/sb-1/claude-config',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      GIT_CONFIG_GLOBAL: '/tmp/ff-sandbox/sb-1/gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      DOTENV_PATH: '/tmp/ff-sandbox/sb-1/sandbox.env',
      DOTENV_QUIET: 'true',
      FF_EMIT_BACKEND_PORT: '1',
      FF_UPDATE_CHECKS_ENABLED: 'false',
      AGENT_SLACK_INTAKE_ENABLED: 'false',
      FF_SANDBOX_SCENARIO: 'slow-turn',
    });
    const bare = buildServerEnv({
      parentEnv: { FF_NPM_REGISTRY_URL: 'https://user:token@registry.example' },
      baseDir: '/t',
      scenario: null,
    });
    expect('FF_SANDBOX_SCENARIO' in bare).toBe(false);
    expect('FF_NPM_REGISTRY_URL' in bare).toBe(false);
  });

  it('parses arguments', () => {
    expect(parseArgs([])).toEqual({ mode: 'run', scenario: null, keep: false });
    expect(parseArgs(['--scenario', 'slow-turn', '--keep'])).toEqual({
      mode: 'run',
      scenario: 'slow-turn',
      keep: true,
    });
    expect(parseArgs(['--clean']).mode).toBe('clean');
    expect(parseArgs(['--help']).mode).toBe('help');
    expect(() => parseArgs(['--scenario'])).toThrow();
    expect(() => parseArgs(['--scenario', '../x'])).toThrow();
    expect(() => parseArgs(['--clean', '--keep'])).toThrow();
    expect(() => parseArgs(['--port'])).toThrow();
  });

  it('reads the ports the server reports', () => {
    expect(parseBackendPort('  ✓ Backend\nBACKEND_PORT:4011\n')).toBe(4011);
    expect(parseBackendPort('BACKEND_PORT:4011')).toBeNull();
    expect(parseBackendPort('xBACKEND_PORT:4011\n')).toBeNull();
    expect(parseBackendPort('BACKEND_PORT:99999\n')).toBeNull();
    expect(parsePortFile('3007\n')).toBe(3007);
    expect(parsePortFile('')).toBeNull();
    expect(parsePortFile('30x')).toBeNull();
  });

  it('selects only stale sandboxes that name their own directory', () => {
    const root = join(temporaryDirectory('ffsb-'), 'ff-sandbox');
    const record = (baseDir: string, pid: number) =>
      JSON.stringify({
        baseDir,
        frontendUrl: null,
        backendUrl: null,
        pid,
        pgid: 4242,
        projectId: null,
        repoPath: join(baseDir, 'repo'),
        scenario: null,
      });
    const dirs = ['stale', 'running', 'other', 'none'].map((name) => join(root, name));
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }
    const [stale, running, other] = dirs as [string, string, string, string];
    writeFileSync(join(stale, 'sandbox.json'), record(stale, 100));
    writeFileSync(join(running, 'sandbox.json'), record(running, 200));
    writeFileSync(join(other, 'sandbox.json'), record(stale, 100));
    symlinkSync(stale, join(root, 'link'));
    const selected = selectSandboxesToClean(root, (pid: number) => pid === 200);
    expect(selected.map((entry: { dir: string }) => entry.dir)).toEqual([stale]);
    expect(readSandboxRecord(join(stale, 'sandbox.json'))?.pgid).toBe(4242);
    expect(selectSandboxesToClean(join(root, 'missing'), () => false)).toEqual([]);
  });

  it('collects a process group and the descendants that left it', () => {
    const table = parseProcessTable(
      [
        '  10     1   10 Ss',
        '  11    10   10 S',
        '  12    11   12 S', // provider adapter in its own group
        '  13    12   12 S',
        '  14    10   10 Z', // exited, not yet reaped
        '  20     1   20 S',
      ].join('\n')
    );
    expect([...collectGroupProcesses(table, 10)].sort()).toEqual([10, 11, 12, 13]);
  });

  function fakeSystem(survivesTerm: boolean, survivesKill = false) {
    let processes = [
      { pid: 10, ppid: 1, pgid: 10, zombie: false },
      { pid: 12, ppid: 10, pgid: 12, zombie: false },
    ];
    let time = 0;
    const events: string[] = [];
    return {
      events,
      system: {
        listProcesses: () => processes,
        signal: (target: number, signal: string) => {
          events.push(`${signal} ${target}`);
          if (signal === 'SIGKILL' ? !survivesKill : !survivesTerm) {
            processes = processes.filter((p) => p.pid !== target && -p.pgid !== target);
          }
        },
        sleep: (ms: number) => {
          time += ms;
          return Promise.resolve();
        },
        now: () => time,
        readEnvironment: (pid: number) => (pid === 12 ? 'PATH=/bin\nBASE_DIR=/tmp/sb' : ''),
      },
    };
  }

  it('recognises a process group by the BASE_DIR its processes run with', () => {
    const { system } = fakeSystem(false);
    expect(isSandboxProcessGroup(10, '/tmp/sb', system)).toBe(true);
    expect(isSandboxProcessGroup(10, '/tmp/s', system)).toBe(false);
    expect(isSandboxProcessGroup(20, '/tmp/sb', system)).toBe(false);
  });

  it('stops the group with SIGTERM, then SIGKILL, and waits for every process', async () => {
    const polite = fakeSystem(false);
    await stopProcessGroup(10, { system: polite.system });
    expect(polite.events).toEqual(['SIGTERM -10', 'SIGTERM 12']);

    const stubborn = fakeSystem(true);
    await stopProcessGroup(10, { system: stubborn.system, graceMs: 1000 });
    expect(stubborn.events).toEqual([
      'SIGTERM -10',
      'SIGTERM 10',
      'SIGTERM 12',
      'SIGKILL -10',
      'SIGKILL 12',
    ]);

    const unkillable = fakeSystem(true, true);
    await expect(
      stopProcessGroup(10, { system: unkillable.system, graceMs: 1000, killGraceMs: 1000 })
    ).rejects.toThrow('Processes still running after SIGKILL: 10, 12');
  });
});
