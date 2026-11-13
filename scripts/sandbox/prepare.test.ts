import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkScenario, gitConfigString } from './prepare.mjs';
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
