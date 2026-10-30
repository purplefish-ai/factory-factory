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
  const monitor = new EventLoopMonitor();

  afterEach(() => {
    monitor.stop();
  });

  it('returns null until started', () => {
    expect(monitor.read()).toBeNull();
  });

  it('reports a blocked loop and resets the window after each read', async () => {
    monitor.start(10);
    await nextTimer(30);
    blockFor(120);
    await nextTimer(30);

    const blocked = monitor.read();
    expect(blocked?.delayMs.max).toBeGreaterThanOrEqual(80);
    expect(blocked?.utilization).toBeGreaterThan(0);
    expect(blocked?.utilization).toBeLessThanOrEqual(1);

    await nextTimer(60);
    const next = monitor.read();
    expect(next?.delayMs.max).toBeLessThan(blocked?.delayMs.max ?? 0);
  });
});
