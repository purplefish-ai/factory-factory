import { afterEach, expect, it, vi } from 'vitest';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createAgentRuntimeLifecycle as createAgentRuntime } from './agent-runtime.orchestrator';

afterEach(async () => {
  await jobRunner.stopAll();
  jobRunner.reset();
  vi.useRealTimers();
});
it('aborts and drains intake on stop, then restarts with a fresh signal', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const runtime = createAgentRuntime({
    pollCycle: async (signal) => {
      signals.push(signal);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  });
  runtime.start();
  expect(signals).toHaveLength(1);
  await runtime.stop();
  expect(signals[0]?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(signals).toHaveLength(1);
  runtime.start();
  expect(signals).toHaveLength(2);
  expect(signals[1]?.aborted).toBe(false);
  await runtime.stop();
});

it('paces completed source polls at sixty seconds without overlap', async () => {
  vi.useFakeTimers();
  const pollCycle = vi.fn(async () => undefined);
  const runtime = createAgentRuntime({ pollCycle });
  runtime.start();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(pollCycle).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(pollCycle).toHaveBeenCalledTimes(2);
  await runtime.stop();
});

it('runs evaluation and maintenance every five seconds without claiming when no launcher is wired', async () => {
  vi.useFakeTimers();
  const evaluations: number[] = [];
  const maintenance: number[] = [];
  const startedAt = Date.now();
  const claimNextRun = vi.fn(async () => ({
    status: 'DEFERRED' as const,
    reason: 'EMPTY' as const,
  }));
  const runtime = createAgentRuntime(
    { pollCycle: async () => undefined },
    {
      evaluatePendingEvents: () => {
        evaluations.push(Date.now());
        return Promise.resolve();
      },
      maintainQueue: () => {
        maintenance.push(Date.now());
        return Promise.resolve();
      },
      claimNextRun,
    }
  );
  runtime.start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(evaluations).toEqual([startedAt, startedAt + 5000, startedAt + 10_000]);
  expect(maintenance).toEqual([startedAt, startedAt + 5000, startedAt + 10_000]);
  await runtime.stop();
  expect(claimNextRun).not.toHaveBeenCalled();
});
it('hands a committed claim to its consumer and drains it during shutdown', async () => {
  vi.useFakeTimers();
  let received = false;
  let finished = false;
  let release = () => {
    /* assigned when the consumer starts */
  };
  const runtime = createAgentRuntime(
    { pollCycle: async () => undefined },
    {
      evaluatePendingEvents: async () => undefined,
      maintainQueue: async () => undefined,
      claimNextRun: async () => ({
        status: 'CLAIMED',
        runId: 'run',
        workerGeneration: 1,
        attemptGeneration: 1,
        reservedWorkspaceId: 'workspace',
        reservedSessionId: 'session',
        initialMessageId: 'message',
      }),
      consumeClaim: async (claim) => {
        expect(claim.runId).toBe('run');
        received = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        finished = true;
      },
    }
  );
  runtime.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(received).toBe(true);
  const stopping = runtime.stop();
  expect(finished).toBe(false);
  release();
  await stopping;
  expect(finished).toBe(true);
});
