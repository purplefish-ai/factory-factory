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

export class SessionRuntimeMachine {
  constructor(
    private readonly emitRuntimeDelta: (sessionId: string, runtime: SessionRuntimeState) => void,
    private readonly nowIso: () => string
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
    if (updates.processState === 'stopped') {
      store.liveSlashCommands = undefined;
    }
    const work = selectWork(updates, options?.replace ? undefined : previousWork);
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
      this.emitRuntimeDelta(store.sessionId, store.runtime);
    }
  }
}
