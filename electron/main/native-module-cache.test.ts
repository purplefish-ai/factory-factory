import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
import { z } from 'zod';

const SCRIPT_SOURCE = fileURLToPath(
  new URL('../../scripts/ensure-native-modules.mjs', import.meta.url)
);

const tempRoots: string[] = [];
const commandSchema = z.object({ cwd: z.string(), args: z.array(z.string()) });

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function readCommands(path: string) {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => commandSchema.parse(JSON.parse(line)));
}

function linkPrismaDriver(root: string, version = '12.11.1'): string {
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
  symlinkSync(
    realpathSync(fileURLToPath(new URL('../../node_modules/zod', import.meta.url))),
    join(root, 'node_modules', 'zod'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const adapterLink = join(root, 'node_modules', '@prisma', 'adapter-better-sqlite3');
  mkdirSync(dirname(adapterLink), { recursive: true });
  symlinkSync(adapter, adapterLink, process.platform === 'win32' ? 'junction' : 'dir');
  const driver = join(
    root,
    'node_modules',
    '.pnpm',
    `better-sqlite3@${version}`,
    'node_modules',
    'better-sqlite3'
  );
  writeFile(join(driver, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version }));
  symlinkSync(
    driver,
    join(root, 'node_modules', '.pnpm', 'adapter', 'node_modules', 'better-sqlite3'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  return driver;
}

function napiFixture(): { root: string; scriptPath: string; driver: string; ptyBinary: string } {
  const root = mkdtempSync(join(tmpdir(), 'factory-factory-napi-modules-'));
  tempRoots.push(root);
  const scriptPath = join(root, 'scripts', 'ensure-native-modules.mjs');
  mkdirSync(dirname(scriptPath), { recursive: true });
  copyFileSync(SCRIPT_SOURCE, scriptPath);
  writeFile(join(root, 'node_modules', 'electron', 'package.json'), '{"version":"45.0.0"}');
  const driver = linkPrismaDriver(root, '13.0.3');
  writeFile(join(driver, 'prebuilds', `${process.platform}-${process.arch}.node`), 'napi-prebuilt');
  const ptyBinary = join(
    root,
    'node_modules',
    '.pnpm',
    'node-pty@1.1.0',
    'node_modules',
    'node-pty',
    'build',
    'Release',
    'pty.node'
  );
  writeFile(ptyBinary, 'node-pty-binary');
  return { root, scriptPath, driver, ptyBinary };
}

describe('native Electron module cache', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { installation: 'prebuilt', legacyCache: true },
    { installation: 'source-built', legacyCache: true },
    { installation: 'prebuilt', legacyCache: false },
  ])(
    'switches node-pty caches for $installation SQLite v13 with legacy cache $legacyCache',
    ({ installation, legacyCache }) => {
      const { root, scriptPath, driver, ptyBinary } = napiFixture();
      const sqliteSourceBinary = join(driver, 'build', 'Release', 'better_sqlite3.node');
      if (installation === 'source-built') {
        writeFile(sqliteSourceBinary, 'napi-source-built');
      }
      const nodeMarker = `node-abi${process.versions.modules}`;
      writeFile(join(root, '.native-cache', '.current-target'), nodeMarker);
      for (const [marker, binary] of [
        [nodeMarker, 'node-pty-binary'],
        ['electron-v45.0.0', 'electron-pty-binary'],
      ]) {
        writeFile(join(root, '.native-cache', marker, 'node-pty', 'pty.node'), binary);
        if (legacyCache) {
          writeFile(
            join(root, '.native-cache', marker, 'better-sqlite3', 'better_sqlite3.node'),
            'stale-sqlite-v12'
          );
        }
      }

      for (const [target, expectedBinary] of [
        ['electron', 'electron-pty-binary'],
        ['node', 'node-pty-binary'],
        ['electron', 'electron-pty-binary'],
      ]) {
        execFileSync(process.execPath, [scriptPath, target], { cwd: root });
        expect(readFileSync(ptyBinary, 'utf8')).toBe(expectedBinary);
        expect(
          readFileSync(
            join(driver, 'prebuilds', `${process.platform}-${process.arch}.node`),
            'utf8'
          )
        ).toBe('napi-prebuilt');
        if (installation === 'source-built') {
          expect(readFileSync(sqliteSourceBinary, 'utf8')).toBe('napi-source-built');
        } else {
          expect(existsSync(sqliteSourceBinary)).toBe(false);
        }
      }
    }
  );

  it.each(['node', 'electron'])(
    'rebuilds only node-pty for %s when Prisma uses N-API SQLite',
    (target) => {
      const { root, scriptPath, driver } = napiFixture();
      const commandLog = join(root, 'commands.jsonl');
      const recordCommand = `require('node:fs').appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + String.fromCharCode(10));`;
      const pnpm = join(root, 'bin', 'pnpm');
      writeFile(pnpm, `#!${process.execPath}\n${recordCommand}\n`);
      chmodSync(pnpm, 0o755);
      if (process.platform === 'win32') {
        copyFileSync(pnpm, `${pnpm}.cjs`);
        writeFile(`${pnpm}.cmd`, `@"${process.execPath}" "%~dp0pnpm.cjs" %*\r\n`);
      }
      const rebuildPackage = join(root, 'node_modules', '@electron', 'rebuild');
      writeFile(
        join(rebuildPackage, 'package.json'),
        '{"name":"@electron/rebuild","exports":"./lib/main.js"}'
      );
      writeFile(join(rebuildPackage, 'lib', 'main.js'), '');
      writeFile(join(rebuildPackage, 'lib', 'cli.js'), recordCommand);

      execFileSync(process.execPath, [scriptPath, target, '--force'], {
        cwd: root,
        env: { PATH: join(root, 'bin') },
      });

      const commands = readCommands(commandLog);
      expect(commands).toEqual([
        {
          cwd: realpathSync(root),
          args: target === 'node' ? ['rebuild', 'node-pty'] : ['-f', '-m', '.', '-o', 'node-pty'],
        },
      ]);
      expect(existsSync(join(driver, 'build', 'Release', 'better_sqlite3.node'))).toBe(false);
      const marker = target === 'node' ? `node-abi${process.versions.modules}` : 'electron-v45.0.0';
      expect(existsSync(join(root, '.native-cache', marker, 'better-sqlite3'))).toBe(false);
    }
  );

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
      `#!${process.execPath}\nthrow new Error('Nested package-manager execution can install inside a dependency');\n`
    );
    const rebuildPackage = join(root, 'node_modules', '@electron', 'rebuild');
    writeFile(
      join(rebuildPackage, 'package.json'),
      '{"name":"@electron/rebuild","exports":"./lib/main.js"}'
    );
    writeFile(join(rebuildPackage, 'lib', 'main.js'), '');
    writeFile(
      join(rebuildPackage, 'lib', 'cli.js'),
      `
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

    const commands = readCommands(commandLog);
    expect(commands).toHaveLength(2);
    expect(commands).toContainEqual({
      cwd: realpathSync(root),
      args: ['-f', '-m', '.', '-o', 'better-sqlite3,node-pty'],
    });
    expect(commands).toContainEqual({
      cwd: realpathSync(adapter),
      args: ['-f', '-m', '.', '-o', 'better-sqlite3'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
