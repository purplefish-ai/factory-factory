import { describe, expect, it } from 'vitest';
import { normalizeClaudePlanUsage, normalizeCodexPlanUsage } from './provider-usage-normalizer';

describe('provider plan usage normalization', () => {
  it('keeps Claude percentages and converts ISO reset timestamps to seconds', () => {
    expect(
      normalizeClaudePlanUsage({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 0, resets_at: '2026-10-28T00:00:00Z' },
          seven_day: { utilization: 42, resets_at: null },
          model_scoped: [{ display_name: 'Opus', utilization: 81, resets_at: null }],
        },
      })
    ).toEqual({
      status: 'available',
      windows: [
        { id: 'five_hour', label: '5-hour window', usedPercent: 0, resetsAt: 1_793_145_600 },
        { id: 'seven_day', label: 'Weekly', usedPercent: 42, resetsAt: null },
        { id: 'model_0', label: 'Weekly · Opus', usedPercent: 81, resetsAt: null },
      ],
    });
  });

  it('does not treat a missing Claude plan or utilization as zero', () => {
    expect(normalizeClaudePlanUsage({ rate_limits_available: false, rate_limits: null })).toEqual({
      status: 'unavailable',
      windows: [],
    });
    expect(
      normalizeClaudePlanUsage({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: null, resets_at: null },
          seven_day: null,
        },
      })
    ).toEqual({ status: 'unavailable', windows: [] });
  });

  it('retains all Codex buckets and derives labels from actual window durations', () => {
    expect(
      normalizeCodexPlanUsage({
        rateLimits: { primary: { usedPercent: 99 } },
        rateLimitsByLimitId: {
          codex: {
            limitName: null,
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_793_145_600 },
            secondary: { usedPercent: 51, windowDurationMins: 10_080, resetsAt: null },
          },
          review: {
            limitName: 'Reviews',
            primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: null },
          },
        },
      })
    ).toEqual({
      status: 'available',
      windows: [
        { id: 'codex:primary', label: '5-hour window', usedPercent: 25, resetsAt: 1_793_145_600 },
        { id: 'codex:secondary', label: 'Weekly', usedPercent: 51, resetsAt: null },
        { id: 'review:primary', label: 'Reviews · 1-hour window', usedPercent: 10, resetsAt: null },
      ],
    });
  });

  it('supports the legacy Codex bucket without inventing missing windows', () => {
    expect(
      normalizeCodexPlanUsage({
        rateLimits: {
          primary: { usedPercent: 33, windowDurationMins: null, resetsAt: null },
          secondary: null,
        },
      })
    ).toEqual({
      status: 'available',
      windows: [{ id: 'codex:primary', label: 'Usage window', usedPercent: 33, resetsAt: null }],
    });
    expect(normalizeCodexPlanUsage({ rateLimits: { primary: null, secondary: null } })).toEqual({
      status: 'unavailable',
      windows: [],
    });
  });

  it.each([Number.NaN, -1, 101])('rejects invalid provider percentages (%s)', (usedPercent) => {
    expect(() => normalizeCodexPlanUsage({ rateLimits: { primary: { usedPercent } } })).toThrow();
    expect(() =>
      normalizeClaudePlanUsage({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: usedPercent, resets_at: null },
        },
      })
    ).toThrow();
  });
});
