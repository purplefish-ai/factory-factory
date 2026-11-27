import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { launchWorkspace, openBoard, readSandbox } from './sandbox';
import { searchFor } from './search';
import { gitListsWorktree, openWorkspaceId, worktreeOf } from './worktrees';

// Deleting a workspace removes it and its worktree for good, where archiving keeps a record. The
// product has no control for it: no screen asks "Delete workspace?", and the only caller of the
// server's `workspace.delete` procedure is the API itself, which is how a script or another client
// deletes one. So this spec makes the request the way the page does (the page's own origin, the
// same `/api/trpc` route and body format) and checks what a user then sees: the card leaves the
// open board without a reload, search no longer finds the workspace even with archived ones
// included, its address says it is not found, and its directory is gone from the disk.

/** Calls the server's `workspace.delete` from the page, as the application's own client would. */
async function deleteWorkspace(page: Page, id: string) {
  const status = await page.evaluate(async (workspaceId) => {
    const response = await fetch('/api/trpc/workspace.delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { id: workspaceId } }),
    });
    return response.status;
  }, id);
  expect(status, 'the server accepted the delete').toBe(200);
}

test('a deleted workspace is gone from the board, from search and from the disk', async ({
  page,
}) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  // A second workspace with the same word stays, so that a search that finds it and not the first
  // one is a search that finished.
  await launchWorkspace(page, 'Deleteibis keeper stays put', /deleteibis-keeper/);
  await openBoard(page, sandbox);
  await launchWorkspace(page, 'Deleteibis goner is removed', /deleteibis-goner/);
  const id = openWorkspaceId(page);
  const worktree = worktreeOf(sandbox, id);
  await openBoard(page, sandbox);
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /deleteibis-goner/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /deleteibis-keeper/ })).toBeVisible();

  await deleteWorkspace(page, id);

  // The open board drops the card on its own; the other workspace stays.
  await expect(page.getByRole('link', { name: /deleteibis-goner/ })).toHaveCount(0);
  await expect(main.getByRole('link', { name: /deleteibis-keeper/ })).toBeVisible();
  // The worktree is removed from the disk and from Git's list.
  await expect.poll(() => existsSync(worktree.path), { timeout: 120_000 }).toBe(false);
  expect(gitListsWorktree(sandbox, worktree.path)).toBe(false);

  // A page loaded after the delete agrees, and so does the workspace's own address.
  await openBoard(page, sandbox);
  await expect(page.getByRole('link', { name: /deleteibis-goner/ })).toHaveCount(0);
  await expect(main.getByRole('link', { name: /deleteibis-keeper/ })).toBeVisible();
  await page.goto(`${sandbox.frontendUrl}/projects/${basename(sandbox.repoPath)}/workspaces/${id}`);
  await expect(page.getByText('Workspace not found')).toBeVisible({ timeout: 60_000 });

  // Unlike an archived workspace, it is not in the list of archived ones either.
  await openBoard(page, sandbox);
  const { dialog, includeArchived } = await searchFor(page, 'deleteibis');
  await includeArchived.click();
  await expect(dialog.getByRole('option', { name: /^deleteibis-keeper/ })).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog.getByRole('option', { name: /deleteibis-goner/ })).toHaveCount(0);
});
