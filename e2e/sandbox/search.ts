import type { Page } from '@playwright/test';

/**
 * Opens the search dialog from the header and searches for `query`. The workspaces and chats found
 * are the dialog's options. The dialog's "Include archived" toggle, off at first, is the one place
 * that lists archived workspaces (each with an "Archived" mark). The placeholder and the `option`
 * role are used because the dialog's accessible names do not reach the accessibility tree:
 * https://github.com/purplefish-ai/factory-factory/issues/3372
 */
export async function searchFor(page: Page, query: string) {
  await page.getByRole('button', { name: 'Search' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder(/Search names/).fill(query);
  return { dialog, includeArchived: dialog.getByRole('button', { name: 'Include archived' }) };
}
