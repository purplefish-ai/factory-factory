// Where a sandbox lives and the guard that keeps it inside the OS temporary directory.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The directory every sandbox lives in. */
export function sandboxRoot(tempDir = tmpdir()) {
  return join(tempDir, 'ff-sandbox');
}

/**
 * True when `path` exists strictly inside `root`. Real paths are compared,
 * since macOS temporary paths are symlinked.
 */
export function isInsideDirectory(path, root) {
  let target;
  let realRoot;
  try {
    target = realpathSync(path);
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rel = relative(realRoot, target);
  return rel !== '' && !isAbsolute(rel) && rel.split(sep)[0] !== '..';
}

export function assertInsideTempDir(path, tempDir = tmpdir()) {
  if (!isInsideDirectory(path, tempDir)) {
    throw new Error(
      `Refusing to use ${path} as BASE_DIR: it is not inside the OS temporary directory ${tempDir}.`
    );
  }
}

export function sandboxPaths(baseDir) {
  const binDir = join(baseDir, 'bin');
  return {
    baseDir,
    binDir,
    gh: join(binDir, 'gh'),
    ssh: join(binDir, 'ssh'),
    codex: join(binDir, 'codex'),
    home: join(baseDir, 'home'),
    worktreeBaseDir: join(baseDir, 'worktrees'),
    codexHome: join(baseDir, 'codex-home'),
    claudeConfigDir: join(baseDir, 'claude-config'),
    gitConfig: join(baseDir, 'gitconfig'),
    dotenv: join(baseDir, 'sandbox.env'),
    repoPath: join(baseDir, 'repo'),
    ghLog: join(baseDir, 'gh-calls.log'),
    sshLog: join(baseDir, 'ssh-calls.log'),
    egressLog: join(baseDir, 'egress-calls.log'),
    serverOutput: join(baseDir, 'server-output.log'),
    portFile: join(baseDir, '.factory-factory-port'),
    sandboxJson: join(baseDir, 'sandbox.json'),
  };
}
