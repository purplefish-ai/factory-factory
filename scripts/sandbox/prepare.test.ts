import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, describe, expect, it } from 'vitest';
import { FactoryConfigService } from '@/backend/services/run-script';
import { FactoryConfigSchema } from '@/shared/schemas/factory-config.schema';
import { buildServerEnv } from './env.mjs';
import { findFreePort } from './ports.mjs';
import {
  checkScenario,
  createSeedRepository,
  gitConfigString,
  prepareSandbox,
} from './prepare.mjs';
import { temporaryDirectories } from './test-support';

const temporary = temporaryDirectories();
afterAll(() => temporary.cleanup());

describe('scenario check', () => {
  it('stops on a scenario the fake app-server rejects, naming the valid ones', () => {
    const dir = temporary.create('ffsb-');
    const fake = join(dir, 'codex');
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'case "$FF_SANDBOX_SCENARIO" in echo) exit 0 ;; esac',
        'echo "Unknown FF_SANDBOX_SCENARIO \\"$FF_SANDBOX_SCENARIO\\". Valid scenarios: echo" >&2',
        'exit 2',
        '',
      ].join('\n')
    );
    chmodSync(fake, 0o755);
    const env = { PATH: process.env.PATH, FF_SANDBOX_SCENARIO: 'echo' };
    expect(() => checkScenario(fake, env)).not.toThrow();
    expect(() => checkScenario(fake, { ...env, FF_SANDBOX_SCENARIO: 'nope' })).toThrow(
      'The fake Codex app-server rejected scenario "nope": Unknown FF_SANDBOX_SCENARIO "nope". Valid scenarios: echo'
    );
  });
});

describe('the seed repository', () => {
  it('commits a setup script and a run script that finish or start at once', async () => {
    const paths = prepareSandbox(temporary.create('ffsb-'));
    const env = buildServerEnv({
      parentEnv: { PATH: process.env.PATH },
      baseDir: paths.baseDir,
      scenario: 'echo',
      // Never contacted: nothing here leaves the machine.
      egressPort: 9,
    });
    createSeedRepository(paths, env);
    const run = (command: string, args: string[]) =>
      execFileSync(command, args, { cwd: paths.repoPath, env, encoding: 'utf8', timeout: 15_000 });
    expect(run('git', ['status', '--porcelain'])).toBe('');
    const config = FactoryConfigSchema.parse(
      JSON.parse(readFileSync(join(paths.repoPath, 'factory-factory.json'), 'utf8'))
    );
    expect(run('sh', ['-c', config.scripts.setup ?? 'false'])).toBe('Sandbox setup finished\n');

    const port = await findFreePort();
    const server = spawn(
      'sh',
      ['-c', FactoryConfigService.substitutePort(config.scripts.run ?? 'false', port)],
      // Its own group, so that stopping it stops the server whether or not `sh` exec'd it.
      { cwd: paths.repoPath, env, detached: true }
    );
    const exited = once(server, 'exit');
    try {
      // Its first line, or the exit that came instead of it.
      const listening = await Promise.race([
        once(createInterface({ input: server.stdout }), 'line').then(([line]) => String(line)),
        exited.then(([code]) => `exited with ${code} before listening`),
      ]);
      expect(listening).toBe(`Sandbox run script listening on port ${port}`);
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(await page.text()).toBe('Sandbox run script\n');
    } finally {
      if (server.pid && server.exitCode === null && server.signalCode === null) {
        process.kill(-server.pid, 'SIGTERM');
        await exited;
      }
    }
  });
});

describe('the sandbox git configuration', () => {
  it('quotes values so git reads them back unchanged', () => {
    const file = join(temporary.create('ffsb-'), 'gitconfig');
    // A TMPDIR may hold any of these, and core.sshCommand carries it.
    const value = `'/tmp/a "b"\\c\nd/bin/ssh'`;
    writeFileSync(file, `[core]\n\tsshCommand = ${gitConfigString(value)}\n`);
    const read = execFileSync('git', ['config', '--file', file, '--get', 'core.sshCommand'], {
      encoding: 'utf8',
    });
    expect(read).toBe(`${value}\n`);
  });
});
