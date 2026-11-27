import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { sandboxPaths } from '../../scripts/sandbox/paths.mjs';
import {
  ensureBackendRunning,
  killBackend,
  readServerLog,
  restartBackend,
} from '../support/backend-process';
import {
  type BackendTree,
  cancelSetupHold,
  holdNextSetup,
  launchWithoutWaiting,
  readBackendTree,
  readProcessTable,
  reportProcesses,
  rolesByWorkspace,
  runScriptRow,
  sessionRows,
  stopSurvivors,
  survivorsOf,
  terminalRows,
  workspaceIdOf,
  workspaceRow,
} from './restart-support';
import { launchWorkspace, openBoard, readSandbox, rolloutHolding } from './sandbox';

// Characterises recovery: what the server does today when it is killed (SIGKILL) while work is in
// flight, and what the restarted server makes of it. One kill covers five kinds of work, each in
// its own workspace or part of one: a turn running, a prompt queued behind a running turn, a
// workspace provisioning with its setup script alive, a run script and a terminal. (An archive in
// flight is in restart-archive.spec.ts.) Every assertion states today's behaviour, good or bad;
// each "KNOWN GAP" names the issue that tracks a loss or a stuck state, and fixing one means
// changing its assertion here.

const GATES = {
  turn: 'recoverheron-turn',
  queuedTurn: 'recoverplover-turn',
  setup: 'recovercurlew-setup',
};

let tree: BackendTree | null = null;

const gateFile = (gate: string) => join(sandboxPaths(readSandbox().baseDir).gateDir, gate);

test.beforeEach(() => {
  // Left by an earlier failed run in this sandbox, a gate file would release a turn at once.
  for (const gate of Object.values(GATES)) {
    rmSync(gateFile(gate), { force: true });
  }
});

test.afterEach(async () => {
  // Unclaimed, the request would hold the next workspace's setup, in another spec.
  cancelSetupHold(readSandbox());
  await ensureBackendRunning();
  if (tree) {
    // Whatever the killed backend left running, which nothing else would end.
    await stopSurvivors(tree);
    tree = null;
  } else {
    // A failure before the kill leaves the turns and the setup waiting at their gates.
    for (const gate of Object.values(GATES)) {
      writeFileSync(gateFile(gate), '');
    }
  }
});

async function send(page: Page, text: string, button: 'Send message' | 'Queue message') {
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: button }).click();
}

