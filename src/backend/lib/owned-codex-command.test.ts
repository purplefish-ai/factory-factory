import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getOwnedCodexCommand } from './owned-codex-command';
const mocks = vi.hoisted(() => ({ exists: vi.fn(), resolve: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: mocks.exists }));
vi.mock('node:module', () => ({ createRequire: () => ({ resolve: mocks.resolve }) }));
const platform = process.platform;
const architecture = process.arch;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
  mocks.resolve.mockImplementation((name: string) =>
    name === '@agentclientprotocol/codex-acp/package.json'
      ? '/adapter/package.json'
      : name === '@openai/codex/bin/codex.js'
        ? '/adapter/node_modules/@openai/codex/bin/codex.js'
        : '/native/package.json'
  );
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: architecture, configurable: true });
});
it('owns the normal Windows vendor target codex executable without a launcher', () => {
  const native = join('/native', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  mocks.exists.mockImplementation((path: string) => path === native);
  expect(getOwnedCodexCommand(['app-server'])).toEqual({ command: native, args: ['app-server'] });
});
it('supports the legacy in-package Windows vendor layout', () => {
  mocks.resolve.mockImplementation((name: string) => {
    if (name.startsWith('@openai/codex-win32-')) {
      throw new Error('legacy layout');
    }
    return name === '@agentclientprotocol/codex-acp/package.json'
      ? '/adapter/package.json'
      : '/adapter/node_modules/@openai/codex/bin/codex.js';
  });
  const native = '/adapter/node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
  mocks.exists.mockImplementation((path: string) => path === native);
  expect(getOwnedCodexCommand(['app-server']).command).toBe(native);
});

it('supports the alternate vendor codex directory only when its executable exists', () => {
  const native = join('/native', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
  mocks.exists.mockImplementation((path: string) => path === native);
  expect(getOwnedCodexCommand(['app-server']).command).toBe(native);
});
it('prefers the pinned distribution bin executable when both layouts exist', () => {
  mocks.exists.mockReturnValue(true);
  expect(getOwnedCodexCommand(['app-server']).command).toBe(
    join('/native', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
  );
});
