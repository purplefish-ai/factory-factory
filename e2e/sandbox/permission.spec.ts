import { expect, type Page, test } from '@playwright/test';
import { sendMessage } from './conversation';
import { launchWorkspace, openBoard, readSandbox, reply } from './sandbox';

// The scripted agent's `permission-request` scenario asks before running `echo "Hello from the
// sandbox"`, then says whether the user let it. Each test opens its own workspace and answers once.

/** Starts the scenario in a new workspace and waits for the agent's question to the user. */
async function askForPermission(page: Page, word: string) {
  await openBoard(page, readSandbox());
  const conversation = await launchWorkspace(page, `${word} asks first`, new RegExp(word, 'i'));
  await sendMessage(page, `${word} ff-scenario:permission-request`);
  const request = page.getByRole('alertdialog');
  await expect(request).toContainText('Permission request for Run command');
  await expect(request.getByRole('region', { name: 'Tool input' })).toHaveText(
    'echo "Hello from the sandbox"'
  );
  const chat = page.getByRole('tablist', { name: 'Chats' });
  await expect(chat.getByRole('tab', { name: /^Needs approval\b/ })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Waiting for your approval' })
  ).toBeVisible();
  return { conversation, request, chat };
}

test('a user approves a command the agent asked to run, and the turn finishes', async ({
  page,
}) => {
  const { conversation, request, chat } = await askForPermission(page, 'Permapprove');

  await request.getByRole('button', { name: 'Yes, proceed' }).click();

  // The command ran, the agent knows it was allowed, and the turn is over.
  await expect(reply(conversation, 'You approved the command, so I ran it.')).toBeVisible();
  await expect(conversation.getByRole('button', { name: 'Ran echo' })).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(chat.getByRole('tab', { name: /^Idle\b/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});

test('a user denies a command the agent asked to run, and the agent goes on without it', async ({
  page,
}) => {
  const { conversation, request, chat } = await askForPermission(page, 'Permdeny');

  await request.getByRole('button', { name: 'No, continue without running it' }).click();

  // The agent knows it was refused and no command appears in the transcript; the turn is over.
  await expect(reply(conversation, 'You declined the command, so I did not run it.')).toBeVisible();
  await expect(conversation.getByRole('button', { name: /^Ran / })).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(chat.getByRole('tab', { name: /^Idle\b/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});
