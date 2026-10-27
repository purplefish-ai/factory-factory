import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'ff-pr-trigger-policy-'));
const binary = resolve('node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function checkImport(source: string, target: string, typeOnly = true) {
  const root = mkdtempSync(join(directory, 'fixture-'));
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
  const result = spawnSync(
    process.execPath,
    [binary, 'src', '--config', '.dependency-cruiser.cjs'],
    {
      cwd: root,
      encoding: 'utf8',
    }
  );
  expect(result.error).toBeUndefined();
  return result;
}

it.each([
  'src/shared/pr-monitoring.ts',
  'src/backend/services/github/index.ts',
  'src/backend/services/workspace/resources/workspace-pr.accessor.ts',
  'src/backend/services/session/index.ts',
  'src/backend/app-context.ts',
  'src/client/features/chat/index.ts',
])('rejects even a type-only policy import of %s', (target) => {
  const result = checkImport('src/shared/pr-trigger-policy.ts', target);
  expect(result.status).toBeGreaterThan(0);
  expect(result.stdout + result.stderr).toContain('pr-trigger-policy-imports-only-contracts');
});

it.each(['src/shared/pr-monitoring.ts', 'src/shared/pr-trigger-policy.ts'])(
  'rejects a type-only policy-types import of %s',
  (target) => {
    const result = checkImport('src/shared/pr-trigger-policy.types.ts', target);
    expect(result.status).toBeGreaterThan(0);
    expect(result.stdout + result.stderr).toContain('pr-trigger-policy-types-import-only-schemas');
  }
);

it.each([
  ['src/shared/pr-trigger-policy.ts', 'src/shared/pr-trigger-policy.types.ts'],
  ['src/shared/pr-trigger-policy.ts', 'src/shared/schemas/pr-event.schema.ts'],
  ['src/shared/pr-trigger-policy.types.ts', 'src/shared/schemas/pr-event.schema.ts'],
])('allows contract import from %s to %s', (source, target) => {
  expect(checkImport(source, target).status).toBe(0);
});

it.each(['src/shared/pr-trigger-policy.ts', 'src/shared/pr-trigger-policy.types.ts'])(
  'rejects runtime imports even from schemas in %s',
  (source) => {
    const result = checkImport(source, 'src/shared/schemas/pr-event.schema.ts', false);
    expect(result.status).toBeGreaterThan(0);
    expect(result.stdout + result.stderr).toContain(
      'pr-trigger-policy-has-no-runtime-dependencies'
    );
  }
);
