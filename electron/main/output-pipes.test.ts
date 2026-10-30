import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { ignoreOutputStreamErrors } from './output-pipes.js';

it('absorbs write errors on output streams instead of raising them', () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

  expect(() => stdout.emit('error', epipe)).toThrow('write EPIPE');

  ignoreOutputStreamErrors([stdout, stderr]);

  expect(() => stdout.emit('error', epipe)).not.toThrow();
  expect(() => stderr.emit('error', epipe)).not.toThrow();
});
