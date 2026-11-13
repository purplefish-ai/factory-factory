/** Deterministic samples that wobble around the given levels, one per 5-second poll. */
export function hostLoadHistory(cpu: number, memory: number, count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    at: index * 5000,
    cpuPercent: Math.max(0, Math.min(100, Math.round(cpu + Math.sin(index / 3) * 8))),
    memoryPercent: Math.max(0, Math.min(100, Math.round(memory + Math.cos(index / 7) * 3))),
  }));
}
