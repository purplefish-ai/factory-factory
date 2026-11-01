import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('packs unpacked files and compares filtered directories with patched glob dependencies', () => {
  // Resolve through the real packaging graph rather than hoisted test dependencies.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=commonjs',
      '-e',
      `
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const builder = createRequire(require.resolve('app-builder-lib', {
  paths: [require.resolve('electron-builder')],
}));
const asar = builder('@electron/asar');
const universal = createRequire(builder.resolve('@electron/universal'));
const compare = universal('dir-compare');
const installer = createRequire(builder.resolve('electron-builder-squirrel-windows'));
const temp = createRequire(installer.resolve('electron-winstaller'));
const cleanup = createRequire(temp.resolve('temp'));
const rimraf = cleanup('rimraf');
const directory = mkdtempSync(join(tmpdir(), 'ff-packaging-deps-'));
(async () => {
  try {
    const source = join(directory, 'source');
    const target = join(directory, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'native.node'), 'native fixture');
    writeFileSync(join(source, 'index.js'), 'module.exports = 1;');
    writeFileSync(join(target, 'native.node'), 'native fixture');
    const archive = join(directory, 'app.asar');
    await asar.createPackageWithOptions(source, archive, { unpack: '*.node' });
    assert.equal(asar.statFile(archive, 'native.node').unpacked, true);
    assert.equal(asar.extractFile(archive, 'native.node').toString(), 'native fixture');
    assert.equal(asar.extractFile(archive, 'index.js').toString(), 'module.exports = 1;');
    const comparison = await compare.compare(source, target, {
      includeFilter: '*.node', compareContent: true,
    });
    assert.equal(comparison.same, true);
    await new Promise((resolve, reject) => {
      rimraf(join(source, '*.node'), error => error ? reject(error) : resolve());
    });
    assert.deepEqual(require('node:fs').readdirSync(source), ['index.js']);
    rimraf.sync(join(source, '*.js'));
    assert.deepEqual(require('node:fs').readdirSync(source), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
    ],
    { encoding: 'utf8', timeout: 15_000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
