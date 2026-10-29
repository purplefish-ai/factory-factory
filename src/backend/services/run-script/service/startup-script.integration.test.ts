import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('@/backend/services/logger.service', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { startupScriptService } from './startup-script.service';

it('completes provisioning while a background descendant still holds output pipes', async () => {
  const worktreePath = await mkdtemp(path.join(tmpdir(), 'ff-background-startup-'));
  let descendantPid: number | undefined;
  let rootPid: number | undefined;
  const markReady = vi.fn();
  const clearInitScriptPid = vi.fn().mockResolvedValue(undefined);
  startupScriptService.configure({
    workspace: {
      markReady,
      markFailed: vi.fn(),
      clearInitOutput: vi.fn().mockResolvedValue(undefined),
      appendInitOutput: vi.fn((_workspaceId: string, output: string) => {
        const match = /descendant:(\d+)/.exec(output);
        if (match?.[1]) {
          descendantPid = Number(match[1]);
        }
        return Promise.resolve();
      }),
      setInitScriptPid: vi.fn((_workspaceId: string, pid: number) => {
        rootPid = pid;
        return Promise.resolve();
      }),
      clearInitScriptPid,
    },
  });

  try {
    const result = await startupScriptService.runStartupScript(
      { id: 'background-init', worktreePath } as never,
      {
        // Keep a real inherited stdout pipe open until the test releases it
        // after provisioning. Check the file after installing the watcher too,
        // so a slow descendant cannot miss the release signal.
        startupScriptCommand: `(exec node -e '
          const fs = require("node:fs");
          let wrote = false;
          const writeWhenReleased = () => {
            if (wrote || !fs.existsSync("release-background")) return;
            wrote = true;
            process.stdout.write("late output\\n", (error) => {
              if (error) throw error;
              fs.writeFileSync("background-wrote", "alive");
            });
          };
          fs.watch(".", writeWhenReleased);
          writeWhenReleased();
        ') & printf "descendant:%s\\n" "$!"; echo complete`,
        startupScriptTimeout: 10,
      } as never
    );

    expect(result).toMatchObject({ success: true, exitCode: 0, timedOut: false });
    expect(result.stdout).toContain('complete\n');
    expect(rootPid).toBeDefined();
    expect(() => process.kill(rootPid!, 0)).toThrow();
    expect(descendantPid).toBeDefined();
    expect(() => process.kill(descendantPid!, 0)).not.toThrow();
    await writeFile(path.join(worktreePath, 'release-background'), 'release');
    await expect
      .poll(() => readFile(path.join(worktreePath, 'background-wrote'), 'utf8'), { timeout: 2000 })
      .toBe('alive');
    expect(result.stdout).not.toContain('late output');
    expect(descendantPid).toBeDefined();
    // Completion must precede the inherited pipe closing when the descendant exits.
    expect(() => process.kill(descendantPid!, 0)).not.toThrow();
    expect(markReady).toHaveBeenCalledWith('background-init');
    expect(clearInitScriptPid).toHaveBeenCalledOnce();
  } finally {
    if (descendantPid) {
      try {
        process.kill(descendantPid, 'SIGTERM');
      } catch {
        // The descendant may already have exited if the test failed slowly.
      }
    }
    await rm(worktreePath, { recursive: true, force: true, maxRetries: 3 });
  }
});
