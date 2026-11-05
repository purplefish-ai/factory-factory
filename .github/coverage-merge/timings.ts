import { z } from 'zod';

export const TIMING_FORMAT_VERSION = 1;
export const MAX_RECORDED_DURATION_MS = 3_600_000;
const duration = z.number().finite().positive().max(MAX_RECORDED_DURATION_MS);
const historySchema = z.object({
  version: z.literal(TIMING_FORMAT_VERSION),
  durations: z.record(z.string(), duration),
});
const reportSchema = z.object({
  version: z.literal(TIMING_FORMAT_VERSION),
  shard: z.union([z.literal(1), z.literal(2)]),
  all: z.array(z.string()),
  assigned: z.array(z.string()),
  passed: z.literal(true),
  tests: z.array(z.object({ id: z.string(), duration })),
});

export function createHistorySnapshot(durations: Record<string, number>) {
  return historySchema.parse({ version: TIMING_FORMAT_VERSION, durations });
}

export function parseHistory(raw: string): Record<string, number> {
  try {
    return historySchema.parse(JSON.parse(raw)).durations;
  } catch {
    return {};
  }
}

function unique(ids: string[]): Set<string> {
  const result = new Set(ids);
  if (result.size !== ids.length) {
    throw new Error('Duplicate test assignment or result');
  }
  return result;
}

function sameTests(expected: string[], actual: string[]): void {
  const a = unique(expected);
  const b = unique(actual);
  if (a.size !== b.size || [...a].some((id) => !b.has(id))) {
    throw new Error('Incomplete or inconsistent test assignment/results');
  }
}

export function balanceTests(ids: string[], history: Record<string, number>): [string[], string[]] {
  unique(ids);
  // New tests use the median of their project's known files. Without history,
  // equal estimates give a deterministic alternating assignment by test id.
  const estimates = new Map<string, number>();
  for (const id of ids) {
    const project = id.split(':')[0] ?? '';
    if (estimates.has(project)) {
      continue;
    }
    const values = ids
      .filter((other) => other.split(':')[0] === project)
      .map((other) => history[other])
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const upper = values[middle];
    const median =
      upper === undefined
        ? 1000
        : values.length % 2 === 0
          ? ((values[middle - 1] ?? upper) + upper) / 2
          : upper;
    estimates.set(project, median);
  }
  const weight = (id: string) => history[id] ?? estimates.get(id.split(':')[0] ?? '') ?? 1000;
  const sorted = [...ids].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards: [string[], string[]] = [[], []];
  const totals: [number, number] = [0, 0];
  for (const id of sorted) {
    const index = totals[0] <= totals[1] ? 0 : 1;
    shards[index].push(id);
    totals[index] += weight(id);
  }
  return shards;
}

export function validateReports(input: unknown): Record<string, number> {
  const reports = z.tuple([reportSchema, reportSchema]).parse(input);
  if (reports[0].shard === reports[1].shard) {
    throw new Error('Require both shard reports');
  }
  sameTests(reports[0].all, reports[1].all);
  sameTests(
    reports[0].all,
    reports.flatMap((report) => report.assigned)
  );
  for (const report of reports) {
    sameTests(
      report.assigned,
      report.tests.map((test) => test.id)
    );
  }
  if (!reports[0].all.length) {
    throw new Error('No tests discovered');
  }
  return Object.fromEntries(
    reports.flatMap((report) => report.tests.map((test) => [test.id, test.duration]))
  );
}
