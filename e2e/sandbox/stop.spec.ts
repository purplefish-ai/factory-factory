import { expect, test } from '@playwright/test';
import { sendMessage } from './conversation';
import { launchWorkspace, openBoard, readSandbox, reply } from './sandbox';

// A user stops an agent that is part-way through a reply, with the composer's stop button. The turn
// is held at a gate (`gated-stream`) that this spec never opens, so only the stop can end it.

test('a user stops a turn mid-stream and the session accepts a new prompt', async ({ page }) => {
  await openBoard(page, readSandbox());
  const conversation = await launchWorkspace(page, 'Stopfinch holds a turn', /stopfinch/);
  const chat = page.getByRole('tablist', { name: 'Chats' });

  const prompt = 'Stopfinch ff-scenario:gated-stream:smoke-stop';
  await sendMessage(page, prompt);
  await expect(reply(conversation, 'Waiting at gate smoke-stop.')).toBeVisible();
  await expect(chat.getByRole('tab', { name: /^Running\b/ })).toBeVisible();
  await page.getByRole('button', { name: 'Stop agent' }).click();

  // The part of the reply that arrived stays, followed by the product's note on who ended the turn;
  // the held rest never arrives, and the composer offers to send again instead of to stop.
  await expect(conversation.getByText('Session stopped by you.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await expect(chat.getByRole('tab', { name: /^Stopped\b/ })).toBeVisible();
  await expect(reply(conversation, 'Waiting at gate smoke-stop.')).toBeVisible();

  // The stopped session takes the next prompt, answers it, and shows the stopped turn as before.
  const next = 'Stopfinch speaks again after the stop';
  await sendMessage(page, next);
  await expect(reply(conversation, next)).toBeVisible({ timeout: 120_000 });
  // The user's own message is shown too, beside the agent's reply that repeats it: the text is on
  // the page at least twice, however the transcript marks the two up.
  await expect
    .poll(() => conversation.getByText(next, { exact: true }).count())
    .toBeGreaterThanOrEqual(2);
  // The stopped turn is still shown: the prompt that started it and the part of its reply that
  // arrived, which is the whole paragraph (a reply that went on after the stop would not match).
  await expect(conversation.getByText(prompt, { exact: true })).toBeVisible();
  await expect(reply(conversation, 'Waiting at gate smoke-stop.')).toBeVisible();
  await expect(chat.getByRole('tab', { name: /^Idle\b/ })).toBeVisible();
});
