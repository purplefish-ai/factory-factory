import type { SubagentsChangedParams } from '@/shared/acp-protocol/subagents';

type SubagentChange = SubagentsChangedParams['change'];

export const DEFAULT_SUBAGENT_UPDATE_INTERVAL_MS = 250;

/**
 * Throttles per-token subagent `updated` notifications.
 *
 * The native tracker reports `updated` for every child session update, and each
 * notification makes viewers refetch the subagent list/transcript. Updates for
 * one subagent are emitted at most once per interval; `created` and `completed`
 * are emitted immediately and supersede a pending update for that subagent.
 */
export class SubagentChangeCoalescer {
  private readonly pending = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  constructor(
    private readonly emit: (sessionId: string, subagentId: string, change: SubagentChange) => void,
    private readonly intervalMs = DEFAULT_SUBAGENT_UPDATE_INTERVAL_MS
  ) {}

  push(sessionId: string, subagentId: string, change: SubagentChange): void {
    if (change !== 'updated') {
      this.cancel(sessionId, subagentId);
      this.emit(sessionId, subagentId, change);
      return;
    }
    let timers = this.pending.get(sessionId);
    if (timers?.has(subagentId)) {
      return;
    }
    if (!timers) {
      timers = new Map();
      this.pending.set(sessionId, timers);
    }
    timers.set(
      subagentId,
      setTimeout(() => {
        this.cancel(sessionId, subagentId);
        this.emit(sessionId, subagentId, 'updated');
      }, this.intervalMs)
    );
  }

  /** Emits pending updates for a session now, e.g. before its state is torn down. */
  flushSession(sessionId: string): void {
    const timers = this.pending.get(sessionId);
    if (!timers) {
      return;
    }
    this.pending.delete(sessionId);
    for (const [subagentId, timer] of timers) {
      clearTimeout(timer);
      this.emit(sessionId, subagentId, 'updated');
    }
  }

  private cancel(sessionId: string, subagentId: string): void {
    const timers = this.pending.get(sessionId);
    const timer = timers?.get(subagentId);
    if (!(timers && timer)) {
      return;
    }
    clearTimeout(timer);
    timers.delete(subagentId);
    if (timers.size === 0) {
      this.pending.delete(sessionId);
    }
  }
}
