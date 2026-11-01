import { afterEach, expect, it, vi } from 'vitest';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createAgentRuntime } from './agent-runtime.orchestrator';

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
