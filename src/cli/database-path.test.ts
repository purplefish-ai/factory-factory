import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultDatabasePath, resolveDatabasePath } from './database-path';

describe('resolveDatabasePath', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'ff-db-path-'));
    process.chdir(tempDir);
    tempDir = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { force: true, recursive: true });
  });

  it('resolves a relative option path against the current working directory', () => {
    expect(resolveDatabasePath({ databasePath: 'data.db', env: {} })).toBe(
      join(tempDir, 'data.db')
    );
  });

  it('resolves a relative DATABASE_PATH against the current working directory', () => {
    expect(resolveDatabasePath({ env: { DATABASE_PATH: 'nested/data.db' } })).toBe(
      join(tempDir, 'nested', 'data.db')
    );
  });

  it('prefers the explicit option path over DATABASE_PATH', () => {
    expect(
      resolveDatabasePath({
        databasePath: 'option.db',
        env: { DATABASE_PATH: 'env.db' },
      })
    ).toBe(join(tempDir, 'option.db'));
  });

  it('preserves absolute configured paths', () => {
    const absolutePath = join(tempDir, 'absolute.db');

    expect(resolveDatabasePath({ databasePath: absolutePath, env: {} })).toBe(absolutePath);
  });

  it('falls back to the default database path when no path is configured', () => {
    expect(resolveDatabasePath({ env: {} })).toBe(resolve(getDefaultDatabasePath()));
  });
});