test('work in flight when the server is killed, and what the restarted server makes of it', async ({
  page,
}) => {
  const sandbox = readSandbox();
  await openBoard(page, sandbox);
  const board = page.url();
  const conversation = page.getByRole('log', { name: 'Conversation' });

  // Heron: a run script, a terminal that has run a command, and a turn waiting at a gate.
  await launchWorkspace(page, 'Recoverheron runs everything', /recoverheron/);
  const heron = workspaceIdOf(page);
  const heronUrl = page.url();
  await page.getByRole('button', { name: /^Start dev server/ }).click();
  const stopDevServer = page.getByRole('button', { name: /^Stop dev server \(port \d+\)$/ });
  await expect(stopDevServer).toBeVisible({ timeout: 60_000 });
  const devLog = page
    .getByRole('tablist', { name: 'Log source' })
    .getByRole('tab', { name: 'Dev' });
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await devLog.click();
  await expect(page.getByText(/Sandbox run script listening on port/)).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('tab', { name: 'Terminal 1', exact: true }).click();
  await page.getByRole('application', { name: 'Terminal' }).click();
  await page.keyboard.type('echo recoverheron-$((40+2))\n');
  await expect(page.locator('.xterm')).toContainText('recoverheron-42', { timeout: 30_000 });
  const heronTurn = `Recoverheron mid turn ff-scenario:gated-stream:${GATES.turn}`;
  await send(page, heronTurn, 'Send message');
  await expect(conversation.getByText(`Waiting at gate ${GATES.turn}.`)).toBeVisible({
    timeout: 60_000,
  });

  // Plover: a turn waiting at a gate, and a second message queued behind it.
  await page.goto(board);
  await launchWorkspace(page, 'Recoverplover queues behind', /recoverplover/);
  const plover = workspaceIdOf(page);
  const ploverUrl = page.url();
  await send(
    page,
    `Recoverplover first ff-scenario:gated-stream:${GATES.queuedTurn}`,
    'Send message'
  );
  await expect(conversation.getByText(`Waiting at gate ${GATES.queuedTurn}.`)).toBeVisible({
    timeout: 60_000,
  });
  const queued = 'Recoverplover queued behind the turn';
  await send(page, queued, 'Queue message');
  await expect(conversation.getByRole('button', { name: 'Cancel queued message' })).toBeVisible();
  await expect(conversation.getByText(queued, { exact: true })).toBeVisible();

  // Curlew: provisioning, its setup script held at a gate.
  await page.goto(board);
  holdNextSetup(sandbox, GATES.setup);
  const curlew = await launchWithoutWaiting(page, 'Recovercurlew waits for setup', /recovercurlew/);
  const curlewUrl = page.url();
  await expect(page.getByText(/^Running init script/)).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => workspaceRow(sandbox, curlew).initScriptPid, { timeout: 60_000 })
    .not.toBeNull();
  const setupPid = workspaceRow(sandbox, curlew).initScriptPid;

  const run = runScriptRow(sandbox, heron);
  expect(run).toMatchObject({ status: 'RUNNING', pid: expect.any(Number) });
  const [heronTerminal] = terminalRows(sandbox, heron);
  expect(heronTerminal?.pid).toEqual(expect.any(Number));
  expect(sessionRows(sandbox, heron)).toEqual([expect.objectContaining({ status: 'RUNNING' })]);
  expect(sessionRows(sandbox, plover)).toEqual([expect.objectContaining({ status: 'RUNNING' })]);
  const worktrees = Object.fromEntries(
    (
      [
        ['heron', heron],
        ['plover', plover],
        ['curlew', curlew],
      ] as const
    ).map(([name, id]) => [name, workspaceRow(sandbox, id).worktreePath ?? ''])
  );

  // The kill. Children are listed from the tree read just before it: once the backend is gone
  // they are reparented and no longer descend from it.
  tree = await readBackendTree();
  const killed = tree;
  await reportProcesses('Backend processes before the kill', killed.descendants);
  const killedAt = new Date().toISOString();
  await killBackend('SIGKILL');
  await reportProcesses('Still alive at once after the kill', survivorsOf(killed));
  // Each Codex ACP adapter outlives the backend briefly (it interrupts its turn on the way out);
  // the shells and Codex app-servers end with it. What stays is not owned by anyone.
  await expect
    .poll(() => rolesByWorkspace(survivorsOf(killed), worktrees), { timeout: 30_000 })
    .toEqual({ heron: ['run script'], plover: [], curlew: ['setup script'] });
  await reportProcesses('Still alive once the adapters have exited', survivorsOf(killed));

  await restartBackend();

  await test.step('a turn running when the server dies', async () => {
    // KNOWN GAP: https://github.com/purplefish-ai/factory-factory/issues/3357
    // The turn is cut off: the restarted server marks the session idle and shows the partial reply
    // the adapter recorded as it exited, with no notice that the turn was interrupted; nothing
    // resumes it.
    expect(sessionRows(sandbox, heron)).toEqual([expect.objectContaining({ status: 'IDLE' })]);
    const rollout = rolloutHolding(sandbox, 'Recoverheron');
    expect(readFileSync(rollout.file, 'utf8')).toContain(`Waiting at gate ${GATES.turn}. `);
    await page.goto(heronUrl);
    await expect(page.getByRole('tab', { name: 'Stopped Chat 1' })).toBeVisible({
      timeout: 60_000,
    });
    await expect
      .poll(() => conversation.ariaSnapshot(), { timeout: 60_000 })
      .toBe(
        [
          '- log "Conversation":',
          '  - text: Recoverheron runs everything',
          '  - paragraph: Recoverheron runs everything',
          `  - text: ${heronTurn}`,
          `  - paragraph: Waiting at gate ${GATES.turn}.`,
        ].join('\n')
      );
  });

  await test.step('a run script', async () => {
    // KNOWN GAP: https://github.com/purplefish-ai/factory-factory/issues/3360
    // The dev server outlives the backend and the restarted server adopts its row: shown running on
    // its port, and Stop ends it. Its output before the restart is gone, and nothing reads what it
    // writes after it.
    expect(runScriptRow(sandbox, heron)).toEqual(run);
    await expect(stopDevServer).toBeVisible();
    expect(await (await fetch(`http://127.0.0.1:${run.port}/`)).text()).toBe(
      'Sandbox run script\n'
    );
    await page.getByRole('tab', { name: 'Logs', exact: true }).click();
    await devLog.click();
    // A new page's log shows what the server kept: only its own greeting.
    await expect(page.getByText(/^Connected!\s*$/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Sandbox run script listening on port/)).toHaveCount(0);
    await stopDevServer.click();
    await expect(page.getByRole('button', { name: /^Start dev server/ })).toBeVisible({
      timeout: 60_000,
    });
    expect(runScriptRow(sandbox, heron)).toEqual({ status: 'IDLE', pid: null, port: null });
    await expect
      .poll(() => readProcessTable().some((row) => row.pid === run.pid && !row.zombie))
      .toBe(false);
  });

  await test.step('a terminal', async () => {
    // KNOWN GAP: https://github.com/purplefish-ai/factory-factory/issues/3361
    // The shell ends with the server (it was not among the survivors above) and its output is lost:
    // the restarted server clears the old row's pid and the page opens a new, empty shell as
    // "Terminal 1".
    await page.getByRole('tab', { name: 'Terminal 1', exact: true }).click();
    await expect(page.locator('.xterm')).toBeVisible();
    await expect(page.locator('.xterm')).not.toContainText('recoverheron-42');
    await expect
      .poll(() => terminalRows(sandbox, heron), { timeout: 30_000 })
      .toEqual([
        { status: 'IDLE', pid: null },
        { status: 'IDLE', pid: expect.any(Number) },
      ]);
  });

  await test.step('a prompt queued behind a running turn', async () => {
    // KNOWN GAP: https://github.com/purplefish-ai/factory-factory/issues/3358
    // The queued message is lost: neither queued nor sent after the restart, and absent from the
    // conversation (plan task 3.4 makes accepted prompts durable).
    await page.goto(ploverUrl);
    await expect(page.getByRole('tab', { name: 'Stopped Chat 1' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      conversation.getByText(`Waiting at gate ${GATES.queuedTurn}.`, { exact: true })
    ).toBeVisible({ timeout: 60_000 });
    await expect(conversation.getByText(queued)).toHaveCount(0);
    await expect(conversation.getByRole('button', { name: 'Cancel queued message' })).toHaveCount(
      0
    );
    expect(sessionRows(sandbox, plover)).toEqual([expect.objectContaining({ status: 'IDLE' })]);
  });

  await test.step('a workspace provisioning with its setup script alive', async () => {
    // Startup recovery looks only at PROVISIONING rows older than ten minutes (and would skip
    // this one while its script runs): the restarted server leaves it as it was.
    expect(workspaceRow(sandbox, curlew)).toMatchObject({
      status: 'PROVISIONING',
      initScriptPid: setupPid,
    });
    expect(
      readServerLog().filter(
        (record) =>
          record.timestamp > killedAt &&
          /provisioning/i.test(record.message) &&
          record.context?.workspaceId === curlew
      )
    ).toEqual([]);
    await page.goto(curlewUrl);
    await expect(page.getByText(/^Running init script/)).toBeVisible({ timeout: 60_000 });

    // KNOWN GAP: https://github.com/purplefish-ai/factory-factory/issues/3359
    // Nothing owns the script any more: when it ends, the workspace stays PROVISIONING with the
    // dead pid, still shown setting up, and its first prompt is never sent. Only the periodic
    // reconciliation (every five minutes) marks it FAILED, once it is ten minutes old.
    writeFileSync(gateFile(GATES.setup), '');
    await expect
      .poll(() => readProcessTable().some((row) => row.pid === setupPid && !row.zombie), {
        timeout: 30_000,
      })
      .toBe(false);
    expect(workspaceRow(sandbox, curlew)).toMatchObject({
      status: 'PROVISIONING',
      initScriptPid: setupPid,
    });
    await expect(page.getByText(/^Running init script/)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute(
      'placeholder',
      'Type a message to start the agent…'
    );
    expect(sessionRows(sandbox, curlew)).toEqual([
      expect.objectContaining({ status: 'IDLE', providerSessionId: null }),
    ]);
  });
});
