// Stops a sandbox nobody is using: when its owner process exits, or after its
// time to live. Agents and interrupted test runs forget sandboxes.
import { isSameProcess } from './process-group.mjs';

/** Consecutive failed process listings after which the watchdog stops the sandbox. */
export const MAX_FAILED_READINGS = 3;

/**
 * Why the sandbox should stop now, or null. `owner` is a pid with its start
 * time; `processes` is null when the listing failed ("cannot tell").
 */
export function watchdogReason({ now, startedAtMs, ttlMinutes, owner, processes }) {
  if (owner && processes && !isSameProcess(processes, owner)) {
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
  let failedReadings = 0;
  const timer = schedule(() => {
    if (fired) {
      return;
    }
    // `ps` can fail to fork under load: that reading tells nothing, and an
    // exception here would crash the launcher without cleaning up.
    let processes = [];
    let failure = null;
    if (owner) {
      try {
        processes = system.listProcesses();
        failedReadings = 0;
      } catch (error) {
        processes = null;
        failedReadings += 1;
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    const reason =
      watchdogReason({ now: system.now(), startedAtMs, ttlMinutes, owner, processes }) ??
      (failedReadings >= MAX_FAILED_READINGS
        ? `cannot read the process table (${failedReadings} attempts in a row; last: ${failure})`
        : null);
    if (reason) {
      fired = true;
      onExpire(reason);
    }
  }, intervalMs);
  timer?.unref?.();
  return () => cancel(timer);
}
