import { isDeepStrictEqual } from 'node:util';
import { agentSessionLaunchOriginAccessor } from '@/backend/services/session/resources/agent-session-launch-origin.accessor';
import type { AcpPromptObservation } from '@/backend/services/session/service/acp/acp-prompt-controller';
import {
  initialOutcomeSchema,
  initialAttemptSchema,
  initialDeliveryFenceSchema,
  type InitialAttempt,
  type InitialDeliveryOwnerPort,
  type InitialDeliveryFence,
  type ProviderSource,
  type RuntimeStopEvidence,
} from '@/shared/event-agent-delivery';
import type { EventAgentExecution } from '@/shared/event-agent-launch';
import { EventSessionFenceError } from './event-session-fence-error';

export type EventInitialPermit = Readonly<{
  attempt: InitialAttempt;
  execution: EventAgentExecution;
}>;
function blocked(): never {
  throw new EventSessionFenceError();
}
type EventSessionOrigin = { runId: string; execution: EventAgentExecution };
/** Local permits never replace the durable owner read, including before recovery. */
export class EventSessionAuthority {
  private owner: InitialDeliveryOwnerPort | undefined;
  private readonly active = new Map<string, EventInitialPermit>();
  private readonly attemptGuards = new WeakMap<EventInitialPermit, () => void>();
  private closing = false;
  private observationEpoch = 0;
  private readonly writes = new Set<Promise<unknown>>();
  constructor(private readonly findOrigin: (id: string) => Promise<EventSessionOrigin | null>) {}
  configure(owner: InitialDeliveryOwnerPort): void {
    this.owner = owner;
  }
  async read(
    sessionId: string,
    assertCurrent: () => void = () => undefined
  ): Promise<InitialDeliveryFence | null> {
    const origin = await this.findOrigin(sessionId);
    return this.readOwnedFence(sessionId, origin, assertCurrent);
  }
  private async readOwnedFence(
    sessionId: string,
    origin: EventSessionOrigin | null,
    assertCurrent: () => void = () => undefined
  ): Promise<InitialDeliveryFence | null> {
    assertCurrent();
    if (!origin) {
      return null;
    }
    if (!this.owner) {
      throw new Error('Event initial delivery is fenced: durable authority is unavailable');
    }
    const fence = initialDeliveryFenceSchema.parse(
      await this.owner.readFence(origin.runId, sessionId)
    );
    assertCurrent();
    if (
      fence.attempt.runId !== origin.runId ||
      fence.attempt.sessionId !== sessionId ||
      !isDeepStrictEqual(fence.execution, origin.execution)
    ) {
      throw new Error('Event initial durable authority identity mismatch');
    }
    return fence;
  }
  async isOwned(sessionId: string): Promise<boolean> {
    return (await this.findOrigin(sessionId)) !== null;
  }
  async assertOrdinary(sessionId: string): Promise<void> {
    const fence = await this.read(sessionId);
    if (fence && (fence.state !== 'FINISHED' || this.active.has(sessionId))) {
      blocked();
    }
  }
  async assertStartup(sessionId: string, permit?: EventInitialPermit): Promise<void> {
    await this.createStartupGuard(sessionId, permit);
  }
  async createStartupGuard(
    sessionId: string,
    permit?: EventInitialPermit
  ): Promise<() => Promise<void>> {
    const origin = await this.findOrigin(sessionId);
    const check = async () => {
      if (permit) {
        this.assertCurrent(permit);
      }
      const fence = await this.readOwnedFence(sessionId, origin);
      if (permit) {
        if (fence?.state !== 'PENDING' || !isDeepStrictEqual(fence.attempt, permit.attempt)) {
          blocked();
        }
        this.assertCurrent(permit);
      } else if (fence && (fence.state !== 'FINISHED' || this.active.has(sessionId))) {
        blocked();
      }
    };
    await check();
    return check;
  }
  assertCurrent(permit: EventInitialPermit): void {
    if (this.active.get(permit.attempt.sessionId) !== permit) {
      blocked();
    }
    this.attemptGuards.get(permit)?.();
  }
  invalidate(sessionId: string): void {
    this.active.delete(sessionId);
  }
  async runInitial<T>(
    input: InitialAttempt,
    operation: (permit: EventInitialPermit) => Promise<T>,
    assertOwnerCurrent: () => void = () => undefined
  ): Promise<T> {
    const attempt = initialAttemptSchema.parse(input);
    const fence = await this.read(attempt.sessionId);
    if (
      this.closing ||
      fence?.state !== 'PENDING' ||
      !isDeepStrictEqual(fence.attempt, attempt) ||
      this.active.has(attempt.sessionId)
    ) {
      blocked();
    }
    const permit = { attempt, execution: fence.execution };
    assertOwnerCurrent();
    this.attemptGuards.set(permit, assertOwnerCurrent);
    this.active.set(attempt.sessionId, permit);
    try {
      return await operation(permit);
    } finally {
      if (this.active.get(attempt.sessionId) === permit) {
        this.active.delete(attempt.sessionId);
      }
    }
  }
  observation(
    permit: EventInitialPermit,
    source: ProviderSource,
    assertRuntime: () => void
  ): AcpPromptObservation {
    const owner = this.owner;
    if (!owner) {
      blocked();
    }
    const assertCurrent = () => {
      this.assertCurrent(permit);
      assertRuntime();
    };
    return {
      assertCurrent,
      beforeSend: () =>
        this.observe(() => {
          assertCurrent();
          return owner.beforeSend(permit.attempt, source);
        }),
      outcome: (outcome) =>
        this.observe(() => {
          assertCurrent();
          // Validation occurs in the owning API; unknown provider reasons stay ambiguous.
          return owner.outcome(permit.attempt, initialOutcomeSchema.parse({ source, ...outcome }));
        }),
      ambiguous: () =>
        this.observe(() => {
          // A closed launch lifetime cannot initiate a late projection write.
          this.attemptGuards.get(permit)?.();
          return owner.ambiguous(permit.attempt);
        }),
    };
  }
  observeUnexpectedExit(sessionId: string, incarnationId: string): Promise<void> {
    return this.observe(async (assertCurrent) => {
      const fence = await this.read(sessionId, assertCurrent);
      const source = fence?.evidence?.source;
      if (!(fence && source) || source.runtimeIncarnationId !== incarnationId || !this.owner) {
        return;
      }
      this.invalidate(sessionId);
      assertCurrent();
      await this.owner.stop(fence.attempt, {
        version: 1,
        cause: 'UNEXPECTED_EXIT',
        source,
        status: 'UNKNOWN',
        observedAt: new Date().toISOString(),
      });
      assertCurrent();
      if (fence.state === 'SENDING' || fence.state === 'ACCEPTED') {
        await this.owner.ambiguous(fence.attempt);
      }
    });
  }

