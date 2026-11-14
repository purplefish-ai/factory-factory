/** Deterministic samples that wobble around the given levels, one per 5-second poll. */
export function hostLoadHistory(cpu: number, memory: number, count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    at: index * 5000,
    cpuPercent: Math.max(0, Math.min(100, Math.round(cpu + Math.sin(index / 3) * 8))),
    memoryPercent: Math.max(0, Math.min(100, Math.round(memory + Math.cos(index / 7) * 3))),
  }));
}

const GB = 1024 ** 3;
const group = (
  key: string,
  label: string,
  kind: 'workspace' | 'factory' | 'app' | 'process',
  cpuPercent: number,
  memoryBytes: number,
  processCount: number
) => ({
  key,
  label,
  kind,
  workspace: kind === 'workspace' ? { id: key, projectSlug: 'factory-factory' } : null,
  cpuPercent,
  memoryBytes,
  processCount,
});

/** A busy afternoon: Chrome and one workspace's test run share the machine. */
export const hostLoadBreakdown = {
  byCpu: [
    group('w-tests', 'Run the e2e suite', 'workspace', 38, 3.1 * GB, 14),
    group('app:Google Chrome', 'Google Chrome', 'app', 22, 6.4 * GB, 41),
    group('factory-factory', 'Factory Factory', 'factory', 6, 1.2 * GB, 9),
    group('process:WindowServer', 'WindowServer', 'process', 4, 0.6 * GB, 1),
    group('process:fseventsd', 'fseventsd', 'process', 3, 0.1 * GB, 1),
  ],
  byMemory: [
    group('app:Google Chrome', 'Google Chrome', 'app', 22, 6.4 * GB, 41),
    group('w-tests', 'Run the e2e suite', 'workspace', 38, 3.1 * GB, 14),
    group('app:Docker', 'Docker', 'app', 1, 2.4 * GB, 6),
    group('factory-factory', 'Factory Factory', 'factory', 6, 1.2 * GB, 9),
    group('app:Slack', 'Slack', 'app', 1, 0.9 * GB, 5),
  ],
};
