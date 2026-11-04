import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ElectronAPI } from '../../src/types/electron';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
let output: string;
let compiledPreload: string;

beforeAll(() => {
  output = mkdtempSync(join(tmpdir(), 'ff-preload-'));
  const compiler = join(dirname(require.resolve('@typescript/native/package.json')), 'bin/tsc');
  execFileSync(
    process.execPath,
    [compiler, '-p', 'tsconfig.electron.json', '--incremental', 'false', '--outDir', output],
    { cwd: root }
  );
  compiledPreload = readFileSync(join(output, 'electron/preload/index.cjs'), 'utf8');
}, 20_000);

afterAll(() => {
  if (output) {
    rmSync(output, { recursive: true, force: true });
  }
});

it('runs the compiled preload in a sandbox and exposes the dialog and clipboard IPC bridge', async () => {
  let api: ElectronAPI | undefined;
  const invoke = vi.fn().mockResolvedValue(null);
  const on = vi.fn();
  const removeListener = vi.fn();
  runInNewContext(compiledPreload, {
    exports: {},
    require: (name: string) => {
      if (name !== 'electron') {
        throw new Error(`Unsupported sandbox module: ${name}`);
      }
      return {
        contextBridge: {
          exposeInMainWorld: (name: string, value: ElectronAPI) => {
            expect(name).toBe('electronAPI');
            api = value;
          },
        },
        ipcRenderer: { invoke, on, removeListener },
      };
    },
  });
  if (!api) {
    throw new Error('Preload did not expose its API');
  }
  expect(api.isElectron).toBe(true);
  const onCommand = vi.fn();
  const cleanup = api.onAppCommand?.(onCommand);
  expect(cleanup).toBeTypeOf('function');
  const [channel, handler] = on.mock.calls[0]!;
  expect(channel).toBe('app:command');
  expect(invoke).toHaveBeenLastCalledWith('app:commands-ready', true);
  for (const command of ['nav.settings', 'nav.newWorkspace', 'app.search', 'app.toggleSidebar']) {
    handler({ untrustedEvent: true }, command);
    expect(onCommand).toHaveBeenLastCalledWith(command);
  }
  handler({}, 'arbitrary:command');
  handler({}, { command: 'nav.settings' });
  expect(onCommand).toHaveBeenCalledTimes(4);
  cleanup?.();
  expect(removeListener).toHaveBeenCalledWith('app:command', handler);
  expect(invoke).toHaveBeenLastCalledWith('app:commands-ready', false);
  await api.setBackgroundColor?.('#123456');
  expect(invoke).toHaveBeenLastCalledWith('window:background-color', '#123456');
  expect(api.focusWindow).toBeTypeOf('function');
  await api.focusWindow?.();
  expect(invoke).toHaveBeenLastCalledWith('window:focus');
  await expect(api.readClipboardImageAsPng()).resolves.toBeNull();
  expect(invoke).toHaveBeenLastCalledWith('clipboard:readImagePng');
  const result = { canceled: false, filePaths: ['/tmp/project'] };
  invoke.mockResolvedValueOnce(result);
  await expect(api.showOpenDialog({ properties: ['openDirectory'] })).resolves.toEqual(result);
  expect(invoke).toHaveBeenLastCalledWith('dialog:showOpen', { properties: ['openDirectory'] });
});
