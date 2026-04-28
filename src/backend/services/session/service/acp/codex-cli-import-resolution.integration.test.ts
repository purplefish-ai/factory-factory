import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
const CLI_ENTRYPOINT = join(REPO_ROOT, 'src', 'cli', 'index.ts');
const REPO_TSCONFIG = join(REPO_ROOT, 'tsconfig.json');
const TSX_BIN = join(
  REPO_ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);

const tempDirs: string[] = [];

function createWorkspaceWithConflictingAlias(): string {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ff-codex-alias-'));
  tempDirs.push(workspaceRoot);

  mkdirSync(join(workspaceRoot, 'src', 'backend', 'domains', 'session'), {
    recursive: true,
  });
  mkdirSync(join(workspaceRoot, 'src', 'backend', 'services'), { recursive: true });

  writeFileSync(
    join(workspaceRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@/*': ['./src/*'],
          },
        },
      },
      null,
      2
    )
  );

  writeFileSync(
    join(workspaceRoot, 'src', 'backend', 'domains', 'session', 'index.ts'),
    [
      'export const sessionDomainService = {};',
      '// Intentionally omits runCodexAppServerAcpAdapter to reproduce import mismatch.',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(workspaceRoot, 'src', 'backend', 'migrate.ts'),
    ['export async function runMigrations(): Promise<void> {}', ''].join('\n')
  );
  writeFileSync(
    join(workspaceRoot, 'src', 'backend', 'services', 'logger.service.ts'),
    ["export function getLogFilePath(): string { return '/tmp/fake.log'; }", ''].join('\n')
  );

  return workspaceRoot;
}

function spawnCodexCli(
  workspaceRoot: string,
  args: string[],
  timeoutMs = 10_000
): ReturnType<typeof spawnSync> {
  return spawnSync(TSX_BIN, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function spawnCodexCliWithRetry(
  workspaceRoot: string,
  args: string[]
): ReturnType<typeof spawnSync> {
  let result = spawnCodexCli(workspaceRoot, args, 10_000);
  if (result.status === null) {
    result = spawnCodexCli(workspaceRoot, args, 30_000);
  }
  return result;
}

describe('CODEX CLI import resolution', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles alias conflicts without explicit tsconfig across tsx environments', () => {
    const workspaceRoot = createWorkspaceWithConflictingAlias();
    const result = spawnCodexCliWithRetry(workspaceRoot, [
      CLI_ENTRYPOINT,
      'internal',
      'codex-app-server-acp',
    ]);
    const stderr = String(result.stderr ?? '');

    if (result.status === null) {
      throw new Error(
        `Unpinned-tsconfig CLI run exited without status (signal=${String(result.signal ?? 'none')}). stderr: ${stderr}`
      );
    }

    expect([0, 1]).toContain(result.status);

    if (result.status === 1) {
      expect(stderr).toMatch(/does not provide an export named|ERR_MODULE_NOT_FOUND/);
      expect(stderr).toContain('@/');
      return;
    }

    expect(stderr).not.toContain('does not provide an export named');
    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  }, 45_000);

  it('avoids the import crash when tsconfig is pinned to repo root', () => {
    const workspaceRoot = createWorkspaceWithConflictingAlias();
    const result = spawnCodexCliWithRetry(workspaceRoot, [
      '--tsconfig',
      REPO_TSCONFIG,
      CLI_ENTRYPOINT,
      'internal',
      'codex-app-server-acp',
    ]);
    const stderr = String(result.stderr ?? '');

    if (result.status === null) {
      throw new Error(
        `Pinned-tsconfig CLI run exited without status (signal=${String(result.signal ?? 'none')}). stderr: ${stderr}`
      );
    }

    expect(result.status).toBe(0);
    expect(stderr).not.toContain('does not provide an export named');
    expect(stderr).not.toContain('SyntaxError');
  }, 45_000);
});
