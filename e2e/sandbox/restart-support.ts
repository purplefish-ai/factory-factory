import { execFileSync } from 'node:child_process';
import {
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, type Page, test } from '@playwright/test';
import { z } from 'zod';
import { sandboxPaths } from '../../scripts/sandbox/paths.mjs';
import { HOLD_SETUP_FILE } from '../../scripts/sandbox/prepare.mjs';
import { backendStatus } from '../support/backend-process';
import type { Sandbox } from './sandbox';

// What the restart characterisation specs (restart-*.spec.ts) share beyond ./sandbox.ts: the
// processes a killed backend leaves behind, the database rows the restarted one finds, and a
// workspace whose setup is held at a gate.

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

/** One row of the process table. A pid is the same process only while its start time matches. */
export type ProcessRow = {
  pid: number;
  ppid: number;
  startedAt: string;
  zombie: boolean;
  command: string;
};

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

export function readProcessTable(): ProcessRow[] {
  const output = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,stat=,lstart=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // `lstart` is local time in the locale's format: fix both so two reads compare equal.
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  });
  return output.split('\n').flatMap((line) => {
    const match = PS_LINE.exec(line);
    if (!match) {
      return [];
    }
    const [, pid = '', ppid = '', stat = '', startedAt = '', command = ''] = match;
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        startedAt: startedAt.replace(/\s+/g, ' '),
        zombie: stat.startsWith('Z'),
        command,
      },
    ];
  });
}

/** Every live process below `root` in `table`, children before grandchildren. */
function descendantsIn(table: ProcessRow[], roots: number[]): ProcessRow[] {
  const found: ProcessRow[] = [];
  const pids = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (!row.zombie && pids.has(row.ppid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        found.push(row);
        grew = true;
      }
    }
  }
  return found;
}

/** The backend's process tree, read just before a kill: after it, its children are reparented. */
export type BackendTree = { backendPid: number; descendants: ProcessRow[] };

export async function readBackendTree(): Promise<BackendTree> {
  const { pid, state } = await backendStatus();
  if (pid === null || state !== 'running') {
    throw new Error(`The backend is not running (${state}); nothing to read.`);
  }
  return { backendPid: pid, descendants: descendantsIn(readProcessTable(), [pid]) };
}

/** Those of the tree's processes still alive: same pid, same start time, not a zombie. */
export function survivorsOf(tree: BackendTree): ProcessRow[] {
  const live = new Map(
    readProcessTable()
      .filter((row) => !row.zombie)
      .map((row) => [row.pid, row])
  );
  return tree.descendants.filter((row) => live.get(row.pid)?.startedAt === row.startedAt);
}

/**
 * What a process of the sandbox's backend is, from its command line. The roles name the program,
 * never a path or a pid, so a list of them is stable from run to run.
 */
export function processRole(row: Pick<ProcessRow, 'command'>): string {
  const { command } = row;
  const roles: [RegExp, string][] = [
    [/sandbox-setup\.mjs/, 'setup script'],
    [/sandbox-server\.mjs/, 'run script'],
    [/\/bin\/codex\b.*app-server|\bcodex app-server/, 'codex app-server'],
    [/codex-acp|acp-adapter|codex.*acp/i, 'codex ACP adapter'],
    [/\bgit\b/, 'git'],
    [/(^|\/)-?(zsh|bash|sh)\b/, 'shell'],
  ];
  return roles.find(([pattern]) => pattern.test(command))?.[1] ?? `other: ${command.slice(0, 120)}`;
}

/** The roles of `rows`, sorted, for an assertion that does not depend on start order. */
export const rolesOf = (rows: ProcessRow[]) => rows.map(processRole).sort();

/** Prints processes in the test output and attaches them to the report. */
export async function reportProcesses(title: string, rows: ProcessRow[]) {
  const text =
    rows.length === 0
      ? `${title}: none`
      : [
          `${title}:`,
          ...rows.map(
            (row) =>
              `  ${row.pid} (parent ${row.ppid}) ${processRole(row)}${terminalLinks(row.pid)}: ${row.command}`
          ),
        ].join('\n');
  process.stdout.write(`${text}\n`);
  await test.info().attach(title, { body: text, contentType: 'text/plain' });
}

