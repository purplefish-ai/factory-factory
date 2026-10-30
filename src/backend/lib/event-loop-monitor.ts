import { type EventLoopUtilization, monitorEventLoopDelay, performance } from 'node:perf_hooks';

type EventLoopDelayHistogram = ReturnType<typeof monitorEventLoopDelay>;

export type EventLoopStats = {
  /** Length of the measured window. */
  windowMs: number;
  /** Event-loop delay percentiles over the window, in milliseconds. */
  delayMs: { mean: number; p50: number; p99: number; max: number };
  /** Fraction of the window the loop spent busy (0–1). */
  utilization: number;
};

const NS_PER_MS = 1e6;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Measures how long the backend event loop is blocked. Everything here
 * (agent streams, SQLite queries, WebSocket fan-out) shares one thread, so lag
 * shows up as slow UI and delayed agent output. Reads report the window since
 * the previous read and then start a new one.
 */
export class EventLoopMonitor {
  private histogram?: EventLoopDelayHistogram;
  private utilizationBaseline?: EventLoopUtilization;
  private windowStartedAt = 0;

  start(resolutionMs = 20): void {
    if (this.histogram) {
      return;
    }
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    this.histogram.enable();
    this.resetWindow();
  }

  stop(): void {
    this.histogram?.disable();
    this.histogram = undefined;
    this.utilizationBaseline = undefined;
  }

  read(): EventLoopStats | null {
    const histogram = this.histogram;
    if (!histogram) {
      return null;
    }
    const hasSamples = histogram.count > 0;
    const stats: EventLoopStats = {
      windowMs: round(performance.now() - this.windowStartedAt),
      delayMs: {
        mean: hasSamples ? round(histogram.mean / NS_PER_MS) : 0,
        p50: hasSamples ? round(histogram.percentile(50) / NS_PER_MS) : 0,
        p99: hasSamples ? round(histogram.percentile(99) / NS_PER_MS) : 0,
        max: hasSamples ? round(histogram.max / NS_PER_MS) : 0,
      },
      utilization: round(performance.eventLoopUtilization(this.utilizationBaseline).utilization),
    };
    this.resetWindow();
    return stats;
  }

  private resetWindow(): void {
    this.histogram?.reset();
    this.utilizationBaseline = performance.eventLoopUtilization();
    this.windowStartedAt = performance.now();
  }
}

export const eventLoopMonitor = new EventLoopMonitor();
