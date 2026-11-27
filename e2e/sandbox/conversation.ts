import type { Page } from '@playwright/test';

/** Types `message` into the open conversation's composer and sends it. */
export async function sendMessage(page: Page, message: string) {
  await page.getByRole('textbox', { name: 'Message' }).fill(message);
  await page.getByRole('button', { name: 'Send message' }).click();
}
