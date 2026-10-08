import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'ff-oxlint-rules-'));
const binary = resolve('node_modules/.bin/oxlint');
const config = join(directory, '.oxlintrc.json');
const rules = [
  'no-await-import',
  'no-native-dialogs',
  'no-next-directives',
  'no-zod-any',
  'no-unsafe-json-parse-cast',
  'no-unsafe-resolver-cast',
];
writeFileSync(
  config,
  JSON.stringify({
    categories: { correctness: 'off' },
    plugins: [],
    jsPlugins: [{ name: 'factory', specifier: resolve('lint-rules/factory.mjs') }],
    rules: Object.fromEntries(rules.map((rule) => [`factory/${rule}`, 'error'])),
  })
);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function lint(source: string) {
  const sourceDirectory = mkdtempSync(join(directory, 'fixture-'));
  const file = join(sourceDirectory, 'fixture.tsx');
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(file, source);
  return spawnSync(binary, ['--config', config, '--format', 'json', file], {
    cwd: directory,
    encoding: 'utf8',
  });
}

describe('Oxlint project guardrails', () => {
  it.each([
    ['no-await-import', 'async function load() { return await import("./module"); }'],
    ['no-native-dialogs', 'window.confirm("Continue?");'],
    ['no-native-dialogs', 'prompt("Name", "default");'],
    ['no-native-dialogs', 'window["alert"]("Warning");'],
    ['no-next-directives', '"use client"; export const example = 1;'],
    ['no-next-directives', '"use server"; export const example = 1;'],
    ['no-zod-any', 'const schema = z.any();'],
    ['no-zod-any', 'const schema = zod.any();'],
    ['no-unsafe-json-parse-cast', 'const value = JSON.parse(input) as Response;'],
    ['no-unsafe-json-parse-cast', 'const value = JSON.parse(input) as unknown as Response;'],
    ['no-unsafe-resolver-cast', 'const callback = resolve as (value: unknown) => void;'],
    ['no-unsafe-resolver-cast', 'const callback = resolve as (value: Array<unknown>) => void;'],
  ])('rejects %s: %s', (rule, source) => {
    const result = lint(source);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`factory(${rule})`);
  });

  it.each([
    'import { example } from "./module";',
    'async function load() { return import("./module"); }',
    'const dialog = { confirm(value: string) { return value; } }; dialog.confirm("hello");',
    'const schema = z.unknown();',
    'const parsed = JSON.parse(input); const value = schema.parse(parsed);',
    'const callback = resolve as (value: string) => void;',
    'const description = "use client";',
    'function example() { return "use server"; }',
  ])('permits %s', (source) => {
    const result = lint(source);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
