// Fills a new sandbox directory: shims, the fake Codex and Claude, Git identity and the seed repository.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from './env.mjs';
import { REPO_ROOT, sandboxPaths } from './paths.mjs';

const FAKE_CODEX = join(
  REPO_ROOT,
  'src',
  'backend',
  'testing',
  'fixtures',
  'fake-codex-app-server.mjs'
);
const FAKE_CLAUDE = join(REPO_ROOT, 'src', 'backend', 'testing', 'fixtures', 'fake-claude-cli.mjs');
const GH_SHIM = join(REPO_ROOT, 'scripts', 'sandbox', 'gh-shim.mjs');
const SSH_SHIM = join(REPO_ROOT, 'scripts', 'sandbox', 'ssh-shim.mjs');

/** Where the sandbox's git sends GitHub remotes: `.invalid` never resolves. */
export const GITHUB_STAND_IN = 'github.sandbox.invalid';

/** A git configuration value in double quotes. */
export function gitConfigString(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function installExecutable(source, target) {
  copyFileSync(source, target);
  chmodSync(target, 0o755);
}

export function prepareSandbox(baseDir) {
  const paths = sandboxPaths(baseDir);
  for (const dir of [
    paths.binDir,
    paths.home,
    paths.worktreeBaseDir,
    paths.codexHome,
    paths.claudeConfigDir,
    paths.gateDir,
    paths.crashPointDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  installExecutable(GH_SHIM, paths.gh);
  installExecutable(SSH_SHIM, paths.ssh);
  installExecutable(FAKE_CODEX, paths.codex);
  installExecutable(FAKE_CLAUDE, paths.claude);
  writeFileSync(paths.ghLog, '');
  writeFileSync(paths.sshLog, '');
  writeFileSync(paths.claudeLog, '');
  writeFileSync(paths.dotenv, '');
  // `ff serve` runs in the sandbox, so its port file and .env lookup stay out
  // of the checkout. bootstrap.mjs loads tsx and its path aliases from the
  // working directory; point both at the checkout. The link is needed: without
  // it `node --import tsx` fails with ERR_MODULE_NOT_FOUND. It leads out of the
  // sandbox (baseDir/node_modules/.. is the checkout), which FF_PROJECT_ROOT's
  // check resolves the way the system does, so it cannot admit a project there.
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
      // A second line behind GIT_ALLOW_PROTOCOL and GIT_SSH_COMMAND, which take
      // precedence while set. Everything else is refused (git:// has no rewrite
      // below); ssh and https stay allowed so that they reach the ssh shim and
      // the egress recorder, which are the next lines. GitHub remotes point at a
      // host that never resolves.
      '[protocol]',
      '\tallow = never',
      '[protocol "file"]',
      '\tallow = always',
      '[protocol "ssh"]',
      '\tallow = always',
      '[protocol "https"]',
      '\tallow = always',
      '[core]',
      `\tsshCommand = ${gitConfigString(shellQuote(paths.ssh))}`,
      `[url "ssh://git@${GITHUB_STAND_IN}/"]`,
      '\tinsteadOf = git@github.com:',
      '\tinsteadOf = ssh://git@github.com/',
      `[url "https://${GITHUB_STAND_IN}/"]`,
      '\tinsteadOf = https://github.com/',
      '',
    ].join('\n')
  );
  return paths;
}

/**
 * Runs the fake app-server once with no input. It exits at once, and with an
 * error naming the valid scenarios when it does not know this one.
 */
export function checkScenario(codexPath, env) {
  const result = spawnSync(codexPath, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(
      `The fake Codex app-server rejected scenario "${env.FF_SANDBOX_SCENARIO}": ${detail}`
    );
  }
}

/** The run script: one page on the port the application gives it. */
const SEED_SERVER = `import { createServer } from 'node:http';

const port = Number(process.argv[2]);
createServer((_request, response) => response.end('Sandbox run script\\n')).listen(port, () => {
  process.stdout.write(\`Sandbox run script listening on port \${port}\\n\`);
});
`;

/** The file a spec writes, holding a gate name, to hold the next workspace's setup at that gate. */
export const HOLD_SETUP_FILE = 'hold-setup';

/**
 * The setup script: finishes at once, unless a spec asked to hold the next setup. The first setup
 * to start then takes the request and waits at the gate it names until the spec releases it, as
 * the fake Codex's gated turns do; every later setup finishes at once again.
 */
const SEED_SETUP = `import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const gateDir = process.env.FF_SANDBOX_GATE_DIR;
let gate = null;
if (gateDir) {
  const taken = join(gateDir, \`${HOLD_SETUP_FILE}.\${process.pid}\`);
  try {
    renameSync(join(gateDir, '${HOLD_SETUP_FILE}'), taken);
    gate = readFileSync(taken, 'utf8').trim();
    rmSync(taken);
  } catch {
    // No request: finish at once.
  }
}
// The application can stop reading while this waits (a server killed during setup).
process.stdout.on('error', () => undefined);
if (gate) {
  process.stdout.write(\`Sandbox setup waiting at gate \${gate}\\n\`);
  while (!existsSync(join(gateDir, gate))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  rmSync(join(gateDir, gate), { force: true });
}
process.stdout.write('Sandbox setup finished\\n');
`;

/**
 * Runs the setup script only when a hold is requested. Otherwise it is a plain `echo`, as fast as
 * before holds existed: starting Node takes seconds on a loaded machine, and a slower setup changes
 * what other specs see while a workspace starts. `exec`, so that the held setup is one process.
 */
const SEED_SETUP_COMMAND = `if [ -e "$FF_SANDBOX_GATE_DIR/${HOLD_SETUP_FILE}" ]; then exec node sandbox-setup.mjs; else echo "Sandbox setup finished"; fi`;

/**
 * The seed repository: a README, and a setup script and a run script that finish or start at
 * once, so that a workspace goes through provisioning and has something to run. A spec can hold
 * one setup at a gate (`HOLD_SETUP_FILE`).
 */
export function createSeedRepository(paths, env) {
  mkdirSync(paths.repoPath);
  const files = {
    'README.md': '# Sandbox project\n',
    'factory-factory.json': `${JSON.stringify(
      {
        scripts: {
          setup: SEED_SETUP_COMMAND,
          run: 'node sandbox-server.mjs {port}',
        },
      },
      null,
      2
    )}\n`,
    'sandbox-server.mjs': SEED_SERVER,
    'sandbox-setup.mjs': SEED_SETUP,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(paths.repoPath, name), content);
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd: paths.repoPath, env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('add', ...Object.keys(files));
  git('commit', '--quiet', '-m', 'Initial commit');
}
