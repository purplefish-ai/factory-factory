import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { cruise } from 'dependency-cruiser';
import extractTSConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { afterAll, expect, it } from 'vitest';
import configuration from '../.dependency-cruiser.cjs';

const directory = mkdtempSync(join(tmpdir(), 'ff-acp-imports-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function checkImport(target: string) {
  const root = realpathSync(mkdtempSync(join(directory, 'fixture-')));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  const source = join(root, 'src/backend/services/session/service/acp/acp-model-selection.ts');
  const destination = join(root, target);
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, 'export const value = 1;\n');
  const importPath = relative(dirname(source), destination).replaceAll('\\', '/');
  writeFileSync(source, `import { value } from '${importPath}';\nexport const result = value;\n`);
  return await cruise(
    ['src'],
    {
      ...configuration.options,
      baseDir: root,
      ruleSet: configuration,
      validate: true,
      outputType: 'err',
    },
    {},
    { tsConfig: extractTSConfig(join(root, 'tsconfig.json')) }
  );
}

it('allows ACP model selection to use the shared model matching contract', async () => {
  expect((await checkImport('src/shared/acp-protocol/model-selection.ts')).exitCode).toBe(0);
});

it.each(['src/shared/acp-protocol/unrelated.ts', 'src/backend/services/config.service.ts'])(
  'keeps ACP imports of %s blocked',
  async (target) => {
    const result = await checkImport(target);
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.output).toContain('acp-no-external-imports');
  }
);
