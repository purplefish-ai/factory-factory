import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'ff-acp-imports-'));
const binary = resolve('node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function checkImport(target: string) {
  const root = mkdtempSync(join(directory, 'fixture-'));
  copyFileSync('.dependency-cruiser.cjs', join(root, '.dependency-cruiser.cjs'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  const source = join(root, 'src/backend/services/session/service/acp/acp-model-selection.ts');
  const destination = join(root, target);
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, 'export const value = 1;\n');
  const importPath = relative(dirname(source), destination).replaceAll('\\', '/');
  writeFileSync(source, `import { value } from '${importPath}';\nexport const result = value;\n`);
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

it('allows ACP model selection to use the shared model matching contract', () => {
  expect(checkImport('src/shared/acp-protocol/model-selection.ts').status).toBe(0);
});

it.each(['src/shared/acp-protocol/unrelated.ts', 'src/backend/services/config.service.ts'])(
  'keeps ACP imports of %s blocked',
  (target) => {
    const result = checkImport(target);
    expect(result.status).toBeGreaterThan(0);
    expect(result.stdout + result.stderr).toContain('acp-no-external-imports');
  }
);
