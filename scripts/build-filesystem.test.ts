import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ff build filesystem-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function runStage(script: string) {
  return spawnSync(process.execPath, [join(import.meta.dirname, script)], {
    cwd: root,
    env: { ...process.env, PATH: '' },
    encoding: 'utf8',
  });
}

it('cleans stale output recursively while preserving source prompts and other checkout files', () => {
  mkdirSync(join(root, 'dist', 'client', 'assets'), { recursive: true });
  writeFileSync(join(root, 'dist', 'client', 'assets', 'old.js'), 'stale bundle');
  mkdirSync(join(root, 'prompts'));
  writeFileSync(join(root, 'prompts', 'system.md'), 'source prompt');
  writeFileSync(join(root, 'package.json'), '{}');

  expect(runStage('clean-dist.mjs').status).toBe(0);
  expect(existsSync(join(root, 'dist'))).toBe(false);
  expect(readFileSync(join(root, 'prompts', 'system.md'), 'utf8')).toBe('source prompt');
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{}');
  expect(runStage('clean-dist.mjs').status).toBe(0);
});

it('copies nested and hidden prompts into dist/prompts without replacing compiled output', () => {
  mkdirSync(join(root, 'prompts', 'nested'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'nested', 'system.md'), 'nested prompt');
  writeFileSync(join(root, 'prompts', '.metadata'), 'hidden prompt metadata');
  mkdirSync(join(root, 'dist', 'src'), { recursive: true });
  writeFileSync(join(root, 'dist', 'src', 'index.js'), 'compiled backend');

  expect(runStage('copy-prompts.mjs').status).toBe(0);
  expect(readFileSync(join(root, 'dist', 'prompts', 'nested', 'system.md'), 'utf8')).toBe(
    'nested prompt'
  );
  expect(readFileSync(join(root, 'dist', 'prompts', '.metadata'), 'utf8')).toBe(
    'hidden prompt metadata'
  );
  expect(readFileSync(join(root, 'dist', 'src', 'index.js'), 'utf8')).toBe('compiled backend');
  expect(readFileSync(join(root, 'prompts', 'nested', 'system.md'), 'utf8')).toBe('nested prompt');
});

it('fails the copy stage when prompt sources are missing', () => {
  mkdirSync(join(root, 'dist'));
  const result = runStage('copy-prompts.mjs');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('ENOENT');
  expect(existsSync(join(root, 'dist', 'prompts'))).toBe(false);
});
