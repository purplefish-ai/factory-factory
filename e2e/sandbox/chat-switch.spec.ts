import { expect, test } from '@playwright/test';
import { sendMessage } from './conversation';
import { launchWorkspace, openBoard, readSandbox, releaseGate, reply } from './sandbox';

// A workspace holds several chats, and the chat tabs switch between them. A user starts a second
// chat in the workspace, runs a turn in it (held at a gate, so that its tab shows Running while the
// user looks at the other chat), and switches back and forth: each chat shows its own transcript
// and each tab shows its own state.

test('a user starts a second chat, switches back to the first and returns, and each shows its own conversation', async ({
  page,
}) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const first = 'Pipitone keeps the first chat';
  const conversation = await launchWorkspace(page, first, /pipitone/);
  const chats = page.getByRole('tablist', { name: 'Chats' });
  const firstTab = chats.getByRole('tab', { name: /\bChat 1$/ });
  const secondTab = chats.getByRole('tab', { name: /\bChat 2$/ });
  await expect(chats.getByRole('tab')).toHaveCount(1);

  // A new chat opens empty and selected; the first chat's transcript stays with the first chat.
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(chats.getByRole('tab')).toHaveCount(2);
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(firstTab).toHaveAttribute('aria-selected', 'false');
  await expect(reply(conversation, first)).toHaveCount(0);

  const second = 'Pipitone ff-scenario:gated-stream:smoke-switch';
  await sendMessage(page, second);
  await expect(reply(conversation, 'Waiting at gate smoke-switch.')).toBeVisible();
  await expect(secondTab).toHaveAccessibleName(/^Running\b/);
  await expect(firstTab).toHaveAccessibleName(/^Idle\b/);

  // Back in the first chat: its own conversation only, while the second chat's turn goes on.
  await firstTab.click();
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(reply(conversation, first)).toBeVisible();
  await expect(conversation.getByText(second, { exact: true })).toHaveCount(0);
  await expect(conversation.getByText('Waiting at gate smoke-switch.')).toHaveCount(0);
  await expect(firstTab).toHaveAccessibleName(/^Idle\b/);
  await expect(secondTab).toHaveAccessibleName(/^Running\b/);

  // And in the second chat again: its own conversation, still held at the gate.
  await secondTab.click();
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(reply(conversation, 'Waiting at gate smoke-switch.')).toBeVisible();
  await expect(reply(conversation, first)).toHaveCount(0);
  await expect(secondTab).toHaveAccessibleName(/^Running\b/);

  releaseGate(sandbox, 'smoke-switch');

  await expect(
    reply(conversation, 'Waiting at gate smoke-switch. Gate smoke-switch released.')
  ).toBeVisible({ timeout: 60_000 });
  await expect(secondTab).toHaveAccessibleName(/^Idle\b/);
  await expect(firstTab).toHaveAccessibleName(/^Idle\b/);

  // The finished turn did not move into the first chat.
  await firstTab.click();
  await expect(reply(conversation, first)).toBeVisible();
  await expect(conversation.getByText('Gate smoke-switch released.')).toHaveCount(0);
});
