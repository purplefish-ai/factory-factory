import { describe, expect, it, vi } from 'vitest';
import {
  type CpuTimes,
  cpuPercentBetween,
  HostMetricsService,
  parseMemoryStatusLevel,
} from './host-metrics.service';

function createHarness() {
  let clock = 1_000_000;
  let cpu: CpuTimes = { idle: 0, total: 0 };
  let memoryPercent = 40;
  const readCpuTimes = vi.fn(() => cpu);
  const readMemoryPercent = vi.fn(() => Promise.resolve(memoryPercent));
  const sleep = vi.fn((ms: number) => {
    clock += ms;
    return Promise.resolve();
  });
  const service = new HostMetricsService({
    readCpuTimes,
    readMemoryPercent,
    now: () => clock,
    sleep,
  });
  return {
    service,
    readCpuTimes,
    readMemoryPercent,
    sleep,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Spend `busy` of the next `total` CPU ticks working. */
    burnCpu: (busy: number, total: number) => {
      cpu = { idle: cpu.idle + total - busy, total: cpu.total + total };
    },
    setMemory: (percent: number) => {
      memoryPercent = percent;
    },
  };
}

describe('cpuPercentBetween', () => {
  it('reports the busy share of ticks elapsed across all cores', () => {
    expect(cpuPercentBetween({ idle: 100, total: 200 }, { idle: 175, total: 300 })).toBe(25);
  });

  it('reports zero when no ticks elapsed', () => {
    expect(cpuPercentBetween({ idle: 5, total: 10 }, { idle: 5, total: 10 })).toBe(0);
  });
});

describe('parseMemoryStatusLevel', () => {
  it('turns the available-memory level into a used percentage', () => {
    expect(parseMemoryStatusLevel('80\n')).toBe(20);
  });

  it.each(['', 'abc', '-1', '101'])('rejects %j', (stdout) => {
    expect(parseMemoryStatusLevel(stdout)).toBeNull();
  });
});

describe('HostMetricsService', () => {
  it('primes CPU on a cold start so the first read already has a sample', async () => {
    const harness = createHarness();
    harness.sleep.mockImplementationOnce((ms) => {
      harness.advance(ms);
      harness.burnCpu(30, 100);
      return Promise.resolve();
    });

    const samples = await harness.service.getHistory();

    expect(harness.sleep).toHaveBeenCalledOnce();
    expect(samples).toEqual([expect.objectContaining({ cpuPercent: 30, memoryPercent: 40 })]);
  });

  it('measures each later sample against the previous one, without priming again', async () => {
    const harness = createHarness();
    await harness.service.getHistory();

    harness.advance(5000);
    harness.burnCpu(90, 100);
    harness.setMemory(70);
    const samples = await harness.service.getHistory();

    expect(harness.sleep).toHaveBeenCalledOnce();
    expect(samples.at(-1)).toEqual(expect.objectContaining({ cpuPercent: 90, memoryPercent: 70 }));
    expect(samples).toHaveLength(2);
  });

  it('serves a recent sample to every caller instead of sampling again', async () => {
    const harness = createHarness();
    await harness.service.getHistory();
    harness.advance(1000);

    const samples = await harness.service.getHistory();

    expect(samples).toHaveLength(1);
    expect(harness.readMemoryPercent).toHaveBeenCalledOnce();
  });

  it('shares one in-flight sample between concurrent callers', async () => {
    const harness = createHarness();

    const [first, second] = await Promise.all([
      harness.service.getHistory(),
      harness.service.getHistory(),
    ]);

    expect(first).toBe(second);
    expect(harness.readMemoryPercent).toHaveBeenCalledOnce();
  });

  it('keeps only the most recent five minutes', async () => {
    const harness = createHarness();
    for (let index = 0; index < 70; index += 1) {
      await harness.service.getHistory();
      harness.advance(5000);
    }

    const samples = await harness.service.getHistory();

    expect(samples).toHaveLength(60);
  });

  it('starts a fresh history after nobody has read it for a while', async () => {
    const harness = createHarness();
    await harness.service.getHistory();
    harness.advance(5000);
    await harness.service.getHistory();

    harness.advance(60_000);
    const samples = await harness.service.getHistory();

    expect(samples).toHaveLength(1);
    expect(harness.sleep).toHaveBeenCalledTimes(2);
  });
});
