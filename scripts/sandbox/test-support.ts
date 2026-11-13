// Shared by the sandbox tests: temporary directories, a launcher environment
// with planted credentials, and a handle on a launcher process.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAUNCHER = fileURLToPath(new URL('../dev-sandbox.mjs', import.meta.url));
export const SECRET = 'planted-secret-value';
export const PLANTED_CREDENTIALS = {
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

/** Creates real-path temporary directories and removes them all on `cleanup()`. */
export function temporaryDirectories() {
  const created: string[] = [];
  return {
    create(prefix: string) {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      created.push(dir);
      return dir;
    },
    cleanup() {
      for (const dir of created.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export function launcherEnv(tempDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
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

export type Launch = {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
};

export function launch(args: string[], env: NodeJS.ProcessEnv): Launch {
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

/** How long a helper process lives if a test never kills it (an interrupted run). */
export const HELPER_LIFETIME_MS = 120_000;

/**
 * A detached process (its own process group) that idles until killed, or
 * exits by itself after `lifetimeMs`. `env` replaces its environment.
 */
export function spawnSleeper({
  env,
  lifetimeMs = HELPER_LIFETIME_MS,
}: { env?: NodeJS.ProcessEnv; lifetimeMs?: number } = {}): ChildProcess {
  return spawn(process.execPath, ['-e', `setTimeout(() => {}, ${Math.floor(lifetimeMs)})`], {
    detached: true,
    stdio: 'ignore',
    ...(env ? { env } : {}),
  });
}
