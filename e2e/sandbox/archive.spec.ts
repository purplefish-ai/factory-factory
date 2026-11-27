import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { launchWorkspace, openBoard, readSandbox } from './sandbox';
import { searchFor } from './search';
import { branchExists, gitListsWorktree, openWorkspaceId, worktreeOf } from './worktrees';

// A user archives a finished workspace from its card on the board. What the product does: the
// workspace stops being active and leaves the board and the sidebar; its chats and its Git branch
// are kept, and so is a record of it that search lists when asked to include archived workspaces.
// Its worktree is removed: the directory is moved off its path at once and deleted in the
// background, and Git no longer lists the worktree.

test('a user archives a workspace: it leaves the board, search still finds it, its worktree is gone', async ({
  page,
}) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  await launchWorkspace(page, 'Archiveibis is done with its work', /archiveibis/);
  const workspace = worktreeOf(sandbox, openWorkspaceId(page));
  await openBoard(page, sandbox);
  const main = page.getByRole('main');
  const card = main.getByRole('link', { name: /archiveibis/ });
  await expect(card).toBeVisible();

  // The card's archive button asks first, and says what happens to the worktree.
  await card.hover();
  await main.getByRole('button', { name: 'Archive workspace' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Archive workspace?' });
  await expect(confirm).toContainText('Chat history and the branch are kept.');
  await expect(confirm).toContainText('before the worktree is removed');
  await confirm.getByRole('button', { name: 'Archive' }).click();

  // Gone from the active columns and from the sidebar's lists.
  await expect(page.getByRole('link', { name: /archiveibis/ })).toHaveCount(0);
  // The worktree: its directory is gone and Git does not list it, but the branch it had is kept.
  await expect.poll(() => existsSync(workspace.path), { timeout: 120_000 }).toBe(false);
  expect(gitListsWorktree(sandbox, workspace.path)).toBe(false);
  expect(branchExists(sandbox, workspace.branch)).toBe(true);

  // A page loaded after the archive finished does not show the workspace either: the removal above
  // is the server's state, not only the page's.
  await openBoard(page, sandbox);
  await expect(page.getByRole('link', { name: /archiveibis/ })).toHaveCount(0);

  // Search lists it, marked archived, once the dialog is told to include archived workspaces, and
  // opening it shows what is kept instead of the live chat.
  const { dialog, includeArchived } = await searchFor(page, 'archiveibis');
  await includeArchived.click();
  const found = dialog.getByRole('option', { name: /^archiveibis-\S+ .*Archived$/ });
  await expect(found).toBeVisible({ timeout: 60_000 });
  await includeArchived.click();
  await expect(found).toHaveCount(0);
  await includeArchived.click();
  await found.click();
  const archived = page.getByRole('dialog', { name: /^archiveibis-/ });
  await expect(archived).toContainText('workspace is archived');
  await expect(archived).toContainText('live chat is unavailable');
});
