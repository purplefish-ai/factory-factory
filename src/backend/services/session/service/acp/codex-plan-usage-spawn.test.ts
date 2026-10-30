import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveCodexPlanUsageSpawnCommand } from './codex-plan-usage-spawn';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  load: vi.fn(),
  exists: vi.fn(),
  require: vi.fn(),
}));
vi.mock('node:module', () => ({
  createRequire: (path: string) => {
    mocks.require(path);
    return Object.assign(mocks.load, { resolve: mocks.resolve });
  },
}));
vi.mock('node:fs', () => ({ existsSync: mocks.exists }));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!;
const adapter = join('/app', 'app.asar', 'node_modules', 'adapter', 'package.json');
const codex = join('/app', 'app.asar', 'node_modules', 'codex', 'bin', 'codex.js');
const optionalPackage = join('/app', 'app.asar', 'node_modules', 'native', 'package.json');

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  mocks.resolve.mockImplementation((name: string) => {
    if (name === '@agentclientprotocol/codex-acp/package.json') {
      return adapter;
    }
    if (name === '@openai/codex/bin/codex.js') {
      return codex;
    }
    if (name.startsWith('@openai/codex-win32-')) {
      return optionalPackage;
    }
    throw new Error('Unknown package');
  });
  mocks.load.mockReturnValue({ bin: { 'codex-acp': 'dist/index.js' } });
  mocks.exists.mockReturnValue(true);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  Object.defineProperty(process, 'arch', archDescriptor);
});

it.each([
  ['x64', 'x86_64-pc-windows-msvc'],
  ['arm64', 'aarch64-pc-windows-msvc'],
])('owns the native Windows %s quota process without JavaScript launchers', (arch, target) => {
  Object.defineProperty(process, 'arch', { value: arch });
  const command = resolveCodexPlanUsageSpawnCommand();
  expect(command.command).toBe(
    join(
      '/app',
      'app.asar.unpacked',
      'node_modules',
      'native',
      'vendor',
      target,
      'bin',
      'codex.exe'
    )
  );
  expect(command.args).toEqual(['app-server']);
  expect(mocks.require).toHaveBeenCalledWith(adapter);
  expect(mocks.require).toHaveBeenCalledWith(codex);
  expect(mocks.resolve).toHaveBeenCalledWith(`@openai/codex-win32-${arch}/package.json`);
});

it('supports the legacy vendor layout belonging to the adapter Codex dependency', () => {
  Object.defineProperty(process, 'arch', { value: 'x64' });
  mocks.resolve.mockImplementation((name: string) => {
    if (name === '@agentclientprotocol/codex-acp/package.json') {
      return adapter;
    }
    if (name === '@openai/codex/bin/codex.js') {
      return codex;
    }
    throw new Error('No optional platform package');
  });
  expect(resolveCodexPlanUsageSpawnCommand().command).toBe(
    join(
      '/app',
      'app.asar.unpacked',
      'node_modules',
      'codex',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    )
  );
});

it('fails closed when the native executable is missing', () => {
  mocks.exists.mockReturnValue(false);
  expect(() => resolveCodexPlanUsageSpawnCommand()).toThrow('Codex native runtime unavailable');
});
