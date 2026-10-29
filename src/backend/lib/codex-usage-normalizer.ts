import { z } from 'zod';
import type { ProviderPlanUsage } from '@/shared/provider-usage';
type PlanUsageReading = {
  status: 'available' | 'unavailable';
  windows: ProviderPlanUsage['windows'];
};
const percent = z.number().finite().min(0).max(100);
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
  normalModelSlug: z.string().nullish(),
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

export function codexQuotaModelScopes(value: unknown): Record<string, string | null> {
  const data = codexUsage.parse(value);
  const buckets = Object.entries(data.rateLimitsByLimitId ?? {});
  if (!buckets.length && data.rateLimits) {
    buckets.push([data.rateLimits.limitId ?? 'codex', data.rateLimits]);
  }
  return Object.fromEntries(
    buckets.flatMap(([id, bucket]) =>
      (['primary', 'secondary'] as const).map((slot) => [
        `${id}:${slot}`,
        bucket.normalModelSlug ?? null,
      ])
    )
  );
}
