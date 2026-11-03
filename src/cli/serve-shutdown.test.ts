import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerServeShutdownHandlers, removeServePortFile } from './serve-shutdown';

let directory: string;
let dispose: (() => void) | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ff-serve-shutdown-'));
  vi.spyOn(console, 'log').mockImplementation(() => {
    /* Keep expected shutdown logging quiet. */
  });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'removes the discovery marker synchronously before %s starts asynchronous cleanup',
  (signal) => {
    const portFilePath = join(directory, '.factory-factory-port');
    writeFileSync(portFilePath, '3000');
    const controller = new AbortController();
    let markerPresentAtAbort: boolean | undefined;
    let finishCleanup = () => {
      /* Replaced by the pending cleanup resolver. */
    };
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    controller.signal.addEventListener('abort', () => {
      markerPresentAtAbort = existsSync(portFilePath);
      // Session cleanup is asynchronous and may retain children for five seconds.
      void cleanup.then(() => removeServePortFile(portFilePath));
    });
    dispose = registerServeShutdownHandlers(controller, portFilePath);
    process.emit(signal);
    expect(controller.signal.aborted).toBe(true);
    expect(markerPresentAtAbort).toBe(false);
    expect(existsSync(portFilePath)).toBe(false);
    finishCleanup();
    return cleanup;
  }
);

it('handles interruption before a port marker has been written and removes signal listeners', () => {
  const interruptListeners = process.listenerCount('SIGINT');
  const terminateListeners = process.listenerCount('SIGTERM');
  const controller = new AbortController();
  dispose = registerServeShutdownHandlers(controller, join(directory, '.factory-factory-port'));
  expect(() => process.emit('SIGINT')).not.toThrow();
  expect(controller.signal.aborted).toBe(true);
  dispose();
  expect(process.listenerCount('SIGINT')).toBe(interruptListeners);
  expect(process.listenerCount('SIGTERM')).toBe(terminateListeners);
});
