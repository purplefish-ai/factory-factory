import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerShutdownSignalHandlers } from './shutdown-signal-handlers';

function createHarness(stop: () => Promise<void>) {
  const exits: number[] = [];
  const errors: unknown[] = [];
  const process = Object.assign(new EventEmitter(), {
    exit(code: number) {
      exits.push(code);
    },
  });
  let stopCount = 0;
  registerShutdownSignalHandlers({
    process,
    logger: {
      info() {
        /* Logs are not relevant to cleanup ordering. */
      },
      error(_message: string, error: unknown) {
        errors.push(error);
      },
    },
    server: {
      stop() {
        stopCount += 1;
        return stop();
      },
    },
  });
  return { process, exits, errors, stopCount: () => stopCount };
}

describe('backend shutdown signal handlers', () => {
  it('waits for cleanup before exiting successfully', async () => {
    let finish: (() => void) | undefined;
    const harness = createHarness(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    harness.process.emit('SIGTERM');
    expect(harness.stopCount()).toBe(1);
    expect(harness.exits).toEqual([]);
    finish?.();
    await vi.waitFor(() => expect(harness.exits).toEqual([0]));
  });

  it('reports cleanup rejection and exits with failure', async () => {
    const error = new Error('cleanup failed');
    const harness = createHarness(() => Promise.reject(error));
    harness.process.emit('SIGINT');
    await vi.waitFor(() => expect(harness.exits).toEqual([1]));
    expect(harness.errors).toEqual([error]);
  });

  it('starts cleanup only once when both termination signals arrive', async () => {
    const harness = createHarness(() => Promise.resolve());
    harness.process.emit('SIGINT');
    harness.process.emit('SIGTERM');
    expect(harness.stopCount()).toBe(1);
    await vi.waitFor(() => expect(harness.exits).toEqual([0]));
  });
});
