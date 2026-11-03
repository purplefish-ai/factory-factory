import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerBuildCommand } from './build-command';
import { runServeSession } from './serve-session';
import { startFactoryFactoryServer } from './server-startup';

let root: string;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ff build-')));
  originalExitCode = process.exitCode;
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function checkout(exitCode = 0): void {
  mkdirSync(join(root, 'src', 'cli'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli', 'index.ts'), '');
  writeFileSync(join(root, 'tsconfig.backend.json'), '{}');
  writeFileSync(join(root, 'vite.config.ts'), '');
  // A real package script witnesses both package-script selection and cwd.
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'ff-build-fixture',
      private: true,
      packageManager: 'pnpm@12.15.0',
      scripts: { build: `node build.cjs` },
    })
  );
  writeFileSync(
    join(root, 'build.cjs'),
    `require('node:fs').writeFileSync('build-result.json', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) })); process.exit(${exitCode});`
  );
}

async function build(): Promise<void> {
  const program = new Command();
  registerBuildCommand(program, root);
  await program.parseAsync(['build'], { from: 'user' });
}

describe('ff build', () => {
  it('runs the checkout package build from the package root', async () => {
    checkout();
    await build();
    expect(
      z
        .object({ cwd: z.string(), args: z.array(z.string()) })
        .parse(JSON.parse(readFileSync(join(root, 'build-result.json'), 'utf8')))
    ).toEqual({
      cwd: root,
      args: [],
    });
    expect(process.exitCode).toBe(0);
  });

  it('propagates a failing canonical pipeline exit status', async () => {
    checkout(23);
    await build();
    expect(process.exitCode).toBe(23);
  });

  it.runIf(process.platform === 'win32')(
    'runs a cmd-only pnpm shim in a checkout with spaces and preserves failure status',
    async () => {
      checkout(23);
      const bin = join(root, 'shim');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'pnpm.cmd'),
        `@echo off\r\n"${process.execPath}" "${join(root, 'build.cjs')}" %*\r\n`
      );
      vi.stubEnv('PATH', bin);
      await build();
      expect(
        z
          .object({ cwd: z.string(), args: z.array(z.string()) })
          .parse(JSON.parse(readFileSync(join(root, 'build-result.json'), 'utf8')))
      ).toEqual({ cwd: root, args: ['run', 'build'] });
      expect(process.exitCode).toBe(23);
    }
  );

  it('reports a missing pnpm executable as an actionable command failure', async () => {
    checkout();
    vi.stubEnv('PATH', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await build();
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join(' ')).toMatch(/pnpm/);
  });

  it('rejects an installed package even when invoked from a source checkout', async () => {
    writeFileSync(join(root, 'package.json'), '{"name":"factory-factory"}');
    vi.stubEnv('PATH', '');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await build();
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join(' ')).toMatch(/source checkout/);
  });
});

describe('missing build recovery', () => {
  it('directs checkout users to the canonical package build', async () => {
    checkout();
    await expect(
      startFactoryFactoryServer({
        projectRoot: root,
        databasePath: ':memory:',
        requestedPort: 3001,
      })
    ).rejects.toThrow(/pnpm build/);
  });

  it('directs installed-package users to reinstall rather than build missing sources', async () => {
    await expect(
      startFactoryFactoryServer({
        projectRoot: root,
        databasePath: ':memory:',
        requestedPort: 3001,
      })
    ).rejects.toThrow(/reinstall/i);
  });
});

it.each([
  { asset: 'frontend', source: true, expected: /pnpm exec tsx src\/cli\/index.ts build/ },
  { asset: 'backend', source: true, expected: /pnpm exec tsx src\/cli\/index.ts build/ },
  { asset: 'frontend', source: false, expected: /reinstall/i },
  { asset: 'backend', source: false, expected: /reinstall/i },
])(
  'uses supported serve recovery when $asset is missing (source: $source)',
  async ({ asset, source, expected }) => {
    if (source) {
      checkout();
    }
    if (asset === 'backend') {
      mkdirSync(join(root, 'dist', 'client'), { recursive: true });
    }
    await expect(
      runServeSession({
        projectRoot: root,
        env: {},
        host: '127.0.0.1',
        frontendPort: 3000,
        backendPort: 3001,
        signal: new AbortController().signal,
        onReady: () => Promise.resolve(),
      })
    ).rejects.toThrow(expected);
  }
);
