// Real-server cases: two sandboxes start in parallel and are shared by every
// case below. Sandbox A keeps its logs untouched until the idle check; sandbox
// B takes the cases that call out (gh, git, Claude) and ends killed.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getBundledClaudeCommand } from '@/backend/lib/claude-cli-command';
import { cleanSandboxes } from './sandbox/clean.mjs';
import { buildServerEnv } from './sandbox/env.mjs';
import {
  collectGroupProcesses,
  isSameProcess,
  realSystem,
  stopProcessGroup,
} from './sandbox/process-group.mjs';
import {
  type Launch,
  launch,
  launcherEnv,
  SECRET,
  temporaryDirectories,
} from './sandbox/test-support';

const temporary = temporaryDirectories();

async function waitForReady(sandbox: Launch): Promise<string> {
  const deadline = Date.now() + 240_000;
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
  pidStartedAt: z.string(),
  pgid: z.number(),
  pgidStartedAt: z.string(),
  egressPort: z.number(),
  projectId: z.string(),
  repoPath: z.string(),
  scenario: z.string(),
});
type Running = { launch: Launch; tempDir: string; env: NodeJS.ProcessEnv } & z.infer<
  typeof recordSchema
> & { sandboxJson: string; readyOutput: string };

async function startSandbox(tempDir: string, env: NodeJS.ProcessEnv): Promise<Running> {
  // The test run owns its sandboxes: if it dies, they stop and clean up.
  const sandbox = launch(['--owner-pid', String(process.pid)], env);
  launches.push(sandbox);
  const sandboxJson = await waitForReady(sandbox);
  const record = recordSchema.parse(JSON.parse(readFileSync(sandboxJson, 'utf8')));
  return { ...record, launch: sandbox, tempDir, env, sandboxJson, readyOutput: sandbox.output() };
}

const trpcResult = z.object({ result: z.object({ data: z.object({ json: z.unknown() }) }) });

async function trpcQuery(backendUrl: string, path: string) {
  const response = await fetch(`${backendUrl}/api/trpc/${path}`);
  return trpcResult.parse(await response.json()).result.data.json;
}

