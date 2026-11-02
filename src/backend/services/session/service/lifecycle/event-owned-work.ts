import { isDeepStrictEqual } from 'node:util';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp/acp-process-handle';
import type { AcpRuntimeManager } from '@/backend/services/session/service/acp/acp-runtime-manager';
import type { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type {
  InitialAttempt,
  ProviderSource,
  RuntimeStopEvidence,
  EventRunResolution,
} from '@/shared/event-agent-delivery';
import type { EventWorkProof } from '@/shared/event-agent-work';
import type { SessionLifecycleGate } from './session-lifecycle-gate';

type Facts = ReturnType<
  NonNullable<AcpProcessHandle['nativeSessionTracker']>['getWorkObservation']
>;
type Window = {
  attempt: InitialAttempt;
  source: ProviderSource;
  handle: AcpProcessHandle;
  coverageGeneration: number;
  pendingRevision: number;
  initialPromptRevision: number;
};

/** Per-attempt observation ownership. Replayed/missing zeroes never grant coverage. */
export class EventOwnedWork {
  private readonly windows = new Map<string, Window>();
  constructor(
    private readonly runtime: AcpRuntimeManager,
    private readonly lifecycle: SessionLifecycleGate,
    private readonly domain: SessionDomainService
  ) {
    domain.on('pending_request_changed', ({ sessionId }) => {
      const window = this.windows.get(sessionId);
      if (window) {
        window.pendingRevision++;
      }
    });
    domain.on('session_permanently_deleted', (sessionId) => this.forget(sessionId));
  }
  forget(sessionId: string): void {
    this.windows.delete(sessionId);
  }
  /** Saved decisions are not restart certificates: the exact old window must survive. */
  assertRetryReady(attempt: InitialAttempt, previous: EventRunResolution): void {
    const old = previous.attempt;
    const observation = this.observe(old, previous.work.source, previous.stop);
    if (
      previous.action !== 'RETRY' ||
      previous.work.mode !== 'STOPPED' ||
      old.runId !== attempt.runId ||
      old.sessionId !== attempt.sessionId ||
      old.attemptGeneration + 1 !== attempt.attemptGeneration ||
      observation?.proof.mode !== 'STOPPED'
    ) {
      throw new Error('Previous work proof is unavailable');
    }
    observation.assertCurrent();
  }
  begin(attempt: InitialAttempt, source: ProviderSource, resolvedPreviousWork = false): void {
    this.forget(attempt.sessionId);
    const handle = this.runtime.getClient(attempt.sessionId);
    const facts = handle?.nativeSessionTracker?.getWorkObservation();
    if (
      !(handle && facts) ||
      facts.replaying ||
      (facts.coverageGeneration !== 0 && !resolvedPreviousWork) ||
      facts.rootSessionId !== source.providerSessionId ||
      !isDeepStrictEqual(this.runtime.getRuntimeSource(attempt.sessionId), source)
    ) {
      return;
    }
    this.windows.set(attempt.sessionId, {
      attempt,
      source,
      handle,
      coverageGeneration: facts.coverageGeneration,
      pendingRevision: 0,
      initialPromptRevision: handle.promptRevision,
    });
  }
  /** Explicit recovery may stop initial work, never a later active human prompt. */
  stopGuard(attempt: InitialAttempt, source: ProviderSource): (() => void) | null {
    const window = this.windows.get(attempt.sessionId);
    const facts = window?.handle.nativeSessionTracker?.getWorkObservation();
    if (!(window && facts && this.covered(window, attempt, source, facts))) {
      return null;
    }
    const revision = window.handle.promptRevision;
    // begin() precedes the initial prompt's start/end transitions. Later human
    // prompts advance beyond those two revisions and may not be interrupted here.
    if (revision > window.initialPromptRevision + 1 && !this.idle(window, facts, false)) {
      return null;
    }
    const lastAllowedRevision = Math.max(revision, window.initialPromptRevision + 2);
    return () => {
      if (
        this.windows.get(attempt.sessionId) !== window ||
        window.handle.promptRevision > lastAllowedRevision
      ) {
        throw new Error('Initial work was replaced by another prompt');
      }
    };
  }
  private covered(window: Window, attempt: InitialAttempt, source: ProviderSource, facts: Facts) {
    return (
      this.windows.get(attempt.sessionId) === window &&
      // Worker takeover changes the lease, not this physical send. Owner writes
      // separately fence the current worker; every send identity remains exact.
      isDeepStrictEqual(
        { ...window.attempt, workerGeneration: attempt.workerGeneration },
        attempt
      ) &&
      isDeepStrictEqual(window.source, source) &&
      !facts.replaying &&
      facts.coverageGeneration === window.coverageGeneration &&
      facts.rootSessionId === source.providerSessionId
    );
  }
  private runtimeMatches(window: Window, stopped: boolean) {
    const id = window.attempt.sessionId;
    const handle = this.runtime.getClient(id);
    if (stopped) {
      return (
        // No live handle alone cannot exclude a replacement that has already stopped.
        isDeepStrictEqual(this.runtime.getRuntimeStopSource(id), window.source) &&
        !handle &&
        !window.handle.isRunning() &&
        !this.runtime.hasClientCreationOperation(id) &&
        !this.lifecycle.isSessionStopping(id)
      );
    }
    return (
      handle === window.handle &&
      isDeepStrictEqual(this.runtime.getRuntimeSource(id), window.source) &&
      this.lifecycle.isGenerationCurrent(id, window.source.lifecycleGeneration) &&
      !this.lifecycle.isSessionStopping(id)
    );
  }
  private idle(window: Window, facts: Facts, stopped: boolean) {
    return (
      (stopped || !window.handle.isPromptInFlight) &&
      !this.domain.getPendingInteractiveRequest(window.attempt.sessionId) &&
      facts.work.activeGoals === 0 &&
      facts.work.runningSubagents === 0 &&
      !facts.work.backgroundTasks.some((task) => task.kind !== 'shell')
    );
  }
  observe(attempt: InitialAttempt, source: ProviderSource, stop?: RuntimeStopEvidence) {
    const window = this.windows.get(attempt.sessionId);
    const facts = window?.handle.nativeSessionTracker?.getWorkObservation();
    const stopped =
      stop?.status === 'LOCAL_RUNTIME_GROUP_STOPPED' && isDeepStrictEqual(stop.source, source);
    if (
      !(
        window &&
        facts &&
        this.covered(window, attempt, source, facts) &&
        this.runtimeMatches(window, stopped) &&
        this.idle(window, facts, stopped)
      )
    ) {
      return null;
    }
    // A strict stop has advanced beyond the source's original generation. Capture
    // the current gate generation so later stop/start activity still invalidates it.
    const lifecycleGeneration = this.lifecycle.getGeneration(attempt.sessionId);
    const promptRevision = window.handle.promptRevision;
    const pendingRevision = window.pendingRevision;
    const assertWorkCurrent = () => {
      const current = window.handle.nativeSessionTracker?.getWorkObservation();
      if (
        !(current && this.covered(window, attempt, source, current)) ||
        current.revision !== facts.revision ||
        window.handle.promptRevision !== promptRevision ||
        window.pendingRevision !== pendingRevision ||
        !this.idle(window, current, stopped)
      ) {
        throw new Error('Event owned-work observation changed');
      }
    };
    const proof: EventWorkProof = {
      version: 1,
      source,
      revision: facts.revision,
      coverageGeneration: facts.coverageGeneration,
      mode: stopped ? 'STOPPED' : 'LIVE',
      observedAt: new Date().toISOString(),
    };
    return {
      proof,
      assertWorkCurrent,
      assertCurrent: () => {
        assertWorkCurrent();
        if (
          !(
            this.runtimeMatches(window, stopped) &&
            this.lifecycle.isGenerationCurrent(attempt.sessionId, lifecycleGeneration)
          )
        ) {
          throw new Error('Event owned-work observation changed');
        }
      },
    };
  }
}
