import { expect, test } from '@playwright/test';
import { sendMessage } from './conversation';
import { claudeCalls, launchWorkspace, openBoard, readSandbox, reply } from './sandbox';

// A Claude session through the released Claude ACP adapter and the Claude Agent SDK, with the
// fake Claude CLI (src/backend/testing/fixtures/fake-claude-cli.mjs) as the only Claude
// executable in the sandbox: a prompt turn, then a command the user approves.

test('a user runs a Claude session: a reply, then a command the user approves', async ({
  page,
}) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const conversation = await launchWorkspace(page, 'Clauderobin says hello', /clauderobin/i, {
    provider: 'Claude',
  });
  // The plain turn: the prompt once as the user's message and once as the echo; the prompt the
  // CLI replays to the SDK is not shown a third time.
  await expect(conversation.getByText('Clauderobin says hello', { exact: true })).toHaveCount(2);

  await sendMessage(page, 'Clauderobin ff-scenario:permission-request');
  const request = page.getByRole('alertdialog');
  await expect(request).toContainText('Permission request for');
  await expect(request.getByRole('region', { name: 'Tool input' })).toContainText(
    'echo "Hello from the sandbox"'
  );
  const chat = page.getByRole('tablist', { name: 'Chats' });
  await expect(chat.getByRole('tab', { name: /^Needs approval\b/ })).toBeVisible();

  await request.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect(reply(conversation, 'You approved the command, so I ran it.')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(chat.getByRole('tab', { name: /^Idle\b/ })).toBeVisible();
  await expect(conversation.getByRole('button', { name: 'Ran echo' })).toBeVisible();

  // The chat's usage control shows the plan limits the fake reports, as a signed-in install would.
  await page.getByRole('button', { name: /^Usage\b/ }).click();
  const usage = page.getByRole('dialog').filter({ hasText: 'Plan limits' });
  await expect(usage).toContainText(/5-hour window\s*12% used/);
  await page.keyboard.press('Escape');

  // Every Claude launch so far reached the fake: the launch options and model discovery, the
  // health check, the adapter's sign-in probe, the session and the plan usage read above. The
  // workspace metadata launch (`--json-schema`) comes from a 10 s job and is covered by the
  // fake's and the metadata generator's unit tests instead.
  const calls = claudeCalls(sandbox);
  const argvs = calls.flatMap((call) => (call.argv ? [call.argv.join(' ')] : []));
  expect({
    version: argvs.includes('--version'),
    signIn: argvs.includes('auth status --json'),
    sessions: argvs.some((argv) => argv.includes('--input-format stream-json')),
    planUsage: calls.some((call) => call.control === 'get_usage'),
  }).toEqual({ version: true, signIn: true, sessions: true, planUsage: true });
});
