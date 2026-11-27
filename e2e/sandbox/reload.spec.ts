import { expect, test } from '@playwright/test';
import { expectChatReloaded, expectReloaded, markPage, trackSockets } from '../support/no-reload';
import { sendMessage } from './conversation';
import { launchWorkspace, openBoard, readSandbox, releaseGate, reply } from './sandbox';

// A user reloads the page (the browser's reload) while the agent is part-way through a reply. The
// turn is held at a gate (`gated-stream`) that the spec opens only after the reload, so the reply's
// second half can arrive only in the page that was loaded afterwards.

test('a page reloaded mid-stream shows the same transcript and receives the rest of the turn', async ({
  page,
}) => {
  const sandbox = readSandbox();
  const sockets = trackSockets(page);
  await openBoard(page, sandbox);
  const conversation = await launchWorkspace(page, 'Reloadfinch holds a turn', /reloadfinch/);
  const chat = page.getByRole('tablist', { name: 'Chats' });

  await sendMessage(page, 'Reloadfinch ff-scenario:gated-stream:smoke-reload');
  await expect(reply(conversation, 'Waiting at gate smoke-reload.')).toBeVisible();
  await expect(chat.getByRole('tab', { name: /^Running\b/ })).toBeVisible();
  // Every message as the user sees it: their own and the agent's, in order.
  const before = await conversation.ariaSnapshot();
  const marker = await markPage(page);
  const chatsBefore = sockets.opened('/chat');

  await page.reload();

  // A new document (the marker is gone) that loaded the session over a new chat socket: what it
  // shows below was sent by the server after the reload, not left from before it.
  await expectReloaded(page, marker);
  await expectChatReloaded(sockets, chatsBefore);
  await expect.poll(() => conversation.ariaSnapshot(), { timeout: 60_000 }).toEqual(before);
  // The turn is still in progress there: the agent still works and the page can stop it.
  await expect(chat.getByRole('tab', { name: /^Running\b/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop agent' })).toBeVisible();

  releaseGate(sandbox, 'smoke-reload');

  // The rest of the reply joins the first part in the same message, once.
  await expect(
    reply(conversation, 'Waiting at gate smoke-reload. Gate smoke-reload released.')
  ).toBeVisible({ timeout: 60_000 });
  await expect(conversation.getByText('Waiting at gate smoke-reload.')).toHaveCount(1);
  await expect(chat.getByRole('tab', { name: /^Idle\b/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});
