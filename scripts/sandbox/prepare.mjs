// Fills a new sandbox directory: shims, the fake Codex, Git identity and the seed repository.
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
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  installExecutable(GH_SHIM, paths.gh);
  installExecutable(SSH_SHIM, paths.ssh);
  installExecutable(FAKE_CODEX, paths.codex);
  writeFileSync(paths.ghLog, '');
  writeFileSync(paths.sshLog, '');
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

export function createSeedRepository(paths, env) {
  mkdirSync(paths.repoPath);
  writeFileSync(join(paths.repoPath, 'README.md'), '# Sandbox project\n');
  const git = (...args) =>
    execFileSync('git', args, { cwd: paths.repoPath, env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--quiet');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'Initial commit');
}
