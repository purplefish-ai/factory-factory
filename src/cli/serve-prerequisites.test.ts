import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { checkServePrerequisites } from './serve-prerequisites';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const roots: string[] = [];
function project() {
  const root = mkdtempSync(join(tmpdir(), 'ff-prerequisites-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it('reports missing Git and production assets together', () => {
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('ENOENT');
  });
  const issues = checkServePrerequisites(project(), false);
  expect(issues.join('\n')).toMatch(/Git.*git-scm.com\/downloads/s);
  expect(issues.join('\n')).toMatch(/Reinstall factory-factory/);
});

it('allows production startup without development tools', () => {
  const root = project();
  mkdirSync(join(root, 'dist/client'), { recursive: true });
  mkdirSync(join(root, 'dist/src/backend'), { recursive: true });
  writeFileSync(join(root, 'dist/src/backend/index.js'), '');
  writeFileSync(join(root, 'dist/client/index.html'), '');
  expect(checkServePrerequisites(root, false)).toEqual([]);
});

it('explains how to install missing development tools', () => {
  const issues = checkServePrerequisites(project(), true).join('\n');
  expect(issues).toContain('pnpm install');
  expect(issues).toContain('tsx');
  expect(issues).toContain('vite');
});

it('allows development startup when the local tools are installed', () => {
  const root = project();
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  for (const tool of ['tsx', 'vite']) {
    writeFileSync(join(root, 'node_modules/.bin', `${tool}${suffix}`), '');
  }
  expect(checkServePrerequisites(root, true)).toEqual([]);
});

it('offers a build command for source checkouts with missing production assets', () => {
  const root = project();
  mkdirSync(join(root, 'src/cli'), { recursive: true });
  for (const file of ['src/cli/index.ts', 'tsconfig.backend.json', 'vite.config.ts']) {
    writeFileSync(join(root, file), '');
  }
  expect(checkServePrerequisites(root, false).join('\n')).toContain('pnpm build');
});

it('rejects an incomplete frontend build with an empty client directory', () => {
  const root = project();
  mkdirSync(join(root, 'dist/client'), { recursive: true });
  mkdirSync(join(root, 'dist/src/backend'), { recursive: true });
  writeFileSync(join(root, 'dist/src/backend/index.js'), '');
  expect(checkServePrerequisites(root, false).join('\n')).toContain('Reinstall factory-factory');
});
