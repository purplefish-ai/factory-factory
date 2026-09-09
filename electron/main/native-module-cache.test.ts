import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

function linkPrismaDriver(root: string): void {
  const adapter = join(
    root,
    'node_modules',
    '.pnpm',
    'adapter',
    'node_modules',
    '@prisma',
    'adapter-better-sqlite3'
  );
  writeFile(join(adapter, 'package.json'), '{"name":"@prisma/adapter-better-sqlite3"}');
  const adapterLink = join(root, 'node_modules', '@prisma', 'adapter-better-sqlite3');
  mkdirSync(dirname(adapterLink), { recursive: true });
  symlinkSync(adapter, adapterLink, process.platform === 'win32' ? 'junction' : 'dir');
  const driver = join(
    root,
    'node_modules',
    '.pnpm',
    'better-sqlite3@12.11.1',
    'node_modules',
    'better-sqlite3'
  );
  writeFile(join(driver, 'package.json'), '{"name":"better-sqlite3","version":"12.11.1"}');
  symlinkSync(
    driver,
    join(root, 'node_modules', '.pnpm', 'adapter', 'node_modules', 'better-sqlite3'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
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

    linkPrismaDriver(root);
    // Keep v13 and an older unreferenced copy alongside the actual Prisma driver.
    const unrelatedDriver = join(
      root,
      'node_modules',
      '.pnpm',
      'better-sqlite3@13.0.3',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    );
    writeFile(unrelatedDriver, 'napi-driver');
    const staleDriver = join(
      root,
      'node_modules',
      '.pnpm',
      'better-sqlite3@11.0.0',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    );
    writeFile(staleDriver, 'unreferenced-driver');
    execFileSync(process.execPath, [scriptPath, 'electron'], { cwd: root });
    expect(readFileSync(unrelatedDriver, 'utf8')).toBe('napi-driver');
    expect(readFileSync(staleDriver, 'utf8')).toBe('unreferenced-driver');

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

it('force rebuilds Prisma native dependencies from their resolved pnpm location', () => {
  const root = mkdtempSync(join(tmpdir(), 'factory-factory-native-rebuild-'));
  try {
    const scriptPath = join(root, 'scripts', 'ensure-native-modules.mjs');
    mkdirSync(dirname(scriptPath), { recursive: true });
    copyFileSync(SCRIPT_SOURCE, scriptPath);
    writeFile(join(root, 'node_modules', 'electron', 'package.json'), '{"version":"44.3.0"}');
    writeFile(join(root, '.native-cache', '.current-target'), 'electron-v44.3.0');
    const adapter = join(
      root,
      'node_modules',
      '.pnpm',
      'adapter',
      'node_modules',
      '@prisma',
      'adapter-better-sqlite3'
    );
    linkPrismaDriver(root);
    const commandLog = join(root, 'commands.jsonl');
    const pnpm = join(root, 'bin', 'pnpm');
    writeFile(
      pnpm,
      `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + String.fromCharCode(10));
`
    );
    chmodSync(pnpm, 0o755);
    if (process.platform === 'win32') {
      copyFileSync(pnpm, `${pnpm}.cjs`);
      writeFile(`${pnpm}.cmd`, `@"${process.execPath}" "%~dp0pnpm.cjs" %*\r\n`);
    }

    execFileSync(process.execPath, [scriptPath, 'electron', '--force'], {
      cwd: root,
      env: { PATH: join(root, 'bin') },
    });

    const commands = readFileSync(commandLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(commands).toContainEqual({
      cwd: realpathSync(adapter),
      args: ['exec', 'electron-rebuild', '-f', '-m', '.', '-o', 'better-sqlite3'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
