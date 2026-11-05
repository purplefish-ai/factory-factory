import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { balanceTests, parseHistory, validateReports } from '../.github/coverage-merge/timings';

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
  });
});
