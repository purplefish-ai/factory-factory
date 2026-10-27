import { z } from 'zod';

export type PlanUsageReading = {
  status: 'available' | 'unavailable';
  windows: Array<{ id: string; label: string; usedPercent: number; resetsAt: number | null }>;
};
const percent = z.number().finite().min(0).max(100);
const claudeWindow = z
  .object({
    utilization: percent.nullable(),
    resets_at: z.string().datetime({ offset: true }).nullable(),
  })
  .nullish();
const claudeUsage = z.object({
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: claudeWindow,
      seven_day: claudeWindow,
      seven_day_oauth_apps: claudeWindow,
      seven_day_opus: claudeWindow,
      seven_day_sonnet: claudeWindow,
      model_scoped: z
        .array(
          z.object({
            display_name: z.string(),
            utilization: percent.nullable(),
            resets_at: z.string().datetime({ offset: true }).nullable(),
          })
        )
        .optional(),
    })
    .nullable(),
});
const codexWindow = z
  .object({
    usedPercent: percent,
    windowDurationMins: z.number().finite().positive().nullish(),
    resetsAt: z.number().finite().nonnegative().nullish(),
  })
  .nullish();
const codexBucket = z.object({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  primary: codexWindow,
  secondary: codexWindow,
});
const codexUsage = z.object({
  rateLimits: codexBucket.nullish(),
  rateLimitsByLimitId: z.record(z.string(), codexBucket).nullish(),
});

function reading(windows: PlanUsageReading['windows']): PlanUsageReading {
  return { status: windows.length ? 'available' : 'unavailable', windows };
}

export function normalizeClaudePlanUsage(value: unknown): PlanUsageReading {
  const data = claudeUsage.parse(value);
  if (!(data.rate_limits_available && data.rate_limits)) {
    return reading([]);
  }
  const limits = data.rate_limits;
  const windows: PlanUsageReading['windows'] = [];
  const append = (id: string, label: string, window: z.infer<typeof claudeWindow>) => {
    if (window?.utilization == null) {
      return;
    }
    windows.push({
      id,
      label,
      usedPercent: window.utilization,
      resetsAt: window.resets_at ? Date.parse(window.resets_at) / 1000 : null,
    });
  };
  append('five_hour', '5-hour window', limits.five_hour);
  append('seven_day', 'Weekly', limits.seven_day);
  append('seven_day_oauth_apps', 'Weekly · OAuth apps', limits.seven_day_oauth_apps);
  if (limits.model_scoped?.length) {
    limits.model_scoped.forEach((window, index) =>
      append(`model_${index}`, `Weekly · ${window.display_name}`, window)
    );
  } else {
    append('seven_day_opus', 'Weekly · Opus', limits.seven_day_opus);
    append('seven_day_sonnet', 'Weekly · Sonnet', limits.seven_day_sonnet);
  }
  return reading(windows);
}

function windowLabel(minutes: number | null | undefined): string {
  if (minutes == null) {
    return 'Usage window';
  }
  if (minutes === 10_080) {
    return 'Weekly';
  }
  if (minutes % 1440 === 0) {
    return `${minutes / 1440}-day window`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}-hour window`;
  }
  return `${minutes}-minute window`;
}

export function normalizeCodexPlanUsage(value: unknown): PlanUsageReading {
  const data = codexUsage.parse(value);
  const buckets = Object.entries(data.rateLimitsByLimitId ?? {});
  if (!buckets.length && data.rateLimits) {
    buckets.push([data.rateLimits.limitId ?? 'codex', data.rateLimits]);
  }
  return reading(buckets.flatMap(([id, bucket]) => codexWindows(id, bucket)));
}

function codexWindows(
  id: string,
  bucket: z.infer<typeof codexBucket>
): PlanUsageReading['windows'] {
  const name = bucket.limitName ?? (id === 'codex' ? null : id);
  return (['primary', 'secondary'] as const).flatMap((slot) => {
    const window = bucket[slot];
    if (!window) {
      return [];
    }
    const label = windowLabel(window.windowDurationMins);
    return [
      {
        id: `${id}:${slot}`,
        label: name ? `${name} · ${label}` : label,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt ?? null,
      },
    ];
  });
}