/** A mutation's outcome: its data, or the error message the server returned. */
async function trpcMutation(backendUrl: string, path: string, input: unknown) {
  const response = await fetch(`${backendUrl}/api/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  const body: unknown = await response.json();
  if (response.ok) {
    return { ok: true as const, data: trpcResult.parse(body).result.data.json };
  }
  const error = z.object({ error: z.object({ json: z.object({ message: z.string() }) }) });
  return { ok: false as const, message: error.parse(body).error.json.message };
}

function jsonLines(file: string) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => z.array(z.string()).parse(JSON.parse(line)));
}
const ghCalls = (baseDir: string) => jsonLines(join(baseDir, 'gh-calls.log'));
const sshCalls = (baseDir: string) => jsonLines(join(baseDir, 'ssh-calls.log'));
/** Egress attempts without their timestamps: `METHOD host:port`. */
function egressCalls(baseDir: string) {
  return readFileSync(join(baseDir, 'egress-calls.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace(/^\S+ /, ''));
}

/**
 * Environment of a live process, as `NAME=value` entries (best effort on
 * macOS); empty for a process that exited since it was listed.
 */
function processEnvironment(pid: number): string {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').join('\n');
    }
    return execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/** Runs the application's managed Claude runtime once, non-interactively. */
function runClaude(env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const { command, args } = getBundledClaudeCommand(['-p', 'Reply with OK.']);
  return new Promise((resolve) => {
    const child = execFile(command, args, { env, cwd, timeout: 150_000 }, (_error, out, err) =>
      resolve(`${out}${err}`)
    );
    child.stdin?.end();
  });
}

const launches: Launch[] = [];
let registry: Server;
const registryRequests: string[] = [];
let shared: Running;
let other: Running;

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
  const otherTemp = temporary.create('ffsb-');
  [shared, other] = await Promise.all([
    startSandbox(sharedTemp, launcherEnv(sharedTemp, { FF_NPM_REGISTRY_URL: registryUrl })),
    startSandbox(otherTemp, launcherEnv(otherTemp)),
  ]);
}, 300_000);

afterAll(async () => {
  for (const sandbox of launches) {
    if (sandbox.child.exitCode === null && sandbox.child.signalCode === null) {
      sandbox.child.kill('SIGTERM');
      await sandbox.exited;
    }
  }
  // Only groups that are still the sandbox's (leader start time, or BASE_DIR) are signalled.
  for (const sandbox of [shared, other]) {
    if (sandbox) {
      await stopProcessGroup(sandbox.pgid, {
        leaderStartedAt: sandbox.pgidStartedAt,
        baseDir: sandbox.baseDir,
      });
    }
  }
  await new Promise((resolve) => registry?.close(resolve));
  temporary.cleanup();
}, 120_000);

describe('a running sandbox', () => {
  it('prints SANDBOX_READY with a readable sandbox.json', () => {
    expect(shared.readyOutput.match(/^SANDBOX_READY /gm)).toHaveLength(1);
    expect(shared.sandboxJson).toBe(join(shared.baseDir, 'sandbox.json'));
    expect(shared.baseDir.startsWith(`${join(shared.tempDir, 'ff-sandbox')}/`)).toBe(true);
    expect(shared.pid).toBe(shared.launch.child.pid);
    const processes = realSystem.listProcesses();
    expect(isSameProcess(processes, { pid: shared.pid, startedAt: shared.pidStartedAt })).toBe(
      true
    );
    expect(isSameProcess(processes, { pid: shared.pgid, startedAt: shared.pgidStartedAt })).toBe(
      true
    );
    expect(shared.frontendUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(shared.egressPort).toBeGreaterThan(0);
    expect(shared.scenario).toBe('echo');
  }, 30_000);

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
  }, 60_000);

  it('never opens the default database', () => {
    // Neither the launcher's HOME nor the sandbox's own HOME gets the default directory.
    expect(existsSync(join(String(shared.env.HOME), 'factory-factory'))).toBe(false);
    expect(existsSync(join(shared.baseDir, 'home', 'factory-factory'))).toBe(false);
    expect(existsSync(join(shared.baseDir, 'data.db'))).toBe(true);
  }, 30_000);

  it('refuses a project outside the sandbox', async () => {
    // A real repository, outside baseDir (in the test's own temporary directory).
    const outside = join(shared.tempDir, 'outside-repo');
    mkdirSync(outside);
    execFileSync('git', ['init', '--quiet'], { cwd: outside });
    const result = await trpcMutation(shared.backendUrl, 'project.create', { repoPath: outside });
    expect(result).toEqual({
      ok: false,
      message: `Invalid repository path: Path ${outside} is outside the project root ${shared.baseDir}`,
    });
    // A `..` after a link inside the sandbox (the shape of baseDir/node_modules/..):
    // lexically inside, on disk the repository above.
    mkdirSync(join(shared.tempDir, 'link-target'));
    symlinkSync(join(shared.tempDir, 'link-target'), join(shared.baseDir, 'escape'));
    const escaping = `${shared.baseDir}/escape/../outside-repo`;
    expect(await trpcMutation(shared.backendUrl, 'project.create', { repoPath: escaping })).toEqual(
      {
        ok: false,
        message: `Invalid repository path: Path ${escaping} is outside the project root ${shared.baseDir}`,
      }
    );
    const projects = z.array(z.unknown()).parse(await trpcQuery(shared.backendUrl, 'project.list'));
    expect(projects).toHaveLength(1);
  }, 60_000);

  it('--clean leaves a sandbox whose launcher is running', async () => {
    const clean = launch(['--clean'], launcherEnv(shared.tempDir));
    expect(await clean.exited).toBe(0);
    expect(existsSync(shared.sandboxJson)).toBe(true);
    expect(collectGroupProcesses(realSystem.listProcesses(), shared.pgid).size).toBeGreaterThan(0);
  }, 30_000);

  it('an idle sandbox makes no outbound request and no gh call after startup', async () => {
    // The browser asks for release notices on load and every interval.
    const updates = z
      .object({ notices: z.array(z.unknown()) })
      .parse(await trpcQuery(shared.backendUrl, 'admin.checkUpdates'));
    const legacy = z
      .object({ latestVersion: z.string().nullable() })
      .parse(await trpcQuery(shared.backendUrl, 'admin.checkFactoryUpdate'));
    expect(updates.notices).toEqual([]);
    expect(legacy.latestVersion).toBeNull();
    expect(registryRequests).toEqual([]);
    // From SANDBOX_READY to here, after every case above: nothing went out.
    expect(egressCalls(shared.baseDir)).toEqual([]);
    expect(sshCalls(shared.baseDir)).toEqual([]);
    // `ff serve` probes `gh --version` once before the server starts; nothing after.
    expect(ghCalls(shared.baseDir)).toEqual([['--version']]);
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

describe('a sandbox that calls out', () => {
  it('records gh calls instead of running them', async () => {
    const auth = z
      .object({ authenticated: z.boolean(), error: z.string().optional() })
      .parse(await trpcQuery(other.backendUrl, 'project.checkGithubAuth'));
    expect(auth.authenticated).toBe(false);
    expect(auth.error).toContain('sandbox: gh is disabled');
    expect(ghCalls(other.baseDir)).toContainEqual(['auth', 'status']);
    // The server spawns the shim, a Node process: slow on a loaded host.
  }, 120_000);

  it('git cannot reach a remote', async () => {
    const ssh = await trpcMutation(other.backendUrl, 'project.createFromGithub', {
      githubUrl: 'git@github.com:octo/sandbox-test.git',
    });
    const https = await trpcMutation(other.backendUrl, 'project.createFromGithub', {
      githubUrl: 'https://github.com/octo/sandbox-test',
    });
    // Refused by git itself, before any attempt reached the ssh shim or the recorder.
    expect(ssh).toEqual({
      ok: false,
      message: expect.stringContaining("transport 'ssh' not allowed"),
    });
    expect(https).toEqual({
      ok: false,
      message: expect.stringContaining("transport 'https' not allowed"),
    });
    expect(sshCalls(other.baseDir)).toEqual([]);
    expect(egressCalls(other.baseDir)).toEqual([]);
  }, 60_000);

  it('Claude requests never leave the machine', async () => {
    // The server ran its own Claude paths at startup (launch discovery and the
    // model catalog) and they made no request at all.
    const serverOutput = readFileSync(join(other.baseDir, 'server-output.log'), 'utf8');
    expect(serverOutput).toMatch(/Launch discovery stage completed .*"provider":"CLAUDE"/);
    expect(egressCalls(other.baseDir)).toEqual([]);
    // No server process carries a planted credential; Claude's API is the recorder.
    const environments = [...collectGroupProcesses(realSystem.listProcesses(), other.pgid)].map(
      processEnvironment
    );
    expect(environments.join('\n')).not.toContain(SECRET);
    expect(
      environments.some((env) =>
        env.includes(`ANTHROPIC_BASE_URL=http://127.0.0.1:${other.egressPort}`)
      )
    ).toBe(true);
    // The application's managed Claude runtime, with exactly the server's
    // environment, finds no credential, so it has nothing to send ...
    const serverEnv = buildServerEnv({
      parentEnv: other.env,
      baseDir: other.baseDir,
      scenario: other.scenario,
      egressPort: other.egressPort,
    });
    expect(await runClaude(serverEnv, other.repoPath)).toContain('Not logged in');
    expect(egressCalls(other.baseDir)).toEqual([]);
    // ... and given one (a placeholder), its request is refused locally and recorded.
    const placeholder = 'sandbox-placeholder-not-a-key';
    const refused = await runClaude(
      { ...serverEnv, ANTHROPIC_API_KEY: placeholder },
      other.repoPath
    );
    expect(refused).toContain('403 sandbox: outbound request refused');
    const calls = egressCalls(other.baseDir);
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls)).toEqual(new Set([`POST 127.0.0.1:${other.egressPort}`]));
    expect(readFileSync(join(other.baseDir, 'egress-calls.log'), 'utf8')).not.toContain(
      placeholder
    );
  }, 300_000);

  it('--clean after the launcher is killed stops its descendants before removing baseDir', async () => {
    const { pgid, baseDir } = other;
    other.launch.child.kill('SIGKILL');
    await other.launch.exited;
    const descendants = collectGroupProcesses(realSystem.listProcesses(), pgid);
    expect(descendants.size).toBeGreaterThanOrEqual(3);
    const liveAtRemoval: number[][] = [];
    const removed = await cleanSandboxes({
      root: join(other.tempDir, 'ff-sandbox'),
      tempDir: other.tempDir,
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
