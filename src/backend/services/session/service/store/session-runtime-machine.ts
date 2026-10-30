import { isDeepStrictEqual } from 'node:util';
import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { SessionStore } from './session-store.types';

function selectWork(
  updates: Pick<SessionRuntimeState, 'phase' | 'processState' | 'activity' | 'work'>,
  previousWork: SessionRuntimeState['work']
): SessionRuntimeState['work'] {
  if (updates.processState !== 'alive') {
    return undefined;
  }
  if (Object.hasOwn(updates, 'work')) {
    return updates.work;
  }
  if (updates.phase === 'error' || updates.activity === 'IDLE') {
    return undefined;
  }
  return previousWork;
}

function sameRuntimeIgnoringTimestamp(a: SessionRuntimeState, b: SessionRuntimeState): boolean {
  const { updatedAt: _aUpdatedAt, ...aRest } = a;
  const { updatedAt: _bUpdatedAt, ...bRest } = b;
  return isDeepStrictEqual(aRest, bRest);
}

export class SessionRuntimeMachine {
  constructor(
    private readonly emitRuntimeDelta: (sessionId: string, runtime: SessionRuntimeState) => void,
    private readonly nowIso: () => string,
    private readonly clearSlashCommands?: (sessionId: string) => void
  ) {}

  markRuntime(
    store: SessionStore,
    updates: Pick<SessionRuntimeState, 'phase' | 'processState' | 'activity'> & {
      lastExit?: SessionRuntimeState['lastExit'];
      errorMessage?: SessionRuntimeState['errorMessage'];
      work?: SessionRuntimeState['work'];
      updatedAt?: string;
    },
    options?: { emitDelta?: boolean; replace?: boolean }
  ): void {
    const {
      lastExit: _lastExit,
      errorMessage: _errorMessage,
      work: previousWork,
      ...previous
    } = store.runtime;
    const clearSlashCommands =
      updates.processState === 'stopped' && store.liveSlashCommands !== undefined;
    if (updates.processState === 'stopped') {
      store.liveSlashCommands = undefined;
    }
    const work = selectWork(updates, options?.replace ? undefined : previousWork);
    const before = store.runtime;
    store.runtime = {
      ...(options?.replace ? {} : previous),
      phase: updates.phase,
      processState: updates.processState,
      activity: updates.activity,
      ...(work ? { work } : {}),
      ...(Object.hasOwn(updates, 'lastExit') ? { lastExit: updates.lastExit } : {}),
      ...(Object.hasOwn(updates, 'errorMessage') ? { errorMessage: updates.errorMessage } : {}),
      updatedAt: updates.updatedAt ?? this.nowIso(),
    };

    if (options?.emitDelta !== false) {
      if (clearSlashCommands) {
        this.clearSlashCommands?.(store.sessionId);
      }
      // Repeated transitions to the same state (e.g. each background-task status
      // notification) only refresh the timestamp; skip the delta and its DB-backed
      // workspace summary refresh.
      if (sameRuntimeIgnoringTimestamp(before, store.runtime)) {
        return;
      }
      this.emitRuntimeDelta(store.sessionId, store.runtime);
    }
  }
}
