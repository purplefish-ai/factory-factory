import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerBuildCommand } from './build-command';
import { runProviderCommand } from './provider-command';

vi.mock('./provider-command', () => ({ runProviderCommand: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('launches the Windows batch shim through cmd.exe rather than direct spawn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ff windows build-'));
  try {
    mkdirSync(join(root, 'src', 'cli'), { recursive: true });
    for (const file of ['src/cli/index.ts', 'tsconfig.backend.json', 'vite.config.ts']) {
      writeFileSync(join(root, file), '');
    }
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    vi.stubEnv('ComSpec', 'C:\\Windows\\System32\\cmd.exe');
    vi.mocked(runProviderCommand).mockResolvedValue(23);
    const program = new Command();
    registerBuildCommand(program, root);
    await program.parseAsync(['build'], { from: 'user' });
    expect(runProviderCommand).toHaveBeenCalledWith({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm run build'],
      cwd: root,
    });
    expect(process.exitCode).toBe(23);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
