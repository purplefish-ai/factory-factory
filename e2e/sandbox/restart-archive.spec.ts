import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  armCrashPoint,
  ensureBackendRunning,
  isCrashPointArmed,
  readServerOutput,
  restartBackend,
  waitForBackendExit,
} from '../support/backend-process';
import {
  type BackendTree,
  launchWithoutWaiting,
  readBackendTree,
  reportProcesses,
  rolesByWorkspace,
  stopSurvivorsIfKilled,
  survivorsOf,
  workspaceRow,
} from './restart-support';
import { escapeRegExp, openBoard, readSandbox, reply } from './sandbox';

// Characterises recovery of an archive in flight (see restart-in-flight.spec.ts for the rest):
// the server crashes after the archive has snapshotted the worktree and before it removes it,
// which a kill at an arbitrary moment cannot reach, since an archive takes about a second.
//
// Known and accepted: this spec leaves the row ARCHIVING. Its lease goes stale 105 to 120 s after
// the crash, and the archive-recovery job then finishes the archive in the background, which can
// fall inside a later spec's run.

/** Under the archive lease's two minutes, with room for the checks that follow. */
const LEASE_FRESH_MS = 100_000;

let tree: BackendTree | null = null;

test.afterEach(async () => {
  try {
    // Only once the crash happened: before it, the tree is the live shared backend's.
    if (tree) {
      await stopSurvivorsIfKilled(tree);
    }
  } finally {
    tree = null;
    await ensureBackendRunning();
  }
});

test('an archive in flight when the server crashes', async ({ page }) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const board = page.url();
  // A READY workspace is what gets archived.
  const prompt = 'Recoverstint archives in flight';
  const stint = await launchWithoutWaiting(page, prompt, /recoverstint/);
  await expect.poll(() => workspaceRow(sandbox, stint).status, { timeout: 60_000 }).toBe('READY');
  // And its first turn over, so that the archive does not race a session starting or at work. The
  // session row says RUNNING while its agent process lives, so the page tells: the reply is shown
  // and the chat is idle.
  await expect(reply(page.getByRole('log', { name: 'Conversation' }), prompt)).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByRole('tab', { name: 'Idle Chat 1' })).toBeVisible({ timeout: 60_000 });
  const worktree = workspaceRow(sandbox, stint).worktreePath ?? '';
  expect(existsSync(worktree)).toBe(true);

  tree = await readBackendTree();
  const crashed = tree;
  await reportProcesses('Backend processes before the crash', crashed.descendants);
  armCrashPoint('archive-before-worktree-removal');
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Archive workspace' }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  expect(await waitForBackendExit()).toEqual({ code: null, signal: 'SIGKILL' });
  const crashedAt = Date.now();
  expect(readServerOutput()).toContain('crash point archive-before-worktree-removal reached');
  expect(isCrashPointArmed('archive-before-worktree-removal')).toBe(false);

  // The archive stopped the workspace's session and terminal before its snapshot, so nothing of
  // this workspace outlives the server.
  await reportProcesses('Still alive at once after the crash', survivorsOf(crashed));
  await expect
    .poll(() => rolesByWorkspace(survivorsOf(crashed), { stint: worktree }), { timeout: 30_000 })
    .toEqual({ stint: [] });

  // The crash left the row ARCHIVING, the snapshot taken and the worktree in place.
  const snapshotRef = `refs/factory-factory/archive/${stint}`;
  const hasSnapshotRef = () => {
    try {
      execFileSync('git', ['show-ref', '--verify', '--quiet', snapshotRef], {
        cwd: sandbox.repoPath,
      });
      return true;
    } catch {
      return false;
    }
  };
  expect(workspaceRow(sandbox, stint).status).toBe('ARCHIVING');
  expect(hasSnapshotRef()).toBe(true);
  expect(existsSync(worktree)).toBe(true);

  await restartBackend();

  // OK by decision (docs/decisions/2026-11-25-interrupted-archives-are-taken-over-by-lease.md):
  // archive recovery takes a row over only once its lease is two minutes stale, and finishes the
  // removal within about four minutes; not waited for here. Until then the workspace stays
  // ARCHIVING, and its page leads back to the board.
  const project = basename(sandbox.repoPath);
  await page.goto(`${board}/${stint}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${escapeRegExp(project)}/workspaces$`), {
    timeout: 60_000,
  });
  if (Date.now() - crashedAt < LEASE_FRESH_MS) {
    expect(workspaceRow(sandbox, stint).status).toBe('ARCHIVING');
    expect(hasSnapshotRef()).toBe(true);
    expect(existsSync(worktree)).toBe(true);
  } else {
    // A restart this slow (a machine at very high load) let the lease go stale: recovery may
    // already have taken the row over, so only where it ends is certain.
    test.info().annotations.push({
      type: 'slow restart',
      description: `${Date.now() - crashedAt} ms after the crash; the lease may be stale`,
    });
    await expect
      .poll(() => workspaceRow(sandbox, stint).status, { timeout: 240_000 })
      .toBe('ARCHIVED');
  }
});
