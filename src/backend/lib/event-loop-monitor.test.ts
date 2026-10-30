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
    // A coarse resolution keeps OS scheduling jitter under parallel suite load
    // well below the idle threshold, which is the resolution itself.
    const resolutionMs = 50;
    monitor.start(resolutionMs);
    await nextTimer(2 * resolutionMs);
    blockFor(250);
    await nextTimer(2 * resolutionMs);

    const blocked = monitor.read();
    // The block delays one tick by at least its length minus one interval.
    expect(blocked?.delayMs.max).toBeGreaterThanOrEqual(180);
    expect(blocked?.utilization).toBeGreaterThan(0);
    expect(blocked?.utilization).toBeLessThanOrEqual(1);

    await nextTimer(6 * resolutionMs);
    const idle = monitor.read();
    // An idle loop samples at roughly the resolution, which is not lag.
    expect(idle?.delayMs.p50).toBeLessThan(resolutionMs);
    expect(idle?.delayMs.max).toBeLessThan(blocked?.delayMs.max ?? 0);
  });

  it('does not count an owner when starting fails', () => {
    expect(() => monitor.start(0)).toThrow();

    monitor.start();
    monitor.stop();
    expect(monitor.read()).toBeNull();
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
