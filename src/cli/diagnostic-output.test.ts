import { PassThrough, Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { forwardDiagnosticOutput } from './diagnostic-output';

it('forwards output without ending the parent output stream', async () => {
  const source = new PassThrough();
  const destination = new PassThrough();
  let output = '';
  destination.on('data', (chunk) => {
    output += chunk;
  });
  const dispose = forwardDiagnosticOutput(source, destination);
  const ended = new Promise<void>((resolve) => source.once('end', resolve));
  source.end('diagnostic');
  await ended;
  expect(output).toBe('diagnostic');
  expect(destination.writableEnded).toBe(false);
  dispose();
});

it('tolerates a piped consumer closing with EPIPE', async () => {
  const source = new PassThrough();
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error('consumer closed'), { code: 'EPIPE' }));
    },
  });
  const closed = new Promise<void>((resolve) => destination.once('close', resolve));
  const dispose = forwardDiagnosticOutput(source, destination);
  source.write('diagnostic');
  await closed;
  expect(source.listenerCount('data')).toBe(0);
  dispose();
  expect(destination.listenerCount('error')).toBe(0);
});

it('tolerates a child output stream error', () => {
  const source = new PassThrough();
  const destination = new PassThrough();
  const dispose = forwardDiagnosticOutput(source, destination);
  expect(() => source.emit('error', new Error('output closed'))).not.toThrow();
  dispose();
  expect(source.listenerCount('error')).toBe(0);
});
