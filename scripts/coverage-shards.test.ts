import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  balanceTests,
  createHistorySnapshot,
  parseHistory,
  validateReports,
} from '../.github/coverage-merge/timings';

const ids = ['isolated:a', 'isolated:b', 'frontend:c', 'shared:d', 'isolated:new'];
const history = { 'isolated:a': 100, 'isolated:b': 90, 'frontend:c': 30, 'shared:d': 20 };

function reports() {
  const assignments = balanceTests(ids, history);
  const report = (assigned: string[], shard: 1 | 2) => ({
    version: 1,
    shard,
    all: ids,
    assigned,
    passed: true,
    tests: assigned.map((id) => ({ id, duration: history[id as keyof typeof history] ?? 50 })),
  });
  return [report(assignments[0], 1), report(assignments[1], 2)] as const;
}

describe('coverage shard assignment', () => {
  it('balances measured durations and assigns every file exactly once', () => {
    const assigned = balanceTests(['a', 'b', 'c', 'd'], { a: 90, b: 80, c: 20, d: 10 });
    expect(assigned).toEqual([
      ['a', 'd'],
      ['b', 'c'],
    ]);
    expect(new Set(assigned.flat()).size).toBe(4);
  });

  it('is deterministic across discovery order with missing/new-file durations', () => {
    expect(balanceTests(ids, history)).toEqual(balanceTests([...ids].reverse(), history));
    expect(balanceTests(ids, {})).toEqual(balanceTests([...ids].reverse(), {}));
    expect(balanceTests(ids, history).flat().sort()).toEqual([...ids].sort());
  });

  it('estimates new files using the ordinary even and odd project medians', () => {
    const even = { 'p:a': 10, 'p:b': 10, 'p:c': 20, 'p:d': 40 };
    const selected = [...Object.keys(even), 'p:new'];
    expect(balanceTests(selected, even)).toEqual([
      ['p:d', 'p:b'],
      ['p:c', 'p:new', 'p:a'],
    ]);
    const odd = { 'p:a': 10, 'p:b': 30, 'p:c': 70 };
    const oddIds = [...Object.keys(odd), 'p:new'];
    expect(balanceTests(oddIds, odd)).toEqual(balanceTests(oddIds, { ...odd, 'p:new': 30 }));
  });

  it('round trips snapshots through the shared history schema', () => {
    const durations = { 'p:test.ts': 12.5 };
    expect(parseHistory(JSON.stringify(createHistorySnapshot(durations)))).toEqual(durations);
  });

  it('rejects duplicate discovered tests', () => {
    expect(() => balanceTests(['a', 'a'], {})).toThrow(/duplicate/i);
  });

  it.each(['{}', '{', '{"version":1,"durations":{"a":-1}}', '{"version":1,"durations":{"a":"2"}}'])(
    'falls back on invalid history %s',
    (raw) => {
      expect(parseHistory(raw)).toEqual({});
    }
  );

  it('accepts finite positive measurements only', () => {
    expect(parseHistory('{"version":1,"durations":{"a":12.5}}')).toEqual({ a: 12.5 });
    expect(parseHistory('{"version":1,"durations":{"a":1e999}}')).toEqual({});
  });
});

describe('coverage report completeness', () => {
  it('merges complete unique successful measurements', () => {
    expect(Object.keys(validateReports(reports())).sort()).toEqual([...ids].sort());
  });

  it('rejects a missing shard and duplicate shard', () => {
    const input = reports();
    expect(() => validateReports(input.slice(0, 1))).toThrow();
    expect(() => validateReports([input[0], input[0]])).toThrow();
  });

  it('rejects missing, extra and duplicate test results', () => {
    for (const mutate of [
      (tests: { id: string; duration: number }[]) => tests.slice(1),
      (tests: { id: string; duration: number }[]) => [...tests, { id: 'extra', duration: 1 }],
      (tests: { id: string; duration: number }[]) => tests.flatMap((test) => [test, test]),
    ]) {
      const input = reports();
      input[0].tests = mutate(input[0].tests);
      expect(() => validateReports(input)).toThrow();
    }
  });

  it('rejects divergent discovery, duplicate assignment and failed runs', () => {
    const divergent = reports();
    divergent[0].all = ids.slice(1);
    expect(() => validateReports(divergent)).toThrow();
    const duplicate = reports();
    duplicate[1].assigned.push('isolated:a');
    expect(() => validateReports(duplicate)).toThrow();
    const failed = reports();
    failed[1].passed = false;
    expect(() => validateReports(failed)).toThrow();
  });

  it('rejects malformed timing reports', () => {
    const input = reports();
    input[0].tests = [{ id: 'bad', duration: -1 }];
    expect(() => validateReports(input)).toThrow();
  });
});

