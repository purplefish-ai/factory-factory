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
const DEFAULT_RESOLUTION_MS = 20;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Measures how long the backend event loop is blocked. Everything here
 * (agent streams, SQLite queries, WebSocket fan-out) shares one thread, so lag
 * shows up as slow UI and delayed agent output. Reads report the window since
 * the previous read and then start a new one.
 *
 * Starts and stops are reference-counted so several server instances in one
 * process can share the monitor without one stop disabling it for the others.
 */
export class EventLoopMonitor {
  private histogram?: EventLoopDelayHistogram;
  private resolutionMs = DEFAULT_RESOLUTION_MS;
  private utilizationBaseline?: EventLoopUtilization;
  private windowStartedAt = 0;
  private owners = 0;

  start(resolutionMs = DEFAULT_RESOLUTION_MS): void {
    this.owners += 1;
    if (this.histogram) {
      return;
    }
    this.resolutionMs = resolutionMs;
    this.histogram = monitorEventLoopDelay({ resolution: resolutionMs });
    this.histogram.enable();
    this.resetWindow();
  }

  stop(): void {
    if (this.owners === 0) {
      return;
    }
    this.owners -= 1;
    if (this.owners > 0) {
      return;
    }
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
    // The histogram records the time between timer ticks, so an idle loop
    // reports the sampling interval itself; subtract it to report lag only.
    const lagMs = (nanoseconds: number): number =>
      hasSamples ? round(Math.max(0, nanoseconds / NS_PER_MS - this.resolutionMs)) : 0;
    const stats: EventLoopStats = {
      windowMs: round(performance.now() - this.windowStartedAt),
      delayMs: {
        mean: lagMs(histogram.mean),
        p50: lagMs(histogram.percentile(50)),
        p99: lagMs(histogram.percentile(99)),
        max: lagMs(histogram.max),
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
