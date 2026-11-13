export type Distribution = { count: number; median: number | null; p90: number | null };

/** Linear interpolation between closest ranks (the common spreadsheet definition). */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

export function distribution(values: readonly number[], decimals: number): Distribution {
  const round = (value: number | null) => (value === null ? null : Number(value.toFixed(decimals)));
  return {
    count: values.length,
    median: round(percentile(values, 0.5)),
    p90: round(percentile(values, 0.9)),
  };
}

export function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Number((part / whole).toFixed(4));
}

export type TimeWindow = { from: string | null; to: string | null };

export function timeWindow(stamps: readonly string[]): TimeWindow {
  const sorted = stamps.toSorted((left, right) => Date.parse(left) - Date.parse(right));
  return { from: sorted[0] ?? null, to: sorted.at(-1) ?? null };
}
