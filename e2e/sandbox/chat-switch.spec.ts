import { expect, test } from '@playwright/test';
import { sendMessage } from './conversation';
import { launchWorkspace, openBoard, readSandbox, releaseGate, reply } from './sandbox';

// A workspace holds several chats, and the chat tabs switch between them. A user starts a second
// chat in the workspace, runs a turn in it (held at a gate, so that its tab shows Running while the
// user looks at the other chat), and switches back and forth: each chat shows its own transcript
// and each tab shows its own state. The gate opens while the first chat is on screen, so the
// second chat's events arrive for a chat the user is not looking at.

// A new chat starts an agent process, which the launch helper also gives this long.
const SLOW = 120_000;

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
  // Every text of the first chat's conversation, the user's message and the agent's echo of it.
  const firstChatText = conversation.getByText(first, { exact: true });

  // A new chat opens selected and empty: none of the first chat's messages are in it.
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(chats.getByRole('tab')).toHaveCount(2, { timeout: SLOW });
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(firstTab).toHaveAttribute('aria-selected', 'false');
  await expect(firstChatText).toHaveCount(0);

  const second = 'Pipitone ff-scenario:gated-stream:smoke-switch';
  await sendMessage(page, second);
  await expect(reply(conversation, 'Waiting at gate smoke-switch.')).toBeVisible({
    timeout: SLOW,
  });
  await expect(secondTab).toHaveAccessibleName(/^Running\b/, { timeout: 60_000 });
  await expect(firstTab).toHaveAccessibleName(/^Idle\b/);
  await expect(firstChatText).toHaveCount(0);

  // Back in the first chat: its own conversation only, while the second chat's turn goes on.
  await firstTab.click();
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(reply(conversation, first)).toBeVisible();
  await expect(conversation.getByText(second, { exact: true })).toHaveCount(0);
  await expect(conversation.getByText('Waiting at gate smoke-switch.')).toHaveCount(0);
  await expect(firstTab).toHaveAccessibleName(/^Idle\b/);
  await expect(secondTab).toHaveAccessibleName(/^Running\b/, { timeout: 60_000 });
  const firstChatBefore = await conversation.ariaSnapshot();

  // The second chat's turn finishes while the first chat is on screen: its tab shows it, and
  // nothing of it appears in the first chat.
  releaseGate(sandbox, 'smoke-switch');
  await expect(secondTab).toHaveAccessibleName(/^Idle\b/, { timeout: 60_000 });
  await expect(firstTab).toHaveAccessibleName(/^Idle\b/);
  await expect(conversation.getByText('Gate smoke-switch released.')).toHaveCount(0);
  await expect(conversation.getByText(second, { exact: true })).toHaveCount(0);
  expect(await conversation.ariaSnapshot()).toEqual(firstChatBefore);

  // And in the second chat: the whole reply, once, and none of the first chat's messages.
  await secondTab.click();
  await expect(secondTab).toHaveAttribute('aria-selected', 'true');
  await expect(
    reply(conversation, 'Waiting at gate smoke-switch. Gate smoke-switch released.')
  ).toBeVisible({ timeout: 60_000 });
  await expect(conversation.getByText('Waiting at gate smoke-switch.')).toHaveCount(1);
  await expect(firstChatText).toHaveCount(0);

  // And back in the first chat once more: the second chat's whole turn has finished since the
  // snapshot, and none of it may have reached this transcript (a leak that arrives late, when the
  // chat is opened again, is caught here). The transcript loads on the switch, so wait for it to
  // equal the snapshot, then check that nothing of the second chat joins it afterwards.
  await firstTab.click();
  await expect(firstTab).toHaveAttribute('aria-selected', 'true');
  await expect(reply(conversation, first)).toBeVisible();
  await expect
    .poll(() => conversation.ariaSnapshot(), { timeout: 60_000 })
    .toEqual(firstChatBefore);
  await expect(conversation.getByText('Gate smoke-switch released.')).toHaveCount(0);
  await expect(conversation.getByText(second, { exact: true })).toHaveCount(0);
  expect(await conversation.ariaSnapshot()).toEqual(firstChatBefore);
});
