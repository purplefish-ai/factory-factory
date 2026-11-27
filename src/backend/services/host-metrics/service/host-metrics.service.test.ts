import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CpuTimes,
  cpuPercentBetween,
  HostMetricsService,
  readMemoryPercent,
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

const macVmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              900000.
Pages wired down:                        250000.
Pages purgeable:                          50000.
File-backed pages:                       950000.
Anonymous pages:                        2000000.
Pages stored in compressor:              400000.
Pages occupied by compressor:            100000.
`;

describe('readMemoryPercent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFreeMemory(free: number, total: number) {
    vi.spyOn(os, 'freemem').mockReturnValue(free);
    vi.spyOn(os, 'totalmem').mockReturnValue(total);
  }

  it.each(['linux', 'win32'] as const)(
    'uses free memory on %s without running vm_stat',
    async (platform) => {
      mockFreeMemory(25, 100);
      const readVmStat = vi.fn(async () => macVmStat);

      await expect(readMemoryPercent(platform, readVmStat)).resolves.toBe(75);
      expect(readVmStat).not.toHaveBeenCalled();
    }
  );

  it('reports physical memory used on macOS, excluding reclaimable pages', async () => {
    mockFreeMemory(900_000 * 16_384, 64 * 1024 ** 3);

    await expect(readMemoryPercent('darwin', async () => macVmStat)).resolves.toBe(55);
  });

  it('falls back to free memory on macOS when vm_stat fails', async () => {
    mockFreeMemory(40, 100);

    await expect(
      readMemoryPercent('darwin', () => Promise.reject(new Error('vm_stat missing')))
    ).resolves.toBe(60);
  });

  it.each([
    '94\n',
    macVmStat.replace('16384', '0'),
    macVmStat.replace('250000.', 'n/a'),
    macVmStat.replace(/^Anonymous pages:.*$/m, ''),
    macVmStat.replace(/^Pages purgeable:.*$/m, 'Pages purgeable: 3000000.'),
  ])('falls back to free memory on macOS when vm_stat output is invalid (%#)', async (stdout) => {
    mockFreeMemory(40, 100);

    await expect(readMemoryPercent('darwin', async () => stdout)).resolves.toBe(60);
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

  it('keeps only five minutes of samples when they are taken slowly', async () => {
    const harness = createHarness();
    for (let index = 0; index < 30; index += 1) {
      await harness.service.getHistory();
      harness.advance(15_000);
    }

    const samples = await harness.service.getHistory();

    expect(samples).toHaveLength(20);
    expect(samples.at(-1)!.at - samples[0]!.at).toBeLessThan(5 * 60_000);
  });

  it('starts a fresh history after nobody has read it for a while', async () => {
    const harness = createHarness();
    await harness.service.getHistory();
    harness.advance(5000);
    await harness.service.getHistory();

    harness.advance(60_000);
    // Busy while nobody watched; the fresh history must not average this in.
    harness.burnCpu(100, 1000);
    const samples = await harness.service.getHistory();

    expect(samples).toEqual([expect.objectContaining({ cpuPercent: 0 })]);
    expect(harness.sleep).toHaveBeenCalledTimes(2);
  });
});

describe('HostMetricsService.getHistoryAfter', () => {
  async function historyOfThree() {
    const harness = createHarness();
    for (let index = 0; index < 3; index += 1) {
      await harness.service.getHistory();
      harness.advance(5000);
    }
    return { harness, samples: await harness.service.getHistory() };
  }

  it('sends the whole window to a reader without a cursor', async () => {
    const { harness, samples } = await historyOfThree();

    await expect(harness.service.getHistoryAfter()).resolves.toEqual({
      samples,
      since: null,
      oldestAt: samples[0]!.at,
    });
  });

  it('sends only the samples taken after a cursor still in the window', async () => {
    const { harness, samples } = await historyOfThree();
    const cursor = samples[1]!.at;

    await expect(harness.service.getHistoryAfter(cursor)).resolves.toEqual({
      samples: samples.slice(2),
      since: cursor,
      oldestAt: samples[0]!.at,
    });
  });

  it('takes a due sample before answering, so each poll gets the new point', async () => {
    const { harness, samples } = await historyOfThree();
    harness.advance(5000);

    const history = await harness.service.getHistoryAfter(samples.at(-1)!.at);

    expect(history.samples).toHaveLength(1);
    expect(history.samples[0]!.at).toBeGreaterThan(samples.at(-1)!.at);
    expect(history.since).toBe(samples.at(-1)!.at);
  });

  it('sends nothing new when the reader already has the latest sample', async () => {
    const { harness, samples } = await historyOfThree();

    await expect(harness.service.getHistoryAfter(samples.at(-1)!.at)).resolves.toEqual({
      samples: [],
      since: samples.at(-1)!.at,
      oldestAt: samples[0]!.at,
    });
  });

  it('sends the whole window when the cursor has left it or came from another history', async () => {
    const { harness, samples } = await historyOfThree();

    for (const cursor of [samples[0]!.at - 5000, samples[0]!.at + 1]) {
      await expect(harness.service.getHistoryAfter(cursor)).resolves.toEqual({
        samples,
        since: null,
        oldestAt: samples[0]!.at,
      });
    }
  });

  it('sends the whole fresh window after the history restarted', async () => {
    const { harness, samples } = await historyOfThree();
    harness.advance(60_000);

    const history = await harness.service.getHistoryAfter(samples.at(-1)!.at);

    expect(history.since).toBeNull();
    expect(history.samples).toHaveLength(1);
    expect(history.oldestAt).toBe(history.samples[0]!.at);
  });
});

describe('HostMetricsService.getTopProcesses', () => {
  it('lists the five heaviest groups by CPU and, separately, by memory', async () => {
    const processes = Array.from({ length: 7 }, (_, index) => ({
      pid: 10 + index,
      ppid: 1,
      cpuPercent: index * 10,
      // Memory runs the other way, so the two lists differ.
      memoryBytes: (7 - index) * 1024,
      command: `/bin/p${index}`,
    }));
    const service = new HostMetricsService({
      readProcesses: () => Promise.resolve(processes),
      cpuCount: () => 1,
    });

    const breakdown = await service.getTopProcesses(new Map());

    expect(breakdown.byCpu.map((group) => group.label)).toEqual(['p6', 'p5', 'p4', 'p3', 'p2']);
    expect(breakdown.byMemory.map((group) => group.label)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });
});
