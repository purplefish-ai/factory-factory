import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cruiseFixture } from '@/backend/testing/dependency-cruiser';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  ['src/backend/app-context.ts', false],
  ['src/client/features/chat/example.ts', false],
  ['src/shared/unrelated.ts', false],
  ['src/shared/schemas/agent-definition.schema.ts', true],
  ['src/backend/lib/session-model.ts', true],
  ['src/backend/services/session/service/data/example.ts', true],
])('guards shared model normalization from %s', async (source, allowed) => {
  const root = mkdtempSync(join(tmpdir(), 'ff-session-model-boundary-'));
  directories.push(root);
  const target = 'src/shared/session-model.ts';
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
  for (const path of [source, target]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
  }
  writeFileSync(join(root, target), 'export const value = 1;\n');
  const importPath = relative(dirname(source), target).replace(/\.ts$/, '');
  writeFileSync(
    join(root, source),
    `import { value } from '${importPath.startsWith('.') ? importPath : `./${importPath}`}';\nexport const result = value;\n`
  );
  const result = await cruiseFixture(root);
  expect(result.exitCode).toBe(allowed ? 0 : 1);
  if (!allowed) {
    expect(result.output).toContain('session-model-import-boundary');
  }
});
