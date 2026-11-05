import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModuleDiagnostic, Reporter, TestModule, TestRunEndReason, Vitest } from 'vitest/node';
import { z } from 'zod';
import { MAX_RECORDED_DURATION_MS, TIMING_FORMAT_VERSION } from '../.github/coverage-merge/timings';
import { testId } from './coverage-sequencer';

type TimingContext = { config: Pick<Vitest['config'], 'root' | 'shard'> };
type TimingModule = Pick<TestModule, 'moduleId' | 'state'> & {
  project: { name: string };
  diagnostic(): Pick<
    ModuleDiagnostic,
    | 'environmentSetupDuration'
    | 'prepareDuration'
    | 'collectDuration'
    | 'setupDuration'
    | 'duration'
  >;
};

export default class CoverageTimingReporter implements Reporter {
  private context: TimingContext | undefined;

  onInit(context: TimingContext): void {
    this.context = context;
  }

  onTestRunEnd(
    modules: readonly TimingModule[],
    errors: readonly unknown[],
    reason: TestRunEndReason
  ): void {
    if (!this.context) {
      throw new Error('Reporter was not initialized');
    }
    const { root, shard } = this.context.config;
    if (shard?.count !== 2) {
      throw new Error('Coverage CI requires exactly two shards');
    }
    const plan = z
      .object({ all: z.array(z.string()), assigned: z.array(z.string()) })
      .parse(
        JSON.parse(
          readFileSync(path.join(root, `.vitest/results/plan-${shard.index}.json`), 'utf8')
        )
      );
    const tests = modules.map((module) => {
      const diagnostic = module.diagnostic();
      return {
        id: testId(root, module.project.name, module.moduleId),
        duration: Math.min(
          MAX_RECORDED_DURATION_MS,
          Math.max(
            1,
            diagnostic.environmentSetupDuration +
              diagnostic.prepareDuration +
              diagnostic.collectDuration +
              diagnostic.setupDuration +
              diagnostic.duration
          )
        ),
      };
    });
    writeFileSync(
      path.join(root, `.vitest/results/timings-${shard.index}.json`),
      JSON.stringify({
        version: TIMING_FORMAT_VERSION,
        shard: shard.index,
        ...plan,
        passed:
          reason === 'passed' &&
          errors.length === 0 &&
          modules.every((module) => module.state() !== 'failed'),
        tests,
      })
    );
  }
}
