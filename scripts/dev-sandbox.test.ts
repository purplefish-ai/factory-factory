import { type ChildProcess, execFileSync, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { configService } from '@/backend/services/config.service';
import { AcpClientFactory } from '@/backend/services/session/service/acp/acp-client-factory';
import { fetchClaudeModelCatalogFromAcp } from '@/backend/services/session/service/acp/claude-model-catalog-loader';
import { cleanSandboxes } from './sandbox/clean.mjs';
import { buildServerEnv } from './sandbox/env.mjs';
import { collectGroupProcesses, realSystem, stopProcessGroup } from './sandbox/process-group.mjs';
import {
  type Launch,
  launch,
  launcherEnv,
  SECRET,
  temporaryDirectories,
} from './sandbox/test-support';

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

const CREDENTIAL_NAME = /ANTHROPIC|OAUTH|TOKEN|API_KEY|SECRET|CREDENTIAL|SECURESTORAGE|BEDROCK/;
const temporary = temporaryDirectories();

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
  scenario: z.string(),
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
  const sharedTemp = temporary.create('ffsb-');
  const killedTemp = temporary.create('ffsb-');
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
  temporary.cleanup();
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
    expect(shared.scenario).toBe('echo');
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
      ...buildServerEnv({ parentEnv: shared.env, baseDir: shared.baseDir, scenario: 'echo' }),
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
});
