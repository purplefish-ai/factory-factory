import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { TokenStats } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import type { ProviderPlanUsage, UsageProvider } from '@/shared/provider-usage';
import { getUsageColorClass } from './usage-stats-utils';

export interface UsageControlProps {
  tokenStats?: TokenStats;
  planUsage?: ProviderPlanUsage;
  busy?: boolean;
  compacting?: boolean;
  disabled?: boolean;
  refreshing?: boolean;
  error?: boolean;
  onCompact?: () => void;
  onRefresh: () => void;
  onOpenChange?: (open: boolean) => void;
}

function usageColor(percent: number | null) {
  return getUsageColorClass(percent, 'text-amber-600 dark:text-amber-400');
}

function timestamp(value: number | string) {
  return new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function getPlanWindows(planUsage: ProviderPlanUsage | undefined) {
  return planUsage?.status === 'available' ? planUsage.windows : [];
}

function getContextUsage(tokenStats: TokenStats | undefined) {
  const used = tokenStats?.contextUsedTokens;
  const capacity = tokenStats?.contextWindow;
  if (
    used == null ||
    !Number.isFinite(used) ||
    used < 0 ||
    capacity == null ||
    !Number.isFinite(capacity) ||
    capacity <= 0
  ) {
    return null;
  }
  return { used, capacity, percent: Math.min((used / capacity) * 100, 100) };
}

function canCompact(
  context: ReturnType<typeof getContextUsage>,
  onCompact: UsageControlProps['onCompact']
) {
  return Boolean(context && onCompact);
}

export function UsageControl({
  tokenStats,
  planUsage,
  busy,
  compacting,
  disabled,
  refreshing,
  error,
  onCompact,
  onRefresh,
  onOpenChange,
}: UsageControlProps) {
  const context = getContextUsage(tokenStats);
  const percent = context?.percent ?? null;
  const windows = getPlanWindows(planUsage);
  const planWarning = windows.some((window) => window.usedPercent >= 80);
  const label = `Usage${percent === null ? '' : `: ${Math.round(percent)}% context`}${planWarning ? ', plan limit nearly reached' : ''}`;

  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          aria-busy={compacting}
          className={cn('h-7 shrink-0 gap-1.5 px-1.5 text-xs tabular-nums', usageColor(percent))}
        >
          {compacting ? (
            <SpinnerGapIcon className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <svg
              aria-hidden="true"
              width="14"
              height="14"
              viewBox="0 0 16 16"
              className="-rotate-90"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="opacity-20"
              />
              {percent !== null && (
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  pathLength="100"
                  strokeDasharray={`${percent} 100`}
                  strokeLinecap="round"
                />
              )}
            </svg>
          )}
          <span>{percent === null ? 'Usage' : `${Math.round(percent)}%`}</span>
          {planWarning && <span aria-hidden="true" className="h-1 w-1 rounded-full bg-amber-500" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[calc(100vw-24px)] space-y-4 overflow-y-auto p-4 text-xs"
      >
        <div>
          <p className="mb-2 font-medium">Context</p>
          {context ? (
            <>
              <div className="mb-2 flex justify-between gap-2 text-muted-foreground">
                <span>
                  {context.used.toLocaleString()} / {context.capacity.toLocaleString()} tokens
                </span>
                <span>{Math.round(percent ?? 0)}% used</span>
              </div>
              <UsageMeter percent={percent ?? 0} />
            </>
          ) : (
            <p className="text-muted-foreground">Context unavailable</p>
          )}
          {compacting && (
            <p role="status" className="mt-2 text-muted-foreground">
              Compacting context…
            </p>
          )}
        </div>
        <div className="space-y-3 border-t pt-3">
          <p className="font-medium">Plan limits</p>
          <PlanWindows
            planUsage={planUsage}
            windows={windows}
            error={error}
            refreshing={refreshing}
          />
        </div>
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {planUsage ? `Updated ${timestamp(planUsage.updatedAt)}` : 'No reading yet'}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onCompact}
              disabled={!canCompact(context, onCompact) || busy || compacting || disabled}
            >
              {compacting ? 'Compacting…' : 'Compact'}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh usage"
              disabled={refreshing}
              onClick={onRefresh}
              className="h-6 w-6"
            >
              <ArrowClockwiseIcon className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PlanWindows({
  planUsage,
  windows,
  error,
  refreshing,
}: {
  planUsage?: ProviderPlanUsage;
  windows: ProviderPlanUsage['windows'];
  error?: boolean;
  refreshing?: boolean;
}) {
  return (
    <>
      {' '}
      {error ? (
        <p className="text-muted-foreground">Unable to refresh plan limits. Try again.</p>
      ) : windows.length > 0 ? (
        windows.map((window) => (
          <div key={window.id} className="space-y-1.5">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">{window.label}</span>
              <span className={usageColor(window.usedPercent)}>
                {Math.round(window.usedPercent)}% used
              </span>
            </div>
            <UsageMeter percent={window.usedPercent} />
            <p className="text-[11px] text-muted-foreground">
              {window.resetsAt === null
                ? 'Reset time unavailable'
                : `Resets ${timestamp(window.resetsAt)}`}
            </p>
          </div>
        ))
      ) : (
        <p className="text-muted-foreground">
          {planUsage?.message ?? (refreshing ? 'Loading plan limits…' : 'Plan limits unavailable')}
        </p>
      )}
    </>
  );
}

function UsageMeter({ percent }: { percent: number }) {
  return (
    <div className="h-1 overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full bg-current', usageColor(percent))}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

interface ProviderUsageControlProps extends Omit<
  UsageControlProps,
  'planUsage' | 'refreshing' | 'error' | 'onRefresh' | 'onOpenChange'
> {
  provider: UsageProvider;
  codexAccountId?: string | null;
}

/** Read account limits once, on completion, and only poll while details are open. */
export function ProviderUsageControl({
  provider,
  codexAccountId,
  ...props
}: ProviderUsageControlProps) {
  const [open, setOpen] = useState(false);
  const query = trpc.session.getProviderUsage.useQuery(
    { provider, ...(provider === 'CODEX' && codexAccountId ? { codexAccountId } : {}) },
    {
      staleTime: 30_000,
      refetchInterval: open ? 30_000 : false,
      refetchOnWindowFocus: false,
    }
  );
  const wasBusy = useRef(Boolean(props.busy || props.compacting));
  const { refetch } = query;
  useEffect(() => {
    const busy = Boolean(props.busy || props.compacting);
    if (wasBusy.current && !busy) {
      void refetch();
    }
    wasBusy.current = busy;
  }, [props.busy, props.compacting, refetch]);

  return (
    <UsageControl
      {...props}
      planUsage={query.data}
      refreshing={query.isFetching}
      error={query.isError}
      onRefresh={() => {
        void refetch();
      }}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          void refetch();
        }
      }}
    />
  );
}
