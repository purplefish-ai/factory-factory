import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parseBenchmarkOrigin } from './file-viewer-origin.mjs';

const invalidOrigin = 'Expected an HTTP(S) origin without a path, query, hash, or credentials';

it.each([
  'http://127.0.0.1:5173/prefix/',
  'http://127.0.0.1:5173/?mode=test',
  'http://127.0.0.1:5173/#fixture',
  'http://127.0.0.1:5173/?',
  'http://127.0.0.1:5173/#',
  'http://127.0.0.1:5173/?#',
  'http://user:secret@127.0.0.1:5173/',
  'file:///tmp/',
  'not a URL',
])('rejects a non-origin benchmark argument: %s', (argument) => {
  expect(() => parseBenchmarkOrigin(argument)).toThrow(invalidOrigin);
});

it.each([
  ['http://127.0.0.1:5173', 'http://127.0.0.1:5173/'],
  ['http://127.0.0.1:5173/', 'http://127.0.0.1:5173/'],
  ['https://example.com', 'https://example.com/'],
  ['https://example.com/', 'https://example.com/'],
])('accepts a benchmark origin: %s', (argument, expected) => {
  expect(parseBenchmarkOrigin(argument).href).toBe(expected);
});

it('defaults to the local Vite origin when no argument is provided', () => {
  expect(parseBenchmarkOrigin().href).toBe('http://127.0.0.1:5173/');
});

it('rejects an invalid CLI origin before launching Chrome', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./file-viewer.mjs', import.meta.url)), 'not a URL'],
    { encoding: 'utf8', timeout: 2000 }
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(invalidOrigin);
  expect(result.stderr).not.toContain('browserType.launch');
});
