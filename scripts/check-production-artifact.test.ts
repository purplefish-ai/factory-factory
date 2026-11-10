import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(paths: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'ff-artifact-'));
  roots.push(root);
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'export {};');
  }
  return root;
}

function check(...args: string[]) {
  return spawnSync(process.execPath, [resolve('scripts/check-production-artifact.mjs'), ...args], {
    encoding: 'utf8',
  });
}

it('accepts runtime files and migrations without confusing test-related runtime names', () => {
  const root = fixture([
    'dist/src/backend/index.js',
    'dist/src/backend/services/port.service.js.map',
    'dist/src/shared/latest-version.js',
    'dist/src/cli/bootstrap.mjs',
    'dist/prisma/generated/client.js',
    'dist/client/assets/index-123.js',
  ]);
  const result = check(join(root, 'dist'));
  expect(result.status, result.stderr).toBe(0);
});

it.each([
  'src/backend/services/port.service.test.js',
  'src/cli/proxy.spec.d.ts.map',
  'src/backend/server.test-helpers.js',
  'src/backend/orchestration/workspace-lifecycle/workspace-init.test-harness.d.ts',
  'src/backend/testing/integration-db.js',
  'src/backend/test/helper.js',
  'src/backend/tests/helper.js',
  'src/backend/services/service-registry-check.helpers.js',
  'src/test-utils/unsafe-coerce.js',
  'src/backend/__tests__/helper.js',
  'src/backend/fixtures/fake-server.mjs',
  'scripts/check-single-writer.mjs',
])('rejects a development artifact: %s', (path) => {
  const root = fixture([`dist/${path}`]);
  const result = check(join(root, 'dist'));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(path);
});

it('checks the packed archive so stale files cannot bypass the build guard', () => {
  const root = fixture(['package/dist/src/cli/bootstrap.mjs']);
  const archive = join(root, 'package.tgz');
  let packed = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  const accepted = check('--tarball', archive);
  expect(accepted.status, accepted.stderr).toBe(0);
  mkdirSync(join(root, 'package/dist/src/backend/testing'), { recursive: true });
  writeFileSync(join(root, 'package/dist/src/backend/testing/fake-server.js'), 'export {};');
  packed = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  const rejected = check('--tarball', archive);
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr).toContain('src/backend/testing/fake-server.js');
});

it('rejects archives with no production output', () => {
  const root = fixture(['package/README.md']);
  const archive = join(root, 'empty.tgz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  const result = check('--tarball', archive);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('No production files');
});
