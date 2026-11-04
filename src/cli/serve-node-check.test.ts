import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('rejects an unsupported runtime through the CLI before database initialization', () => {
  const root = mkdtempSync(join(tmpdir(), 'ff-node-check-'));
  const databasePath = join(root, 'data', 'database.db');
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"18.20.0"})',
        'src/cli/index.ts',
        'serve',
        '--database-path',
        databasePath,
        '--no-open',
      ],
      { encoding: 'utf8', timeout: 15_000 }
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Node.js 18.20.0 is not supported');
    expect(result.stderr).toContain('nvm install');
    expect(result.stderr).not.toContain('Migration failed');
    expect(result.stdout).not.toContain('Running database migrations');
    expect(existsSync(join(root, 'data'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
