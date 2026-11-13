// Stops a sandbox nobody is using: when its owner process exits, or after its
// time to live. Agents and interrupted test runs forget sandboxes.
import { isSameProcess } from './process-group.mjs';

/** Why the sandbox should stop now, or null. `owner` is a pid with its start time. */
export function watchdogReason({ now, startedAtMs, ttlMinutes, owner, processes }) {
  if (owner && !isSameProcess(processes, owner)) {
    return `owner process ${owner.pid} exited`;
  }
  if (ttlMinutes > 0 && now - startedAtMs >= ttlMinutes * 60_000) {
    return `time to live of ${ttlMinutes} minutes reached`;
  }
  return null;
}

/**
 * Checks every `intervalMs` and calls `onExpire(reason)` once. Returns a stop function.
 *
 * @param {object} options
 * @param {{ pid: number, startedAt: string } | null} options.owner
 * @param {number} options.ttlMinutes
 * @param {number} options.startedAtMs
 * @param {Pick<import('./process-group.mjs').ProcessSystem, 'listProcesses' | 'now'>} options.system
 * @param {(reason: string) => void} options.onExpire
 * @param {number} [options.intervalMs]
 * @param {(tick: () => void, ms: number) => any} [options.setInterval]
 * @param {(timer: any) => void} [options.clearInterval]
 * @returns {() => void}
 */
export function startWatchdog({
  owner,
  ttlMinutes,
  startedAtMs,
  system,
  onExpire,
  intervalMs = 5000,
  setInterval: schedule = setInterval,
  clearInterval: cancel = clearInterval,
}) {
  if (!owner && ttlMinutes === 0) {
    return () => undefined;
  }
  let fired = false;
  const timer = schedule(() => {
    if (fired) {
      return;
    }
    const reason = watchdogReason({
      now: system.now(),
      startedAtMs,
      ttlMinutes,
      owner,
      processes: owner ? system.listProcesses() : [],
    });
    if (reason) {
      fired = true;
      onExpire(reason);
    }
  }, intervalMs);
  timer?.unref?.();
  return () => cancel(timer);
}
