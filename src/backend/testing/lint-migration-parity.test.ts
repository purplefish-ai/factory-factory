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

function lint() {
  for (const fixture of biomeFixtures) {
    writeFileSync(fixture.file, fixture.source);
  }
  return spawnSync(binary, ['lint', '--reporter=json', ...biomeFixtures.map(({ file }) => file)], {
    encoding: 'utf8',
  });
}

function oxlint(sources: string | string[]) {
  const files = (typeof sources === 'string' ? [sources] : sources).map((source, index) => {
    const file = join(directory, `callback-${index}.ts`);
    writeFileSync(file, source);
    return file;
  });
  return spawnSync(resolve('node_modules/.bin/oxlint'), ['--deny-warnings', ...files], {
    encoding: 'utf8',
  });
}

describe('lint coverage retained during Oxc migration', () => {
  const acceptedFixtures: [string, string][] = [
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
  let acceptedResult: ReturnType<typeof oxlint>;
  let biomeResult: ReturnType<typeof lint>;
  beforeAll(() => {
    // One real type-aware CLI run must accept every fixture; each file stays a
    // separate module so declarations cannot influence another fixture.
    acceptedResult = oxlint(acceptedFixtures.map(([, source]) => source));
    biomeResult = lint();
  });
  it.each(acceptedFixtures)('permits %s', () => {
    expect(acceptedResult.error).toBeUndefined();
    expect(acceptedResult.status).toBe(0);
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

  it('rejects unused destructuring parameters without an underscore prefix', () => {
    const result = oxlint(
      'export function f({ unused }: { unused: string }) { /* Intentionally empty. */ }'
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('no-unused-vars');
  });

  it('rejects unused catch bindings without an underscore prefix', () => {
    const result = oxlint(
      'export function f() { try { throw new Error(); } catch (error) { return; } }'
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('no-unused-vars');
  });
});
