import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const directory = mkdtempSync(join(process.cwd(), '.lint-parity-'));
const binary = resolve('node_modules/.bin/biome');

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const biomeFixtures = [
  {
    rule: 'noUnusedImports',
    extension: 'ts',
    source: "import { value as _unused } from './other'; export const kept = 1;",
  },
  { rule: 'noEmptyBlockStatements', extension: 'ts', source: 'export function empty() {}' },
  {
    rule: 'noDangerouslySetInnerHtml',
    extension: 'ts',
    source: "React.createElement('div', { dangerouslySetInnerHTML: { __html: 'child' } });",
  },
  {
    rule: 'noDangerouslySetInnerHtml',
    extension: 'js',
    source: "React.createElement('div', { dangerouslySetInnerHTML: { __html: 'child' } });",
  },
].map((fixture, index) => ({
  ...fixture,
  file: join(directory, `fixture-${index}.${fixture.extension}`),
}));

const biomeReportSchema = z.object({
  diagnostics: z.array(
    z.object({
      category: z.string(),
      severity: z.string(),
      location: z.object({ path: z.string() }),
    })
  ),
});

const oxlintReportSchema = z.object({
  diagnostics: z.array(
    z.object({
      filename: z.string(),
      code: z.string().optional(),
      message: z.string(),
      severity: z.string(),
    })
  ),
  number_of_files: z.number().int().nonnegative(),
});

function lint() {
  for (const fixture of biomeFixtures) {
    writeFileSync(fixture.file, fixture.source);
  }
  return spawnSync(binary, ['lint', '--reporter=json', ...biomeFixtures.map(({ file }) => file)], {
    encoding: 'utf8',
  });
}

function oxlint(fixtures: { file: string; source: string }[]) {
  const files = fixtures.map(({ file, source }) => {
    writeFileSync(file, source);
    return file;
  });
  return spawnSync(
    resolve('node_modules/.bin/oxlint'),
    ['--deny-warnings', '--format=json', ...files],
    { encoding: 'utf8' }
  );
}

describe('lint coverage retained during Oxc migration', () => {
  const acceptedSources: [string, string][] = [
    [
      'initialized constants captured by asynchronous callbacks',
      'export function create() { const pending: Promise<void> = Promise.resolve().finally(() => { void pending; }); return pending; }',
    ],
    [
      'delayed assignments read by earlier callback declarations',
      'export function create() { let pending: Promise<void>; const getPending = () => pending; pending = Promise.resolve(); return getPending; }',
    ],
    [
      'underscore-prefixed unused destructuring parameters',
      'export function f({ _unused }: { _unused: string }) { /* Intentionally empty. */ }',
    ],
    [
      'underscore-prefixed unused catch bindings',
      'export function f() { try { throw new Error(); } catch (_error) { return; } }',
    ],
  ];
  const acceptedFixtures = acceptedSources.map(([name, source], index) => ({
    name,
    source,
    file: join(directory, `callback-${index}.ts`),
  }));
  const rejectedFixtures = [
    {
      name: 'unused destructuring parameters',
      source: 'export function f({ unused }: { unused: string }) { /* Intentionally empty. */ }',
    },
    {
      name: 'unused catch bindings',
      source: 'export function f() { try { throw new Error(); } catch (error) { return; } }',
    },
  ].map((fixture, index) => ({ ...fixture, file: join(directory, `rejected-${index}.ts`) }));
  let oxlintReport: z.infer<typeof oxlintReportSchema>;
  let biomeResult: ReturnType<typeof lint>;
  beforeAll(() => {
    // A single real type-aware CLI run checks separate modules for both outcomes.
    const fixtures = [...acceptedFixtures, ...rejectedFixtures];
    const result = oxlint(fixtures);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    oxlintReport = oxlintReportSchema.parse(JSON.parse(result.stdout));
    expect(oxlintReport.number_of_files).toBe(fixtures.length);
    const filenames = fixtures.map(({ file }) => relative(process.cwd(), file));
    for (const diagnostic of oxlintReport.diagnostics) {
      expect(filenames).toContain(diagnostic.filename);
    }
    expect(result.status).toBe(1);
    biomeResult = lint();
  });
  it.each(acceptedFixtures)('permits $name', ({ file }) => {
    expect(
      oxlintReport.diagnostics.filter(({ filename }) => filename === relative(process.cwd(), file))
    ).toEqual([]);
  });

  it.each(biomeFixtures)('continues enforcing $rule in $extension', ({ rule, file }) => {
    expect(biomeResult.error).toBeUndefined();
    expect(biomeResult.status).toBe(1);
    const report = biomeReportSchema.parse(JSON.parse(biomeResult.stdout));
    expect(report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: expect.stringMatching(new RegExp(`/${rule}$`)),
          severity: 'error',
          location: { path: relative(process.cwd(), file) },
        }),
      ])
    );
  });

  it.each(rejectedFixtures)('rejects $name without an underscore prefix', ({ file }) => {
    expect(
      oxlintReport.diagnostics.filter(({ filename }) => filename === relative(process.cwd(), file))
    ).toEqual([
      expect.objectContaining({
        filename: relative(process.cwd(), file),
        code: 'eslint(no-unused-vars)',
        severity: 'error',
      }),
    ]);
  });
});
