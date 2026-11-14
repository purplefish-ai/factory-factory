import { useState } from 'react';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { getStatusToneStyle, type StatusTone } from '@/client/lib/status-tones';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import {
  type HostLoadSample,
  type HostLoadTone,
  sparklinePoints,
  summarizeHostLoad,
} from './host-load';
import { type HostLoadBreakdown, HostLoadBreakdownView } from './host-load-breakdown';

const SPARK_HEIGHT = 14;
/**
 * Each reading keeps its own hue while the machine is fine, so CPU and memory
 * tell apart at a glance, and turns amber or red when it is not.
 */
const CALM_TONES = { cpu: 'info', memory: 'success' } as const satisfies Record<string, StatusTone>;

function displayTone(metric: keyof typeof CALM_TONES, tone: HostLoadTone): StatusTone {
  return tone === 'neutral' ? CALM_TONES[metric] : tone;
}

function Sparkline({
  values,
  width,
  tone,
}: {
  values: readonly number[];
  width: number;
  tone: StatusTone;
}) {
  const points = sparklinePoints(values, width, SPARK_HEIGHT);
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={SPARK_HEIGHT}
      // Button sizes unsized child SVGs as icons; a sparkline keeps its own size.
      style={{ width, height: SPARK_HEIGHT }}
      viewBox={`0 0 ${width} ${SPARK_HEIGHT}`}
      className={cn('shrink-0 overflow-visible', getStatusToneStyle(tone).text)}
    >
      {points ? (
        <>
          <polygon
            points={`${points} ${width},${SPARK_HEIGHT} 0,${SPARK_HEIGHT}`}
            className="fill-current opacity-15"
          />
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeLinejoin="round"
          />
        </>
      ) : null}
    </svg>
  );
}

/** A thin upright gauge filled from the bottom, like a battery level. */
function LevelBar({ percent }: { percent: number }) {
  const level = Math.min(100, Math.max(0, percent));
  return (
    <span
      aria-hidden="true"
      data-slot="host-load-level"
      className="relative h-3.5 w-1 shrink-0 overflow-hidden rounded-full bg-current/25"
    >
      <span
        className="absolute inset-x-0 bottom-0 min-h-px rounded-full bg-current"
        style={{ height: `${level}%` }}
      />
    </span>
  );
}

function Readout({
  metric,
  percent,
  tone,
  compact,
}: {
  metric: keyof typeof CALM_TONES;
  percent: number;
  tone: HostLoadTone;
  compact: boolean;
}) {
  return (
    <span
      data-metric={metric}
      className={cn(
        'flex items-center gap-0.5',
        getStatusToneStyle(displayTone(metric, tone)).text
      )}
    >
      <LevelBar percent={percent} />
      {/* An invisible "100%" in the same grid cell holds the width, so the
          header does not shift as the reading goes from 7% to 70% to 100%. */}
      <span className={cn('grid font-semibold tabular-nums', compact ? 'text-2xs' : 'text-xs')}>
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
          100%
        </span>
        <span data-slot="host-load-value" className="col-start-1 row-start-1">
          {percent}%
        </span>
      </span>
    </span>
  );
}

function MetricRow({
  metric,
  label,
  values,
  percent,
  tone,
}: {
  metric: keyof typeof CALM_TONES;
  label: string;
  values: readonly number[];
  percent: number;
  tone: HostLoadTone;
}) {
  const style = getStatusToneStyle(displayTone(metric, tone));
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 text-muted-foreground">{label}</span>
      <Sparkline values={values} width={120} tone={displayTone(metric, tone)} />
      <span className={cn('ml-auto font-semibold tabular-nums', style.text)}>{percent}%</span>
    </div>
  );
}

export interface HostLoadIndicatorViewProps {
  samples: readonly HostLoadSample[];
  /** Phones use smaller type and padding; the layout is the same. */
  compact: boolean;
  /** What is using the machine; `undefined` while it loads. */
  breakdown?: HostLoadBreakdown;
  breakdownFailed?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * A glance at whether the machine running Factory Factory is overloaded: CPU
 * and memory as a number beside a thin level bar each, on one line so the
 * header stays short. Graphs and the heaviest processes on click.
 */
export function HostLoadIndicatorView({
  samples,
  compact,
  breakdown,
  breakdownFailed = false,
  open,
  onOpenChange,
}: HostLoadIndicatorViewProps) {
  const summary = summarizeHostLoad(samples);
  const cpuValues = samples.map((sample) => sample.cpuPercent);
  const memoryValues = samples.map((sample) => sample.memoryPercent);
  const label = `Computer load: CPU ${summary.cpu.percent}%, memory ${summary.memory.percent}%`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          data-status-tone={summary.tone}
          // Tight padding: on a 320px phone the second header row has no
          // spare width, and on desktop the workspace name needs the room.
          className={cn(compact ? 'gap-1 px-0.5' : 'gap-1 px-1')}
        >
          <Readout metric="cpu" compact={compact} {...summary.cpu} />
          <Readout metric="memory" compact={compact} {...summary.memory} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={compact ? 'start' : 'end'} className="w-72 space-y-3 p-3 text-xs">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <p className="font-medium">Host computer</p>
            <p className="text-muted-foreground">Last 5 minutes</p>
          </div>
          <MetricRow metric="cpu" label="CPU" values={cpuValues} {...summary.cpu} />
          <MetricRow metric="memory" label="Memory" values={memoryValues} {...summary.memory} />
        </div>
        <HostLoadBreakdownView breakdown={breakdown} failed={breakdownFailed} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Polls only while the tab is visible; React Query pauses intervals in the
 * background. The process breakdown runs `ps`, so it is read only while open.
 */
export function HostLoadIndicator() {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const { data } = trpc.admin.getHostMetrics.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL_MS.localStatus,
  });
  const breakdown = trpc.admin.getHostLoadBreakdown.useQuery(undefined, {
    enabled: open,
    refetchInterval: POLL_INTERVAL_MS.localStatus,
  });
  if (!data || data.samples.length === 0) {
    return null;
  }
  return (
    <HostLoadIndicatorView
      samples={data.samples}
      compact={isMobile}
      breakdown={breakdown.data}
      // The poll keeps retrying while open, so a failure shows as a message, not forever loading.
      breakdownFailed={breakdown.isError}
      open={open}
      onOpenChange={setOpen}
    />
  );
}