/**
 * Linux only: the pseudo-terminal a process reads from, and the terminal masters (by index) it
 * holds open. A shell lives while any process holds its master, so this shows who keeps one alive.
 */
function terminalLinks(pid: number): string {
  if (process.platform !== 'linux') {
    return '';
  }
  const links: string[] = [];
  try {
    const input = readlinkSync(`/proc/${pid}/fd/0`);
    if (input.startsWith('/dev/pts/')) {
      links.push(`reads ${input}`);
    }
    const masters = readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      if (readlinkSync(`/proc/${pid}/fd/${fd}`) !== '/dev/ptmx') {
        return [];
      }
      const index = /^tty-index:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'));
      return [index?.[1] ?? '?'];
    });
    if (masters.length > 0) {
      links.push(`holds masters of pts ${masters.join(', ')}`);
    }
  } catch {
    // Gone, or not readable.
  }
  return links.length > 0 ? ` [${links.join('; ')}]` : '';
}

/** The working directory of each of `pids` that still runs (real paths). */
export function workingDirectories(pids: number[]): Map<number, string> {
  const found = new Map<number, string>();
  if (pids.length === 0) {
    return found;
  }
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        found.set(pid, readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // Gone.
      }
    }
    return found;
  }
  let output = '';
  try {
    output = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], {
      encoding: 'utf8',
    });
  } catch (error) {
    // lsof exits 1 when some of the processes are gone; what it found is still printed.
    output = z.object({ stdout: z.string() }).safeParse(error).data?.stdout ?? '';
  }
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
    } else if (line.startsWith('n') && pid !== null) {
      found.set(pid, line.slice(1));
    }
  }
  return found;
}

/**
 * The roles of `rows`, per workspace: a process belongs to the workspace whose worktree it runs
 * in. Other specs' workspaces share the backend, so a process in none of `worktrees` is left out.
 */
export function rolesByWorkspace(rows: ProcessRow[], worktrees: Record<string, string>) {
  const directories = workingDirectories(rows.map((row) => row.pid));
  const real = Object.entries(worktrees).map(([name, path]) => [name, realpathSync(path)] as const);
  const roles: Record<string, string[]> = Object.fromEntries(real.map(([name]) => [name, []]));
  for (const row of rows) {
    const cwd = directories.get(row.pid);
    const owner = real.find(([, path]) => cwd === path)?.[0];
    if (owner) {
      roles[owner]?.push(processRole(row));
    }
  }
  for (const list of Object.values(roles)) {
    list.sort();
  }
  return roles;
}

/**
 * Ends what the backend that owned `tree` left running, if it is gone (exited, or restarted under
 * another pid), and resolves true. While it still runs (the kill or the crash never happened), its
 * children are the shared backend's own: nothing is signalled and it resolves false.
 */
export async function stopSurvivorsIfKilled(tree: BackendTree): Promise<boolean> {
  const { pid, state } = await backendStatus();
  if (pid === tree.backendPid && state !== 'exited') {
    return false;
  }
  await stopSurvivors(tree);
  return true;
}

/**
 * Checks that `check` keeps passing for `ms`: for a state that must stay as it is, where one look
 * would also pass just before a fix acts.
 */
