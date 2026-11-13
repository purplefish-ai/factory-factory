import { StatusDot } from '@/client/components/status-indicators';
import { POLL_INTERVAL_MS } from '@/client/lib/query-options';
import { getStatusToneStyle } from '@/client/lib/status-tones';
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

const SPARK_HEIGHT = 14;

function Sparkline({
  values,
  width,
  tone,
}: {
  values: readonly number[];
  width: number;
  tone: HostLoadTone;
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

function MetricRow({
  label,
  values,
  percent,
  tone,
}: {
  label: string;
  values: readonly number[];
  percent: number;
  tone: HostLoadTone;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 text-muted-foreground">{label}</span>
      <Sparkline values={values} width={120} tone={tone} />
      <span
        className={cn('ml-auto tabular-nums', tone !== 'neutral' && getStatusToneStyle(tone).text)}
      >
        {percent}%
      </span>
    </div>
  );
}

export interface HostLoadIndicatorViewProps {
  samples: readonly HostLoadSample[];
  /** Phones get a single status light; the graphs move into the popover. */
  compact: boolean;
}

/**
 * A glance at whether the machine running Factory Factory is overloaded: two
 * tiny graphs on desktop, one status light on phones, numbers on tap.
 */
export function HostLoadIndicatorView({ samples, compact }: HostLoadIndicatorViewProps) {
  const summary = summarizeHostLoad(samples);
  const cpuValues = samples.map((sample) => sample.cpuPercent);
  const memoryValues = samples.map((sample) => sample.memoryPercent);
  const label = `Computer load: CPU ${summary.cpu.percent}%, memory ${summary.memory.percent}%`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? 'icon-sm' : 'sm'}
          aria-label={label}
          className={cn(!compact && 'px-1.5')}
        >
          {compact ? (
            <StatusDot tone={summary.tone} />
          ) : (
            <>
              <Sparkline values={cpuValues} width={32} tone={summary.cpu.tone} />
              <Sparkline values={memoryValues} width={32} tone={summary.memory.tone} />
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2 p-3 text-xs">
        <p className="font-medium">Host computer</p>
        <MetricRow label="CPU" values={cpuValues} {...summary.cpu} />
        <MetricRow label="Memory" values={memoryValues} {...summary.memory} />
      </PopoverContent>
    </Popover>
  );
}

/** Polls only while the tab is visible; React Query pauses intervals in the background. */
export function HostLoadIndicator() {
  const isMobile = useIsMobile();
  const { data } = trpc.admin.getHostMetrics.useQuery(undefined, {
    refetchInterval: POLL_INTERVAL_MS.localStatus,
  });
  if (!data || data.samples.length === 0) {
    return null;
  }
  return <HostLoadIndicatorView samples={data.samples} compact={isMobile} />;
}
