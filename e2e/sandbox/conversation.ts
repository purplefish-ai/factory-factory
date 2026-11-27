import { expect, type Page } from '@playwright/test';

/** The tab of the chat the page has open: the one tab of the Chats list that is selected. */
export function selectedChatTab(page: Page, name: RegExp) {
  return page.getByRole('tablist', { name: 'Chats' }).getByRole('tab', { selected: true, name });
}

/**
 * Types `message` into the open conversation's composer and sends it, once the open chat is not
 * working on a turn: its tab reads Idle (or Stopped, which takes the next prompt). Sent while a
 * turn works, the composer queues the message, which the server steers into that turn, and the
 * scripted agent neither echoes nor records a steered message. Waiting here turns a spec that
 * would otherwise hang on a missing reply into one that fails at the chat that was still busy.
 * Use it right after `launchWorkspace`, which returns at the echo, before the turn has ended.
 */
export async function sendMessage(page: Page, message: string) {
  await expect(selectedChatTab(page, /^(Idle|Stopped)\b/)).toBeVisible({ timeout: 120_000 });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
}
