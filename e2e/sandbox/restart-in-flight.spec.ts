import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { sandboxPaths } from '../../scripts/sandbox/paths.mjs';
import {
  ensureBackendRunning,
  hydrationsSince,
  killBackend,
  readServerLog,
  restartBackend,
} from '../support/backend-process';
import {
  type BackendTree,
  cancelSetupHold,
  expectHolds,
  holdNextSetup,
  launchWithoutWaiting,
  readBackendTree,
  readProcessTable,
  reportProcesses,
  rolesByWorkspace,
  runScriptRow,
  sessionRows,
  stopSurvivorsIfKilled,
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

/**
 * KNOWN GAP: https://github.com/purplefish-ai/factory-factory/issues/3363
 * On Linux every process the server starts holds the terminals opened before it (the process
 * reports show which), so a shell outlives the server while any later process does. On macOS the
 * shells end with the server.
 */
const shellsOutliveTheServer = process.platform === 'linux';

const gateFile = (gate: string) => join(sandboxPaths(readSandbox().baseDir).gateDir, gate);

test.beforeEach(() => {
  // Left by an earlier failed run in this sandbox, a gate file would release a turn at once.
  for (const gate of Object.values(GATES)) {
    rmSync(gateFile(gate), { force: true });
  }
});

test.afterEach(async () => {
  try {
    // Unclaimed, the request would hold the next workspace's setup, in another spec.
    cancelSetupHold(readSandbox());
    // Whatever the killed backend left running, which nothing else would end. Without a kill, the
    // turns and the setup still wait at their gates in the shared backend: release them.
    if (!(tree && (await stopSurvivorsIfKilled(tree)))) {
      for (const gate of Object.values(GATES)) {
        writeFileSync(gateFile(gate), '');
      }
    }
  } finally {
    tree = null;
    await ensureBackendRunning();
  }
});

/**
 * Runs each step to the end even when an earlier one failed, so that every scenario reports; the
 * test then fails with all of their errors.
 */
function stepRunner() {
  const failures: string[] = [];
  return {
    step: async (name: string, body: () => Promise<void>) => {
      try {
        await test.step(name, body);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    finish: () => {
      if (failures.length > 0) {
        throw new Error(`${failures.length} step(s) failed:\n\n${failures.join('\n\n')}`);
      }
    },
  };
}

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
  // Opened again: a page that read the run-script status before the worktree's commands were
  // saved (on a loaded machine) keeps showing "Setup dev server" until it reads it again, since
  // nothing refetches it while the status stays IDLE.
  await page.goto(heronUrl);
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
  // Each Codex ACP adapter outlives the backend for a few seconds (about 3 s in CI: it interrupts
  // its turn on the way out); the Codex app-servers end with it. What stays after that is not
  // owned by anyone. The run script and the setup script outlive the server. So do the shells on
  // Linux: the setup script started after Heron's and Plover's terminals and holds them open.
  // Curlew's terminal opens with its page, which can come before or after its setup starts, so on
  // Linux its shell survives only in the first case and is left out. Polled, so that a short-lived
  // child working in a worktree at that moment does not count.
  const shell = shellsOutliveTheServer ? ['shell'] : [];
  await expect
    .poll(
      () => {
        const roles = rolesByWorkspace(survivorsOf(killed), worktrees);
        return shellsOutliveTheServer
          ? { ...roles, curlew: roles.curlew?.filter((role) => role !== 'shell') }
          : roles;
      },
      { timeout: 30_000 }
    )
    .toEqual({
      heron: ['run script', ...shell],
      plover: shell,
      curlew: ['setup script'],
    });
  await reportProcesses('Still alive once the adapters have exited', survivorsOf(killed));

  await restartBackend();
  const { step, finish } = stepRunner();
  // Heron's page, unless a failed step left the page elsewhere.
  const onHeron = async () => {
    if (page.url() !== heronUrl) {
      await page.goto(heronUrl);
    }
  };

  await step('a turn running when the server dies', async () => {
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

  await step('a run script', async () => {
    // KNOWN GAP: https://github.com/purplefish-ai/factory-factory/issues/3360
    // The dev server outlives the backend and the restarted server adopts its row: shown running on
    // its port, and Stop ends it. Its output before the restart is gone, and nothing reads what it
    // writes after it.
    await onHeron();
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

  await step('a terminal', async () => {
    // KNOWN GAP: https://github.com/purplefish-ai/factory-factory/issues/3361
    // The page opens a new, empty shell as "Terminal 1", and the old one's output is lost. On
    // macOS the old shell ended with the server and the restarted server clears its row's pid; on
    // Linux it lives on, orphaned, and its row keeps the pid.
    await onHeron();
    await page.getByRole('tab', { name: 'Terminal 1', exact: true }).click();
    // The new shell answers, so the terminal shows all it will of the old one.
    await page.getByRole('application', { name: 'Terminal' }).click();
    await page.keyboard.type('echo recoverheron-new-$((1+1))\n');
    await expect(page.locator('.xterm')).toContainText('recoverheron-new-2', { timeout: 30_000 });
    await expect(page.locator('.xterm')).not.toContainText('recoverheron-42');
    await expect
      .poll(() => terminalRows(sandbox, heron), { timeout: 30_000 })
      .toEqual([
        { status: 'IDLE', pid: shellsOutliveTheServer ? heronTerminal?.pid : null },
        { status: 'IDLE', pid: expect.any(Number) },
      ]);
  });

  await step('a prompt queued behind a running turn', async () => {
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
    // The restarted server has loaded the session from its rollout file, and it stays idle.
    const rollout = rolloutHolding(sandbox, 'Recoverplover');
    await expect
      .poll(() => hydrationsSince(rollout.threadId, killedAt).length, { timeout: 60_000 })
      .toBe(1);
    await expectHolds(2000, async () => {
      expect(sessionRows(sandbox, plover)).toEqual([expect.objectContaining({ status: 'IDLE' })]);
      await expect(conversation.getByText(queued)).toHaveCount(0);
      await expect(conversation.getByRole('button', { name: 'Cancel queued message' })).toHaveCount(
        0
      );
    });
  });

  await step('a workspace provisioning with its setup script alive', async () => {
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
    await expectHolds(2000, async () => {
      expect(workspaceRow(sandbox, curlew)).toMatchObject({
        status: 'PROVISIONING',
        initScriptPid: setupPid,
      });
      await expect(page.getByText(/^Running init script/)).toBeVisible();
      expect(sessionRows(sandbox, curlew)).toEqual([
        expect.objectContaining({ status: 'IDLE', providerSessionId: null }),
      ]);
    });
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveAttribute(
      'placeholder',
      'Type a message to start the agent…'
    );
  });

  finish();
});
