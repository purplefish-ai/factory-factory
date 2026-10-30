import { afterEach, describe, expect, it } from 'vitest';
import { EventLoopMonitor } from './event-loop-monitor';

function blockFor(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait to stall the event loop.
  }
}

function nextTimer(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EventLoopMonitor', () => {
  let monitor = new EventLoopMonitor();

  afterEach(() => {
    while (monitor.read()) {
      monitor.stop();
    }
    monitor = new EventLoopMonitor();
  });

  it('returns null until started', () => {
    expect(monitor.read()).toBeNull();
  });

  it('reports lag beyond the sampling interval and resets the window after each read', async () => {
    monitor.start(10);
    await nextTimer(30);
    blockFor(120);
    await nextTimer(30);

    const blocked = monitor.read();
    expect(blocked?.delayMs.max).toBeGreaterThanOrEqual(80);
    expect(blocked?.utilization).toBeGreaterThan(0);
    expect(blocked?.utilization).toBeLessThanOrEqual(1);

    await nextTimer(60);
    const idle = monitor.read();
    // An idle loop samples at roughly the resolution, which is not lag.
    expect(idle?.delayMs.p50).toBeLessThan(10);
    expect(idle?.delayMs.max).toBeLessThan(blocked?.delayMs.max ?? 0);
  });

  it('keeps running until every owner has stopped it', () => {
    monitor.start();
    monitor.start();

    monitor.stop();
    expect(monitor.read()).not.toBeNull();

    monitor.stop();
    expect(monitor.read()).toBeNull();

    // Extra stops are ignored rather than going negative.
    monitor.stop();
    monitor.start();
    expect(monitor.read()).not.toBeNull();
  });
});
