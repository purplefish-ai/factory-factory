import { randomUUID } from 'node:crypto';
import type { SessionStopControl, SessionStopTarget } from '@/shared/acp-protocol/subagents';
import { AcpSubagentBrowseError } from './acp-runtime-errors';

export type AcpStopDispatch =
  | { kind: 'task'; sessionId: string; asyncTaskId: string }
  | { kind: 'subagent'; sessionId: string };

/** Owned by one tracker incarnation, with fresh capabilities after every generation/withdrawal. */
export class AcpTargetedStopControls {
  runtimeId: string = randomUUID();
  private readonly entries = new Map<
    string,
    { control: SessionStopControl; dispatch: AcpStopDispatch; ownerSessionId: string }
  >();

  set(
    id: string,
    dispatch: AcpStopDispatch,
    enabled: boolean,
    newGeneration = false,
    ownerSessionId = dispatch.sessionId
  ): void {
    const key = JSON.stringify([dispatch.kind, id]);
    if (!enabled) {
      this.entries.delete(key);
    } else if (newGeneration || !this.entries.has(key)) {
      this.entries.set(key, {
        control: { controlId: randomUUID(), runtimeId: this.runtimeId },
        dispatch,
        ownerSessionId,
      });
    }
  }

  get(kind: SessionStopTarget['kind'], id: string): SessionStopControl | undefined {
    const entry = this.entries.get(JSON.stringify([kind, id]));
    return entry ? { ...entry.control } : undefined;
  }

  clear(): void {
    this.entries.clear();
    this.runtimeId = randomUUID();
  }

  invalidateSession(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.ownerSessionId === sessionId) {
        this.entries.delete(key);
      }
    }
  }

  resolve(target: SessionStopTarget): AcpStopDispatch {
    const entry = this.entries.get(JSON.stringify([target.kind, target.id]));
    if (!entry || entry.control.controlId !== target.controlId) {
      throw new AcpSubagentBrowseError(
        'PRECONDITION_FAILED',
        'This item can no longer be stopped. Refresh and try again.'
      );
    }
    return { ...entry.dispatch };
  }
}
