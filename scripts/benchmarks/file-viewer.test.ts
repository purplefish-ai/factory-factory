import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each([
  'http://127.0.0.1:5173/prefix/',
  'http://127.0.0.1:5173/?mode=test',
  'http://127.0.0.1:5173/#fixture',
  'http://user:secret@127.0.0.1:5173/',
  'file:///tmp/',
  'not a URL',
])('rejects a non-origin benchmark argument before launching Chrome: %s', (argument) => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./file-viewer.mjs', import.meta.url)), argument],
    { encoding: 'utf8', timeout: 2000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'Expected an HTTP(S) origin without a path, query, hash, or credentials'
  );
});
