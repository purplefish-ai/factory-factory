import { describe, expect, it, vi } from 'vitest';
import { deferred } from '@/test-utils/deferred';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import {
  createShutdownPlan,
  runShutdownPlan,
  type ShutdownFailure,
  type ShutdownGraph,
  type ShutdownPlan,
} from './application-shutdown';

const graph = unsafeCoerce<ShutdownGraph>({ services: {}, lifecycle: {} });

describe('createShutdownPlan', () => {
  it('waits on every job drain before the database disconnects', () => {
    const { jobs, steps } = createShutdownPlan(graph);
    const database = steps.findIndex((step) => step.name === 'database');
    expect(database).toBe(steps.length - 1);
    const awaited = steps.slice(0, database).flatMap((step) => step.after ?? []);
    expect(new Set(awaited)).toEqual(new Set(jobs.map((job) => job.name)));
  });

  it('keeps sessions before accounts and drains before their dependants', () => {
    const names = createShutdownPlan(graph).steps.map((step) => step.name);
    expect(names.indexOf('agent-runtime')).toBe(0);
    expect(names.indexOf('transports')).toBeLessThan(names.indexOf('sessions'));
    expect(names.indexOf('sessions')).toBeLessThan(names.indexOf('codex-accounts'));
    expect(names.indexOf('event-collector')).toBeLessThan(names.indexOf('workspace-git-state'));
    expect(names.indexOf('job-runner')).toBe(names.indexOf('database') - 1);
  });
});

describe('runShutdownPlan', () => {
  it('signals every job before the first step and holds a step until its drains settle', async () => {
    const calls: string[] = [];
    const drain = deferred<undefined>();
    const plan: ShutdownPlan = {
      jobs: [
        { name: 'a', stop: () => void calls.push('job a') },
        {
          name: 'b',
          stop: () => {
            calls.push('job b');
            return drain.promise;
          },
        },
      ],
      steps: [
        { name: 'first', stop: () => void calls.push('first') },
        { name: 'needs-b', after: ['b'], stop: () => void calls.push('needs-b') },
      ],
    };
    const running = runShutdownPlan(plan, vi.fn());
    expect(calls).toEqual(['job a', 'job b', 'first']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).not.toContain('needs-b');
    drain.resolve(undefined);
    await running;
    expect(calls).toEqual(['job a', 'job b', 'first', 'needs-b']);
  });

  it('reports each failure and still attempts every later job and step', async () => {
    const jobFailure = new Error('job failed');
    const stepFailure = new Error('step failed');
    const failures: ShutdownFailure[] = [];
    const last = vi.fn();
    await runShutdownPlan(
      {
        jobs: [
          {
            name: 'throws',
            stop: () => {
              throw jobFailure;
            },
          },
        ],
        steps: [
          { name: 'rejects', after: ['throws'], stop: () => Promise.reject(stepFailure) },
          { name: 'last', stop: last },
        ],
      },
      (failure) => failures.push(failure)
    );
    expect(failures).toEqual([
      { kind: 'job', name: 'throws', error: jobFailure },
      { kind: 'step', name: 'rejects', error: stepFailure },
    ]);
    expect(last).toHaveBeenCalledOnce();
  });
});
