import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_SOURCE = fileURLToPath(
  new URL('../../scripts/ensure-native-modules.mjs', import.meta.url)
);

const tempRoots: string[] = [];

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

describe('native Electron module cache', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not reuse a legacy Electron marker after the installed Electron version changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-factory-native-modules-'));
    tempRoots.push(root);

    const scriptPath = join(root, 'scripts', 'ensure-native-modules.mjs');
    mkdirSync(dirname(scriptPath), { recursive: true });
    copyFileSync(SCRIPT_SOURCE, scriptPath);

    writeFile(join(root, 'node_modules', 'electron', 'package.json'), '{"version":"41.10.4"}');
    writeFile(join(root, '.native-cache', '.current-target'), 'electron');

    const moduleFixtures = [
      {
        packageDir: 'better-sqlite3@12.11.1',
        moduleName: 'better-sqlite3',
        binaryName: 'better_sqlite3.node',
      },
      {
        packageDir: 'node-pty@1.1.0',
        moduleName: 'node-pty',
        binaryName: 'pty.node',
      },
    ];

    for (const fixture of moduleFixtures) {
      writeFile(
        join(
          root,
          'node_modules',
          '.pnpm',
          fixture.packageDir,
          'node_modules',
          fixture.moduleName,
          'build',
          'Release',
          fixture.binaryName
        ),
        'stale-electron-binary'
      );
      writeFile(
        join(root, '.native-cache', 'electron-v41.10.4', fixture.moduleName, fixture.binaryName),
        'electron-41-binary'
      );
    }

    execFileSync(process.execPath, [scriptPath, 'electron'], { cwd: root });

    expect(readFileSync(join(root, '.native-cache', '.current-target'), 'utf8')).toBe(
      'electron-v41.10.4'
    );
    for (const fixture of moduleFixtures) {
      expect(
        readFileSync(
          join(
            root,
            'node_modules',
            '.pnpm',
            fixture.packageDir,
            'node_modules',
            fixture.moduleName,
            'build',
            'Release',
            fixture.binaryName
          ),
          'utf8'
        )
      ).toBe('electron-41-binary');
    }
  });
});
