import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ff-oxlint-rules-')));
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

const reportSchema = z.object({
  diagnostics: z.array(
    z.object({
      filename: z.string(),
      code: z.string(),
      severity: z.string(),
    })
  ),
  number_of_files: z.number().int().nonnegative(),
});

describe('Oxlint project guardrails', () => {
  const rejectedSources: [string, string][] = [
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
  ];
  const rejectedFixtures = rejectedSources.map(([rule, source], index) => ({
    rule,
    source,
    file: join(directory, `rejected-${index}.tsx`),
  }));

  const acceptedFixtures = [
    'import { example } from "./module";',
    'async function load() { return import("./module"); }',
    'const dialog = { confirm(value: string) { return value; } }; dialog.confirm("hello");',
    'const schema = z.unknown();',
    'const parsed = JSON.parse(input); const value = schema.parse(parsed);',
    'const callback = resolve as (value: string) => void;',
    'const description = "use client";',
    'function example() { return "use server"; }',
  ].map((source, index) => ({ source, file: join(directory, `accepted-${index}.tsx`) }));

  let report: z.infer<typeof reportSchema>;
  beforeAll(() => {
    // Separate modules preserve every fixture's scope while sharing one real CLI startup.
    const fixtures = [...rejectedFixtures, ...acceptedFixtures];
    for (const { file, source } of fixtures) {
      writeFileSync(file, source);
    }
    const result = spawnSync(
      binary,
      ['--config', config, '--format', 'json', ...fixtures.map(({ file }) => file)],
      { cwd: directory, encoding: 'utf8' }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    report = reportSchema.parse(JSON.parse(result.stdout));
    expect(report.number_of_files).toBe(fixtures.length);
    const filenames = fixtures.map(({ file }) => relative(directory, file));
    for (const diagnostic of report.diagnostics) {
      expect(filenames).toContain(diagnostic.filename);
    }
  });

  it.each(rejectedFixtures)('rejects $rule: $source', ({ rule, file }) => {
    expect(
      report.diagnostics.filter(({ filename }) => filename === relative(directory, file))
    ).toEqual([
      { filename: relative(directory, file), code: `factory(${rule})`, severity: 'error' },
    ]);
  });

  it.each(acceptedFixtures)('permits $source', ({ file }) => {
    expect(
      report.diagnostics.filter(({ filename }) => filename === relative(directory, file))
    ).toEqual([]);
  });
});
