import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const directory = mkdtempSync(join(tmpdir(), 'ff-type-aware-'));
const binary = resolve('node_modules/.bin/oxlint');
const configuration = z
  .object({
    jsPlugins: z.array(z.object({ name: z.string(), specifier: z.string() })),
  })
  .passthrough()
  .parse(JSON.parse(readFileSync('.oxlintrc.json', 'utf8')));
configuration.jsPlugins = configuration.jsPlugins.map((plugin) => ({
  ...plugin,
  specifier: resolve(plugin.specifier),
}));
writeFileSync(join(directory, '.oxlintrc.json'), JSON.stringify(configuration));
writeFileSync(
  join(directory, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true }, include: ['*.ts'] })
);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function lint(source: string) {
  const file = join(directory, 'fixture.ts');
  writeFileSync(file, source);
  return spawnSync(
    binary,
    ['--config', join(directory, '.oxlintrc.json'), '--deny-warnings', '--format', 'json', file],
    {
      cwd: directory,
      encoding: 'utf8',
    }
  );
}

describe('repository type-aware promise guards', () => {
  it.each([
    ['no-floating-promises', 'Promise.resolve(1);'],
    [
      'no-misused-promises',
      'export function schedule(callback: () => void) { callback(); } schedule(async () => { await Promise.resolve(1); });',
    ],
  ])('rejects %s through the normal repository configuration', (rule, source) => {
    const result = lint(source);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`typescript(${rule})`);
  });

  it.each([
    'export async function work() { await Promise.resolve(1); }',
    'void Promise.resolve(1).catch(() => { /* Explicit error handling. */ });',
    'export function work(callback: () => Promise<void>) { return callback(); }',
  ])('permits an explicitly handled promise: %s', (source) => {
    const result = lint(source);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
