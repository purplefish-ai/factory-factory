import { isDeepStrictEqual } from 'node:util';
import { ApplicationError } from '@/backend/lib/application-error';
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

export type EventInitialPermit = Readonly<{
  attempt: InitialAttempt;
  execution: EventAgentExecution;
}>;
function blocked(): never {
  throw new ApplicationError(
    'PRECONDITION_FAILED',
    'Event initial delivery is fenced; inspect its durable run state'
  );
}
/** Local permits never replace the durable owner read, including before recovery. */
export class EventSessionAuthority {
  private owner: InitialDeliveryOwnerPort | undefined;
  private readonly active = new Map<string, EventInitialPermit>();
  private readonly attemptGuards = new WeakMap<EventInitialPermit, () => void>();
  private readonly writes = new Set<Promise<unknown>>();
  constructor(
    private readonly findOrigin: (
      id: string
    ) => Promise<{ runId: string; execution: EventAgentExecution } | null>
  ) {}
  configure(owner: InitialDeliveryOwnerPort): void {
    this.owner = owner;
  }
  async read(sessionId: string): Promise<InitialDeliveryFence | null> {
    const origin = await this.findOrigin(sessionId);
    if (!origin) {
      return null;
    }
    if (!this.owner) {
      blocked();
    }
    const fence = initialDeliveryFenceSchema.parse(
      await this.owner.readFence(origin.runId, sessionId)
    );
    if (
      fence.attempt.runId !== origin.runId ||
      fence.attempt.sessionId !== sessionId ||
      !isDeepStrictEqual(fence.execution, origin.execution)
    ) {
      blocked();
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
    if (!permit) {
      return this.assertOrdinary(sessionId);
    }
    this.assertCurrent(permit);
    const fence = await this.read(sessionId);
    if (fence?.state !== 'PENDING' || !isDeepStrictEqual(fence.attempt, permit.attempt)) {
      blocked();
    }
    this.assertCurrent(permit);
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
      beforeSend: () => this.track(owner.beforeSend(permit.attempt, source)),
      outcome: async (outcome) => {
        assertCurrent();
        // Validation occurs in the owning API; unknown provider reasons stay ambiguous.
        await this.track(
          owner.outcome(permit.attempt, initialOutcomeSchema.parse({ source, ...outcome }))
        );
      },
      ambiguous: () => this.track(owner.ambiguous(permit.attempt)),
    };
  }
  async observeUnexpectedExit(sessionId: string, incarnationId: string): Promise<void> {
    const fence = await this.read(sessionId);
    const source = fence?.evidence?.source;
    if (!(fence && source) || source.runtimeIncarnationId !== incarnationId || !this.owner) {
      return;
    }
    this.invalidate(sessionId);
    await this.track(
      this.owner.stop(fence.attempt, {
        version: 1,
        cause: 'UNEXPECTED_EXIT',
        source,
        status: 'UNKNOWN',
        observedAt: new Date().toISOString(),
      })
    );
    if (fence.state === 'SENDING' || fence.state === 'ACCEPTED') {
      await this.track(this.owner.ambiguous(fence.attempt));
    }
  }

  async recordStop(sessionId: string, evidence: RuntimeStopEvidence): Promise<void> {
    const fence = await this.read(sessionId);
    if (!(fence && this.owner)) {
      blocked();
    }
    await this.track(this.owner.stop(fence.attempt, evidence));
    if (fence.state === 'SENDING' || fence.state === 'ACCEPTED') {
      await this.track(this.owner.ambiguous(fence.attempt));
    }
  }
  async drain(): Promise<void> {
    while (this.writes.size) {
      await Promise.all([...this.writes]);
    }
  }
  private track<T>(write: Promise<T>): Promise<T> {
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
