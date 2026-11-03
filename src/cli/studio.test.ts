import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { treeKillAsync } from './runtime-utils';

const projectRoot = resolve(import.meta.dirname, '../..');

function launchStudio(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { Command } from 'commander';
       import { registerStudioCommand } from './src/cli/studio.ts';
       const program = new Command();
       registerStudioCommand(program, ${JSON.stringify(projectRoot)});
       await program.parseAsync(['node', 'ff', 'db:studio', ...process.argv.slice(1)]);`,
      '--',
      ...args,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, BROWSER: 'none', CHECKPOINT_DISABLE: '1', ...env },
      stdio: 'pipe',
    }
  );
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  return { child, output: () => output };
}

async function stopStudio(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    const exited = once(child, 'exit');
    await treeKillAsync(child.pid, 'SIGTERM');
    await exited;
  }
}

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP port');
  }
  return { server, port: address.port };
}

it('opens the explicit database on the requested port despite conflicting inherited configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-studio-'));
  const requested = join(root, 'requested database #%.db');
  const inherited = join(root, 'inherited.db');
  for (const [path, value] of [
    [requested, 'requested'],
    [inherited, 'inherited'],
  ] as const) {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE launch_contract (selected TEXT)');
    db.prepare('INSERT INTO launch_contract VALUES (?)').run(value);
    db.close();
  }
  const { server, port } = await reservePort();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  const { child, output } = launchStudio(['--database-path', requested, '--port', String(port)], {
    DATABASE_PATH: inherited,
    DATABASE_URL: `file:${inherited}`,
    BASE_DIR: join(root, 'wrong-base'),
  });
  try {
    await vi.waitFor(
      () => {
        expect(output()).toContain('Prisma Studio is running at:');
        expect(output()).toContain(`http://localhost:${port}`);
      },
      { timeout: 20_000 }
    );
    const response = await fetch(`http://localhost:${port}/bff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        procedure: 'query',
        query: { sql: 'SELECT selected FROM launch_contract', parameters: [] },
      }),
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual([null, [{ selected: 'requested' }]]);
  } finally {
    await stopStudio(child);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('returns a failure status when Prisma rejects an invalid port', async () => {
  const { child, output } = launchStudio(['--port', '65536']);
  try {
    const [code] = await once(child, 'exit');
    expect(code, output()).toBe(1);
    expect(output()).toContain('Studio port must be an integer between 1 and 65535');
  } finally {
    await stopStudio(child);
  }
}, 20_000);

it('returns a failure status when the requested port is occupied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-studio-port-'));
  const database = join(root, 'data.db');
  new DatabaseSync(database).close();
  const { server, port } = await reservePort();
  const { child, output } = launchStudio(['--database-path', database, '--port', String(port)]);
  try {
    const [code] = await once(child, 'exit');
    expect(code, output()).toBe(1);
    expect(output()).toContain('EADDRINUSE');
  } finally {
    await stopStudio(child);
    server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
