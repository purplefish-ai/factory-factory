import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveClaudeUpdateCommand } from './claude-cli-command';

it.skipIf(process.platform === 'win32')(
  'skips a searchable Claude directory before the active executable on PATH',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ff-claude-command-')));
    try {
      const earlierBin = join(root, 'earlier-bin');
      const activeBin = join(root, 'bin');
      const cask = join(root, 'Caskroom', 'claude-code', '2.1.312');
      await mkdir(join(earlierBin, 'claude'), { recursive: true, mode: 0o755 });
      await mkdir(activeBin);
      await mkdir(cask, { recursive: true });
      const executable = join(cask, 'claude');
      await writeFile(executable, '#!/bin/sh\n', { mode: 0o755 });
      await symlink(executable, join(activeBin, 'claude'));

      const command = await resolveClaudeUpdateCommand({
        PATH: [earlierBin, activeBin].join(delimiter),
      });

      expect(command).toEqual({
        command: `${activeBin.replaceAll('\\', '/')}/brew`,
        args: ['upgrade', '--cask', 'claude-code'],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
