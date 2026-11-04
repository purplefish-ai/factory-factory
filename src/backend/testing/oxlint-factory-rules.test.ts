import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ff-oxlint-rules-')));
const binary = resolve('node_modules/.bin/oxlint');
const config = join(directory, '.oxlintrc.json');
const rules = [
  'no-await-import',
  'icon-button-name',
  'no-native-dialogs',
  'no-next-directives',
  'no-zod-any',
  'no-unsafe-json-parse-cast',
  'no-unsafe-resolver-cast',
  'no-raw-palette-classes',
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
    ['icon-button-name', 'const x = <Button size="icon" aria-label={""}><XIcon /></Button>;'],
    ['icon-button-name', 'const x = <Button size="icon" aria-label={``}><XIcon /></Button>;'],
    ['icon-button-name', 'const x = <button><span><XIcon /></span></button>;'],
    ['icon-button-name', 'const x = <button><Icons.Close /></button>;'],
    ['icon-button-name', 'const x = <button><Toolkit.CloseIcon /></button>;'],
    [
      'icon-button-name',
      'const x = <Button size="icon"><XIcon /><span aria-hidden>Close</span></Button>;',
    ],
    [
      'icon-button-name',
      'const x = <Button asChild size="icon"><a aria-label=""><XIcon /></a></Button>;',
    ],
    ['icon-button-name', 'const x = <Button size="icon"><PlusIcon /></Button>;'],
    ['icon-button-name', 'const x = <button><XIcon /></button>;'],
    ['icon-button-name', 'const x = <Button size="icon" />;'],
    ['icon-button-name', 'const x = <Button size="icon"><span /></Button>;'],
    [
      'icon-button-name',
      'const x = <Button size="icon"><span aria-hidden="true">Close</span></Button>;',
    ],
    ['icon-button-name', 'const x = <Button size="icon" aria-label=""><PlusIcon /></Button>;'],
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
    ['no-raw-palette-classes', 'const className = "flex bg-red-500";'],
    ['no-raw-palette-classes', 'export const chip = <span className="dark:text-emerald-300" />;'],
    ['no-raw-palette-classes', 'const className = `${base} hover:border-sky-500/40`;'],
    ['no-raw-palette-classes', 'const progress = "[&>div]:bg-zinc-900";'],
    ['no-raw-palette-classes', 'const glow = "text-shadow-red-500";'],
    ['no-raw-palette-classes', 'const className = "dark:text-red-500";'],
    ['no-raw-palette-classes', 'const className = "p-2 !bg-red-500";'],
    ['no-raw-palette-classes', 'const glow = "inset-ring-amber-400/50";'],
  ];
  const rejectedFixtures = rejectedSources.map(([rule, source], index) => ({
    rule,
    source,
    file: join(directory, `rejected-${index}.tsx`),
  }));

  const acceptedFixtures = [
    'const x = <Button size="icon"><><XIcon /><span className="sr-only">Close</span></></Button>;',
    'const x = <button><span><XIcon /></span>Close</button>;',
    'const x = <Button asChild size="icon"><a aria-label="Close"><XIcon /></a></Button>;',

    'const x = <Button size="icon" aria-label="Add workspace"><PlusIcon /></Button>;',
    'const x = <button title="Close"><XIcon /></button>;',
    'const x = <Button size="icon"><PlusIcon /><span className="sr-only">Add workspace</span></Button>;',
    'const x = <Button><PlusIcon />Add workspace</Button>;',
    'const x = <Button aria-labelledby={labelId}><PlusIcon /></Button>;',

    'import { example } from "./module";',
    'async function load() { return import("./module"); }',
    'const dialog = { confirm(value: string) { return value; } }; dialog.confirm("hello");',
    'const schema = z.unknown();',
    'const parsed = JSON.parse(input); const value = schema.parse(parsed);',
    'const callback = resolve as (value: string) => void;',
    'const description = "use client";',
    'function example() { return "use server"; }',
    'const className = "bg-success/10 text-running border-destructive/30";',
    'const className = "bg-black/60 text-white";',
    'const pattern = /text-red-500/;',
    'const id = "my-text-red-500-id";',
    'const url = "/api/text-red-500";',
    'const selector = "a.text-red-500";',
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

const paletteRuleSchema = z.tuple([
  z.literal('error'),
  z.object({ exceptions: z.record(z.string(), z.string().min(1)) }),
]);
const overridesSchema = z.object({
  overrides: z.array(
    z.object({ files: z.array(z.string()), rules: z.record(z.string(), z.unknown()) })
  ),
});

describe('raw palette class exceptions', () => {
  const projectConfig = overridesSchema.parse(
    JSON.parse(readFileSync(resolve('.oxlintrc.json'), 'utf8'))
  );
  const exceptions = projectConfig.overrides.flatMap((override) => {
    const rule = override.rules['factory/no-raw-palette-classes'];
    return Array.isArray(rule) ? Object.entries(paletteRuleSchema.parse(rule)[1].exceptions) : [];
  });

  it('keeps the allowlist small, with a reason for every file', () => {
    expect(exceptions.length).toBeGreaterThan(0);
    expect(exceptions.length).toBeLessThanOrEqual(8);
    for (const [, reason] of exceptions) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it.each(exceptions.map(([file]) => file))('%s still needs its exception', (file) => {
    // Same pattern as factory/no-raw-palette-classes in lint-rules/factory.mjs.
    expect(readFileSync(resolve(file), 'utf8')).toMatch(
      /(?<=^|[\s'"`:!])(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|inset-ring|outline|fill|stroke|from|via|to|decoration|divide|shadow|inset-shadow|text-shadow|drop-shadow|accent|caret|placeholder)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(?:50|[1-9]00|950)(?![\w-])/
    );
  });
});
