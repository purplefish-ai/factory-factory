import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cruise } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { afterAll, expect, it } from 'vitest';
import configuration from '../.dependency-cruiser.cjs';

const directory = mkdtempSync(join(tmpdir(), 'ff-pr-trigger-policy-'));
const binary = resolve('node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function createFixture(source: string, target: string, typeOnly = true) {
  const root = realpathSync(mkdtempSync(join(directory, 'fixture-')));
  copyFileSync('.dependency-cruiser.cjs', join(root, '.dependency-cruiser.cjs'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  const sourcePath = join(root, source);
  const targetPath = join(root, target);
  mkdirSync(dirname(sourcePath), { recursive: true });
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, 'export interface Value {}\nexport const value = 1;\n');
  const targetImport = `./${target.slice('src/shared/'.length).replace(/\.ts$/, '')}`;
  // Application and external imports are relative to the shared module too.
  const importPath = target.startsWith('src/shared/')
    ? targetImport
    : `../${target.slice('src/'.length).replace(/\.ts$/, '')}`;
  writeFileSync(
    sourcePath,
    typeOnly
      ? `import type { Value } from '${importPath}';\nexport type Result = Value;\n`
      : `import { value } from '${importPath}';\nexport const result = value;\n`
  );
  return root;
}

async function checkImport(source: string, target: string, typeOnly = true) {
  const root = createFixture(source, target, typeOnly);
  const result = await cruise(
    ['src'],
    {
      ...configuration.options,
      // Resolve symlinks such as macOS /var before matching root-relative rules.
      baseDir: root,
      ruleSet: configuration,
      validate: true,
      outputType: 'err',
    },
    {},
    { tsConfig: extractTSConfig(join(root, 'tsconfig.json')) }
  );
  return { status: result.exitCode, output: result.output };
}

it.each([false, true])('enforces policy through the CLI (runtime import: %s)', (runtime) => {
  const root = createFixture(
    'src/shared/pr-trigger-policy.ts',
    'src/shared/schemas/pr-event.schema.ts',
    !runtime
  );
  const result = spawnSync(
    process.execPath,
    [binary, 'src', '--config', '.dependency-cruiser.cjs'],
    {
      cwd: root,
      encoding: 'utf8',
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(runtime ? 1 : 0);
  if (runtime) {
    expect(result.stdout + result.stderr).toContain(
      'pr-trigger-policy-has-no-runtime-dependencies'
    );
  }
});

it.each([
  'src/shared/pr-monitoring.ts',
  'src/backend/services/github/index.ts',
  'src/backend/services/workspace/resources/workspace-pr.accessor.ts',
  'src/backend/services/session/index.ts',
  'src/backend/app-context.ts',
  'src/client/features/chat/index.ts',
])('rejects even a type-only policy import of %s', async (target) => {
  const result = await checkImport('src/shared/pr-trigger-policy.ts', target);
  expect(result.status).toBeGreaterThan(0);
  expect(result.output).toContain('pr-trigger-policy-imports-only-contracts');
});

it.each(['src/shared/pr-monitoring.ts', 'src/shared/pr-trigger-policy.ts'])(
  'rejects a type-only policy-types import of %s',
  async (target) => {
    const result = await checkImport('src/shared/pr-trigger-policy.types.ts', target);
    expect(result.status).toBeGreaterThan(0);
    expect(result.output).toContain('pr-trigger-policy-types-import-only-schemas');
  }
);

it.each([
  ['src/shared/pr-trigger-policy.ts', 'src/shared/pr-trigger-policy.types.ts'],
  ['src/shared/pr-trigger-policy.ts', 'src/shared/schemas/pr-event.schema.ts'],
  ['src/shared/pr-trigger-policy.types.ts', 'src/shared/schemas/pr-event.schema.ts'],
])('allows contract import from %s to %s', async (source, target) => {
  expect((await checkImport(source, target)).status).toBe(0);
});

it.each(['src/shared/pr-trigger-policy.ts', 'src/shared/pr-trigger-policy.types.ts'])(
  'rejects runtime imports even from schemas in %s',
  async (source) => {
    const result = await checkImport(source, 'src/shared/schemas/pr-event.schema.ts', false);
    expect(result.status).toBeGreaterThan(0);
    expect(result.output).toContain('pr-trigger-policy-has-no-runtime-dependencies');
  }
);
