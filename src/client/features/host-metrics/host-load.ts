import type { StatusTone } from '@/client/lib/status-tones';

export interface HostLoadSample {
  /** Epoch milliseconds, on the server's clock. */
  at: number;
  cpuPercent: number;
  memoryPercent: number;
}

export type HostLoadTone = Extract<StatusTone, 'neutral' | 'warning' | 'danger'>;

const WARNING_PERCENT = 80;
const DANGER_PERCENT = 95;
/**
 * Long enough to ignore one busy tick: the last three samples at the desktop
 * poll rate, which cover about fifteen seconds of CPU because each reading is
 * the average since the previous one. At a phone's 15-second rate the latest
 * sample alone covers that. The edge sits halfway between sample gaps, so a
 * poll a little early or late does not change which samples count.
 */
const RECENT_MS = 12_500;

type Reading = 'cpuPercent' | 'memoryPercent';

function recentAverage(samples: readonly HostLoadSample[], key: Reading): number {
  const latest = samples.at(-1);
  if (!latest) {
    return 0;
  }
  const recent = samples.filter((sample) => sample.at > latest.at - RECENT_MS);
  return recent.reduce((sum, sample) => sum + sample[key], 0) / recent.length;
}

function toneFor(percent: number): HostLoadTone {
  if (percent >= DANGER_PERCENT) {
    return 'danger';
  }
  return percent >= WARNING_PERCENT ? 'warning' : 'neutral';
}

export interface HostLoadSummary {
  cpu: { percent: number; tone: HostLoadTone };
  memory: { percent: number; tone: HostLoadTone };
  /** The worse of the two, for a single status light. */
  tone: HostLoadTone;
}

/** Tones follow the last few samples so one busy moment does not flash the header. */
export function summarizeHostLoad(samples: readonly HostLoadSample[]): HostLoadSummary {
  const latest = samples.at(-1);
  const cpuTone = toneFor(recentAverage(samples, 'cpuPercent'));
  const memoryTone = toneFor(recentAverage(samples, 'memoryPercent'));
  const tone =
    cpuTone === 'danger' || memoryTone === 'danger'
      ? 'danger'
      : cpuTone === 'warning' || memoryTone === 'warning'
        ? 'warning'
        : 'neutral';
  return {
    cpu: { percent: latest?.cpuPercent ?? 0, tone: cpuTone },
    memory: { percent: latest?.memoryPercent ?? 0, tone: memoryTone },
    tone,
  };
}

export interface SparklinePoint {
  at: number;
  value: number;
}

/**
 * SVG points for a 0–100% series stretched across `width`, each placed by when
 * it was taken, so readings polled at different rates share one time axis. The
 * scale is fixed rather than fitted, so a quiet machine draws a low line
 * instead of an alarming zoomed-in one.
 */
export function sparklinePoints(
  points: readonly SparklinePoint[],
  width: number,
  height: number
): string {
  const first = points[0];
  const last = points.at(-1);
  if (!(first && last)) {
    return '';
  }
  const span = last.at - first.at;
  const series =
    span > 0
      ? points.map((point) => ({ x: ((point.at - first.at) / span) * width, value: point.value }))
      : [
          { x: 0, value: last.value },
          { x: width, value: last.value },
        ];
  return series
    .map(({ x, value }) => {
      const clamped = Math.min(100, Math.max(0, value));
      const y = height - (clamped / 100) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