describe('minimal coverage toolchain', () => {
  it('uses exactly the application Vitest and coverage versions', () => {
    const root = z
      .object({ devDependencies: z.record(z.string(), z.string()), packageManager: z.string() })
      .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
    const merge = z
      .object({ dependencies: z.record(z.string(), z.string()), packageManager: z.string() })
      .parse(
        JSON.parse(
          readFileSync(new URL('../.github/coverage-merge/package.json', import.meta.url), 'utf8')
        )
      );
    for (const name of ['vitest', '@vitest/coverage-v8']) {
      expect(merge.dependencies[name]).toBe(root.devDependencies[name]);
      expect(merge.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(merge.packageManager).toBe(root.packageManager);
    const policy = z.object({ minimumReleaseAge: z.number() });
    expect(
      policy.parse(parse(readFileSync('.github/coverage-merge/pnpm-workspace.yaml', 'utf8')))
        .minimumReleaseAge
    ).toBe(policy.parse(parse(readFileSync('pnpm-workspace.yaml', 'utf8'))).minimumReleaseAge);
  });
});

describe('coverage workflow safeguards', () => {
  const step = z.object({
    name: z.string().optional(),
    id: z.string().optional(),
    if: z.string().optional(),
    run: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  });
  const workflow = z
    .object({
      jobs: z.record(
        z.string(),
        z.object({
          outputs: z.record(z.string(), z.string()).optional(),
          steps: z.array(step).optional(),
        })
      ),
    })
    .parse(parse(readFileSync('.github/workflows/ci.yml', 'utf8')));

  it('uses one immutable history lookup for both shards and rejects a different restore', () => {
    const selection = workflow.jobs.changes;
    expect(selection?.outputs?.timings).toBe('${{ steps.timings.outputs.cache-matched-key }}');
    const lookup = selection?.steps?.find((entry) => entry.id === 'timings');
    expect(lookup?.with?.['lookup-only']).toBe(true);
    const shards = workflow.jobs['test-shards'];
    const restore = shards?.steps?.find((entry) => entry.id === 'shard-timings');
    expect(restore?.with?.key).toBe('${{ needs.changes.outputs.timings }}');
    expect(restore?.with?.['restore-keys']).toBeUndefined();
    expect(restore?.with?.['fail-on-cache-miss']).toBe(true);
    const exact = shards?.steps?.find(
      (entry) => entry.name === 'Require exact test duration snapshot'
    );
    expect(exact?.if).toBe(
      "needs.changes.outputs.timings != '' && steps.shard-timings.outputs.cache-matched-key != needs.changes.outputs.timings"
    );
    expect(exact?.run).toBe('exit 1');
  });

  it('fails the actual blob gate until both shard reports exist', () => {
    const gate = workflow.jobs.test?.steps?.find(
      (entry) => entry.name === 'Require both shard reports'
    );
    const command = z.string().parse(gate?.run);
    const directory = mkdtempSync(join(tmpdir(), 'ff-coverage-gate-'));
    const run = () => spawnSync('bash', ['-e', '-c', command], { cwd: directory }).status;
    try {
      mkdirSync(join(directory, '.vitest/blob'), { recursive: true });
      expect(run()).not.toBe(0);
      writeFileSync(join(directory, '.vitest/blob/blob-1-2.json'), '{}');
      expect(run()).not.toBe(0);
      writeFileSync(join(directory, '.vitest/blob/blob-2-2.json'), '{}');
      expect(run()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
