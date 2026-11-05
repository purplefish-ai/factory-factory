import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MAX_RECORDED_DURATION_MS, validateReports } from '../.github/coverage-merge/timings';
import { readDurationHistory } from './coverage-sequencer';
import CoverageTimingReporter from './coverage-timing-reporter';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ff-coverage-reporter-'));
  directories.push(root);
  const results = join(root, '.vitest/results');
  mkdirSync(results, { recursive: true });
  const all = ['isolated:first.test.ts', 'isolated:second.test.ts'];
  for (const index of [1, 2]) {
    writeFileSync(
      join(results, `plan-${index}.json`),
      JSON.stringify({ all, assigned: [all[index - 1]] })
    );
  }
  const reporter = (index: number) => {
    const instance = new CoverageTimingReporter();
    instance.onInit({ config: { root, shard: { index, count: 2 } } });
    return instance;
  };
  const module = (
    name = 'first',
    state: 'passed' | 'failed' | 'skipped' = 'passed',
    duration = 5
  ) => ({
    moduleId: join(root, `${name}.test.ts`),
    project: { name: 'isolated' },
    state: () => state,
    diagnostic: () => ({
      environmentSetupDuration: 1,
      prepareDuration: 2,
      collectDuration: 3,
      setupDuration: 4,
      duration,
    }),
  });
  const read = (index: number): unknown =>
    JSON.parse(readFileSync(join(results, `timings-${index}.json`), 'utf8'));
  reporter(2).onTestRunEnd([module('second')], [], 'passed');
  return { root, results, reporter, module, read };
}

describe('coverage timing reporter contract', () => {
  it('writes portable identities and complete measured diagnostics accepted by the gate', () => {
    const input = fixture();
    input.reporter(1).onTestRunEnd([input.module()], [], 'passed');
    expect(validateReports([input.read(1), input.read(2)])).toEqual({
      'isolated:first.test.ts': 15,
      'isolated:second.test.ts': 15,
    });
  });

  it('caps an outlier before serialization without rejecting a successful run', () => {
    const input = fixture();
    input
      .reporter(1)
      .onTestRunEnd([input.module('first', 'passed', MAX_RECORDED_DURATION_MS * 2)], [], 'passed');
    expect(validateReports([input.read(1), input.read(2)])['isolated:first.test.ts']).toBe(
      MAX_RECORDED_DURATION_MS
    );
  });

  it.each([
    ['failed', 'passed', false],
    ['interrupted', 'passed', false],
    ['passed', 'failed', false],
    ['passed', 'passed', true],
  ] as const)(
    'records an unsuccessful %s/%s/errors=%s run that the gate rejects',
    (reason, state, errors) => {
      const input = fixture();
      input
        .reporter(1)
        .onTestRunEnd(
          [input.module('first', state)],
          errors ? [new Error('unhandled')] : [],
          reason
        );
      expect(z.object({ passed: z.boolean() }).parse(input.read(1)).passed).toBe(false);
      expect(() => validateReports([input.read(1), input.read(2)])).toThrow();
    }
  );

  it('retains skipped module identities and gives zero diagnostic totals a valid estimate', () => {
    const input = fixture();
    const module = {
      ...input.module('first', 'skipped'),
      diagnostic: () => ({
        environmentSetupDuration: 0,
        prepareDuration: 0,
        collectDuration: 0,
        setupDuration: 0,
        duration: 0,
      }),
    };
    input.reporter(1).onTestRunEnd([module], [], 'passed');
    expect(validateReports([input.read(1), input.read(2)])['isolated:first.test.ts']).toBe(1);
  });

  it('rejects a malformed plan instead of writing a passing report', () => {
    const input = fixture();
    writeFileSync(join(input.results, 'plan-1.json'), '{"all":"invalid","assigned":[]}');
    expect(() => input.reporter(1).onTestRunEnd([input.module()], [], 'passed')).toThrow();
  });
});

describe('optional duration history I/O', () => {
  it('quietly handles a cold cache and malformed history', async () => {
    const input = fixture();
    const warning = vi.fn();
    const file = join(input.root, 'history.json');
    expect(await readDurationHistory(file, warning)).toEqual({});
    writeFileSync(file, '{');
    expect(await readDurationHistory(file, warning)).toEqual({});
    expect(warning).not.toHaveBeenCalled();
  });

  it('makes unexpected read failures observable while retaining deterministic fallback', async () => {
    const input = fixture();
    const warning = vi.fn();
    expect(await readDurationHistory(input.results, warning)).toEqual({});
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Cannot read duration history; using deterministic estimates')
    );
  });
});
