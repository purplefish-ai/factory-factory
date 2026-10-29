// Account listing may cover many profiles. Bound native processes and include
// queue time in each caller's deadline instead of multiplying startup latency.
let active = 0;
const waiting = new Set<() => void>();
const MAX_NATIVE_PROCESSES = 4;
export async function acquireNativeSlot(
  timeoutMs: number,
  signal?: AbortSignal
): Promise<() => void> {
  if (signal?.aborted) {
    throw new Error('Codex native account operation cancelled');
  }
  if (active >= MAX_NATIVE_PROCESSES) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', failed);
        waiting.delete(ready);
      };
      const failed = () => {
        cleanup();
        reject(new Error('Codex native account operation timed out or cancelled'));
      };
      const ready = () => {
        cleanup();
        active++;
        resolve();
      };
      const timer = setTimeout(failed, timeoutMs);
      timer.unref?.();
      waiting.add(ready);
      signal?.addEventListener('abort', failed, { once: true });
    });
  } else {
    active++;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    active--;
    waiting.values().next().value?.();
  };
}
