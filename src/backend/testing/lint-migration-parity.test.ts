import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const directory = mkdtempSync(join(process.cwd(), '.lint-parity-'));
const binary = resolve('node_modules/.bin/biome');

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function lint(source: string, extension = 'ts') {
  const file = join(directory, `fixture.${extension}`);
  writeFileSync(file, source);
  return spawnSync(binary, ['lint', file], { encoding: 'utf8' });
}

function oxlint(source: string) {
  const file = join(directory, 'callback.ts');
  writeFileSync(file, source);
  return spawnSync(resolve('node_modules/.bin/oxlint'), ['--deny-warnings', file], {
    encoding: 'utf8',
  });
}

describe('lint coverage retained during Oxc migration', () => {
  it('permits initialized constants captured by asynchronous callbacks', () => {
    const result = oxlint(
      'export function create() { const pending: Promise<void> = Promise.resolve().finally(() => { void pending; }); return pending; }'
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('permits delayed assignments read by earlier callback declarations', () => {
    const result = oxlint(
      'export function create() { let pending: Promise<void>; const getPending = () => pending; pending = Promise.resolve(); return getPending; }'
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it.each([
    ['noUnusedImports', "import { value as _unused } from './other'; export const kept = 1;"],
    ['noEmptyBlockStatements', 'export function empty() {}'],
    [
      'noDangerouslySetInnerHtml',
      "React.createElement('div', { dangerouslySetInnerHTML: { __html: 'child' } });",
    ],
  ])('continues enforcing %s in TypeScript', (rule, source) => {
    const result = lint(source);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(rule);
  });

  it('continues rejecting dangerous HTML outside JSX in JavaScript', () => {
    const result = lint(
      "React.createElement('div', { dangerouslySetInnerHTML: { __html: 'child' } });",
      'js'
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('noDangerouslySetInnerHtml');
  });

  it('permits underscore-prefixed unused destructuring parameters', () => {
    const result = oxlint(
      'export function f({ _unused }: { _unused: string }) { /* Intentionally empty. */ }'
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it('rejects unused destructuring parameters without an underscore prefix', () => {
    const result = oxlint(
      'export function f({ unused }: { unused: string }) { /* Intentionally empty. */ }'
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('no-unused-vars');
  });

  it.each([
    ['error', 1],
    ['_error', 0],
  ])('enforces unused catch binding policy for %s', (binding, status) => {
    const result = oxlint(
      `export function f() { try { throw new Error(); } catch (${binding}) { return; } }`
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    if (status !== 0) {
      expect(result.stdout + result.stderr).toContain('no-unused-vars');
    }
  });
});
