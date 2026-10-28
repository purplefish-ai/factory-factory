import type { SessionRuntimeState } from '@/shared/session-runtime';
import type { SessionStore } from './session-store.types';

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
    const work = updates.work ?? (options?.replace ? undefined : previousWork);
    store.runtime = {
      ...(options?.replace ? {} : previous),
      phase: updates.phase,
      processState: updates.processState,
      activity: updates.activity,
      ...(updates.activity === 'WORKING' && updates.processState === 'alive' && work
        ? { work }
        : {}),
      ...(Object.hasOwn(updates, 'lastExit') ? { lastExit: updates.lastExit } : {}),
      ...(Object.hasOwn(updates, 'errorMessage') ? { errorMessage: updates.errorMessage } : {}),
      updatedAt: updates.updatedAt ?? this.nowIso(),
    };

    if (options?.emitDelta !== false) {
      this.emitRuntimeDelta(store.sessionId, store.runtime);
    }
  }
}
