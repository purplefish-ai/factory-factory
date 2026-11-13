import type { StatusTone } from '@/client/lib/status-tones';

export interface HostLoadSample {
  cpuPercent: number;
  memoryPercent: number;
}

export type HostLoadTone = Extract<StatusTone, 'neutral' | 'warning' | 'danger'>;

const WARNING_PERCENT = 80;
const DANGER_PERCENT = 95;
/** Fifteen seconds at the header's poll rate: long enough to ignore one busy tick. */
const RECENT_SAMPLES = 3;

function recentAverage(samples: readonly HostLoadSample[], key: keyof HostLoadSample): number {
  const recent = samples.slice(-RECENT_SAMPLES);
  if (recent.length === 0) {
    return 0;
  }
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

/**
 * SVG points for a 0–100% series stretched across `width`. The scale is fixed
 * rather than fitted, so a quiet machine draws a low line instead of an
 * alarming zoomed-in one.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) {
    return '';
  }
  const series = values.length === 1 ? [values[0] ?? 0, values[0] ?? 0] : values;
  const step = width / (series.length - 1);
  return series
    .map((value, index) => {
      const clamped = Math.min(100, Math.max(0, value));
      const y = height - (clamped / 100) * height;
      return `${(index * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
