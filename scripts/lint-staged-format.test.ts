import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'ff-staged-format-'));

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function commit(files: Record<string, string>) {
  const root = mkdtempSync(join(directory, 'repository-'));
  function git(...args: string[]) {
    return spawnSync(
      'git',
      [
        '-c',
        'user.name=Formatter Fixture',
        '-c',
        'user.email=formatter-fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${join(root, '.git/hooks')}`,
        ...args,
      ],
      { cwd: root, encoding: 'utf8' }
    );
  }
  expect(git('init', '--quiet').status).toBe(0);
  writeFileSync(join(root, '.gitkeep'), '');
  expect(git('add', '.gitkeep').status).toBe(0);
  expect(git('commit', '--quiet', '-m', 'Initialize fixture').status).toBe(0);
  copyFileSync('.oxfmtrc.json', join(root, '.oxfmtrc.json'));
  const hook = join(root, '.git/hooks/pre-commit');
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, resolve('node_modules/lint-staged/bin/lint-staged.js')]
    .map((value) => shellQuote(value.replaceAll('\\', '/')))
    .join(' ');
  writeFileSync(
    hook,
    `#!/bin/sh\nexec ${command} --config ${shellQuote(resolve('package.json').replaceAll('\\', '/'))}\n`
  );
  chmodSync(hook, 0o755);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  expect(git('add', '--', ...Object.keys(files)).status).toBe(0);
  const result = git('commit', '-m', 'Format staged fixture');
  return { result, git, read: (name: string) => readFileSync(join(root, name), 'utf8') };
}

describe('staged formatter commit path', () => {
  it('commits package and ignored lockfile changes without an empty-target failure', () => {
    const lockfile = 'lockfileVersion:    9.0\n';
    const { result, git, read } = commit({
      'package.json': '{"name":"staged-fixture","private":true}',
      'pnpm-lock.yaml': lockfile,
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout + result.stderr).not.toContain('Expected at least one target file');
    expect(result.status).toBe(0);
    expect(read('package.json')).toBe('{\n  "name": "staged-fixture",\n  "private": true\n}\n');
    expect(git('show', 'HEAD:pnpm-lock.yaml').stdout).toBe(lockfile);
    expect(git('status', '--porcelain', '--untracked-files=no').stdout).toBe('');
  });

  it('continues formatting ordinary YAML and Markdown alongside the ignored lockfile', () => {
    const { result, git, read } = commit({
      'settings.yaml': 'items: [one,two]\n',
      'README.md': '##    Example\n',
      'pnpm-lock.yaml': 'lockfileVersion:    9.0\n',
    });
    expect(result.status).toBe(0);
    expect(read('settings.yaml')).toBe('items: [one, two]\n');
    expect(read('README.md')).toBe('## Example\n');
    expect(git('status', '--porcelain', '--untracked-files=no').stdout).toBe('');
  });

  it('continues rejecting malformed YAML instead of masking formatter errors', () => {
    const { result } = commit({ 'settings.yaml': 'items: [one,\n' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('oxfmt');
  });
});
