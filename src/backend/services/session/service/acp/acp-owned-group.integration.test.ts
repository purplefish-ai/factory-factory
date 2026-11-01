import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { stopOwnedRuntimeGroup } from './acp-owned-group';

it.skipIf(process.platform === 'win32')(
  'terminates a real inherited child group and verifies disappearance',
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
    const {spawn} = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'ignore'});
    descendant.on('spawn', () => process.stdout.write(String(descendant.pid)));
    setTimeout(() => {}, 60000);
  `,
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    try {
      const [output] = await once(child.stdout, 'data');
      const descendantPid = Number(String(output));
      expect(descendantPid).toBeGreaterThan(1);
      expect(process.kill(descendantPid, 0)).toBe(true);
      expect(await stopOwnedRuntimeGroup({ child, ownedProcessGroup: child.pid })).toBe(
        'LOCAL_RUNTIME_GROUP_STOPPED'
      );
      expect(() => process.kill(descendantPid, 0)).toThrow();
      expect(() => process.kill(-child.pid!, 0)).toThrow();
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      }
    }
  },
  10_000
);