  recordStop(
    sessionId: string,
    evidence: RuntimeStopEvidence,
    signal?: AbortSignal
  ): Promise<void> {
    return this.observe(async (assertCurrent) => {
      const fence = await this.read(sessionId, assertCurrent);
      if (!(fence && this.owner)) {
        blocked();
      }
      assertCurrent();
      await this.owner.stop(fence.attempt, evidence);
      assertCurrent();
      if (fence.state === 'SENDING' || fence.state === 'ACCEPTED') {
        await this.owner.ambiguous(fence.attempt);
      }
    }, signal);
  }
  /** Permanently fences late continuations; already-started database calls cannot be undone. */
  close(): void {
    this.closing = true;
    this.observationEpoch++;
    this.active.clear();
  }
  async drain(): Promise<void> {
    this.closing = true;
    this.active.clear();
    try {
      const results = await Promise.allSettled([...this.writes]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        throw failure.reason;
      }
    } finally {
      this.close();
    }
  }
  private observe<T>(
    operation: (assertCurrent: () => void) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error('Event observations are closed'));
    }
    const epoch = this.observationEpoch;
    const assertCurrent = () => {
      if (epoch !== this.observationEpoch || signal?.aborted) {
        blocked();
      }
    };
    const write = Promise.resolve().then(() => {
      assertCurrent();
      return operation(assertCurrent);
    });
    this.writes.add(write);
    void write.then(
      () => this.writes.delete(write),
      () => this.writes.delete(write)
    );
    return write;
  }
}
export const eventSessionAuthority = new EventSessionAuthority((id) =>
  agentSessionLaunchOriginAccessor.findBySessionId(id)
);