export async function expectHolds(ms: number, check: () => void | Promise<void>) {
  const deadline = Date.now() + ms;
  do {
    await check();
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  await check();
}

/**
 * Ends what a killed backend left running: each survivor of `tree` that is still the same process,
 * and anything it started since. Nothing else is signalled.
 */
export async function stopSurvivors(tree: BackendTree) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const table = readProcessTable();
    const survivors = survivorsOf(tree);
    const targets = [
      ...survivors,
      ...descendantsIn(
        table,
        survivors.map((row) => row.pid)
      ),
    ];
    if (targets.length === 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Could not stop ${targets.map((row) => row.pid).join(', ')}.`);
    }
    for (const row of targets) {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch {
        // Gone already.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------------------------

const workspaceRowSchema = z.object({
  status: z.string(),
  worktreePath: z.string().nullable(),
  initScriptPid: z.number().nullable(),
  initErrorMessage: z.string().nullable(),
});
const runScriptRowSchema = z.object({
  status: z.string(),
  pid: z.number().nullable(),
  port: z.number().nullable(),
});
const sessionRowSchema = z.object({
  status: z.string(),
  providerSessionId: z.string().nullable(),
  providerProcessPid: z.number().nullable(),
});
const terminalRowSchema = z.object({
  status: z.string(),
  pid: z.number().nullable(),
});

/** Runs `read` on a read-only connection to the sandbox's database. */
function withDatabase<T>(sandbox: Sandbox, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(sandboxPaths(sandbox.baseDir).databasePath, {
    readOnly: true,
  });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

/** The workspace's row as the server last wrote it: what a restarted server starts from. */
export function workspaceRow(sandbox: Sandbox, workspaceId: string) {
  return workspaceRowSchema.parse(
    withDatabase(sandbox, (database) =>
      database
        .prepare(
          'SELECT status, worktreePath, initScriptPid, initErrorMessage FROM Workspace WHERE id = ?'
        )
        .get(workspaceId)
    )
  );
}

export function runScriptRow(sandbox: Sandbox, workspaceId: string) {
  return runScriptRowSchema.parse(
    withDatabase(sandbox, (database) =>
      database
        .prepare('SELECT status, pid, port FROM WorkspaceRunScript WHERE workspaceId = ?')
        .get(workspaceId)
    )
  );
}

export function sessionRows(sandbox: Sandbox, workspaceId: string) {
  return z
    .array(sessionRowSchema)
    .parse(
      withDatabase(sandbox, (database) =>
        database
          .prepare(
            'SELECT status, providerSessionId, providerProcessPid FROM AgentSession WHERE workspaceId = ? ORDER BY createdAt'
          )
          .all(workspaceId)
      )
    );
}

export function terminalRows(sandbox: Sandbox, workspaceId: string) {
  return z
    .array(terminalRowSchema)
    .parse(
      withDatabase(sandbox, (database) =>
        database
          .prepare(
            'SELECT status, pid FROM TerminalSession WHERE workspaceId = ? ORDER BY createdAt'
          )
          .all(workspaceId)
      )
    );
}

// ---------------------------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------------------------

/**
 * Holds the next workspace setup that starts at `gate`: it waits there until `releaseGate` creates
 * the gate file. Only one request at a time; a later setup finishes at once.
 */
export function holdNextSetup(sandbox: Sandbox, gate: string) {
  writeFileSync(join(sandboxPaths(sandbox.baseDir).gateDir, HOLD_SETUP_FILE), gate, {
    flag: 'wx',
  });
}

/** Withdraws a `holdNextSetup` request that no setup has taken. */
export function cancelSetupHold(sandbox: Sandbox) {
  rmSync(join(sandboxPaths(sandbox.baseDir).gateDir, HOLD_SETUP_FILE), { force: true });
}

/** The id of the workspace the page shows, from its URL. */
export function workspaceIdOf(page: Page) {
  const id = /\/workspaces\/([^/?#]+)/.exec(page.url())?.[1];
  expect(id, `a workspace URL: ${page.url()}`).toBeTruthy();
  return id ?? '';
}

/**
 * Launches a workspace from the board and opens it, without waiting for its agent: for a
 * workspace whose setup is held, which starts no agent until setup finishes.
 */
export async function launchWithoutWaiting(page: Page, prompt: string, cardName: RegExp) {
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'New workspace' }).first().click();
  await page.getByRole('textbox', { name: 'What should the agent work on?' }).fill(prompt);
  await expect(
    page.getByRole('button', { name: /^New conversation provider and model: Codex\b/ })
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Launch', exact: true }).click();
  const workspace = main
    .getByRole('link', { name: cardName })
    .and(main.locator('a:not([href*="/workspaces/optimistic-"])'));
  await expect(workspace).toBeVisible({ timeout: 180_000 });
  await workspace.click();
  await expect(page).toHaveURL(/\/workspaces\/(?!optimistic-)[^/]+/);
  return workspaceIdOf(page);
}
