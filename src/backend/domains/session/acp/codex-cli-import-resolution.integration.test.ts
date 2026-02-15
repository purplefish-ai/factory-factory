import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
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

describe('CODEX CLI import resolution', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reproduces alias-based import crash without explicit tsconfig', () => {
    const workspaceRoot = createWorkspaceWithConflictingAlias();
    const result = spawnSync(TSX_BIN, [CLI_ENTRYPOINT, 'internal', 'codex-app-server-acp'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 3000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not provide an export named');
    expect(result.stderr).toContain('@/backend/');
  });

  it('avoids the import crash when tsconfig is pinned to repo root', () => {
    const workspaceRoot = createWorkspaceWithConflictingAlias();
    const result = spawnSync(
      TSX_BIN,
      ['--tsconfig', REPO_TSCONFIG, CLI_ENTRYPOINT, 'internal', 'codex-app-server-acp'],
      {
        cwd: workspaceRoot,
        encoding: 'utf8',
        timeout: 3000,
      }
    );

    expect(result.stderr).not.toContain('does not provide an export named');
    expect(result.stderr).not.toContain('SyntaxError');
  });
});
