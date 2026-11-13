// Fills a new sandbox directory: shims, the fake Codex, Git identity and the seed repository.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
