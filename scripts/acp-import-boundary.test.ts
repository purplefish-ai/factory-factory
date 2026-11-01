import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { cruiseFixture } from '@/backend/testing/dependency-cruiser';

const directory = mkdtempSync(join(tmpdir(), 'ff-acp-imports-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function checkImport(target: string) {
  const root = mkdtempSync(join(directory, 'fixture-'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  const source = join(root, 'src/backend/services/session/service/acp/acp-model-selection.ts');
  const destination = join(root, target);
  mkdirSync(dirname(source), { recursive: true });
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, 'export const value = 1;\n');
  const importPath = relative(dirname(source), destination).replaceAll('\\', '/');
  writeFileSync(source, `import { value } from '${importPath}';\nexport const result = value;\n`);
  return await cruiseFixture(root);
}

it('allows ACP model selection to use the shared model matching contract', async () => {
  expect((await checkImport('src/shared/acp-protocol/model-selection.ts')).exitCode).toBe(0);
});

it('allows only the transport-neutral runtime evidence contract', async () => {
  expect((await checkImport('src/shared/acp-protocol/runtime-observation.ts')).exitCode).toBe(0);
});

it.each([
  'src/shared/acp-protocol/unrelated.ts',
  'src/shared/event-agent-delivery.ts',
  'src/backend/services/agent-definition/index.ts',
  'src/backend/services/config.service.ts',
])('keeps ACP imports of %s blocked', async (target) => {
  const result = await checkImport(target);
  expect(result.exitCode).toBeGreaterThan(0);
  expect(result.output).toContain('acp-no-external-imports');
});
