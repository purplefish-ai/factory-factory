import { ApplicationError } from '@/backend/lib/application-error';
import {
  agentEvaluationCandidatesAccessor,
  type EvaluationCursor,
} from '@/backend/services/agent-definition/resources/agent-evaluation-candidates.accessor';
import { agentEvaluationAccessor } from '@/backend/services/agent-definition/resources/agent-evaluation.accessor';
import { agentRunAccessor } from '@/backend/services/agent-definition/resources/agent-run.accessor';
import {
  eventEligibility,
  permanentRuntimeStateReason,
  rawTriggerInput,
  triggerRevisions,
} from '@/backend/services/agent-definition/resources/agent-runtime-guards';
import {
  agentEventPayloadSchema,
  agentResolvedExecutionConfigSchema,
  type AgentExecutionConfig,
  type AgentResolvedExecutionConfig,
  type AgentEvaluationInput,
  type AgentEventPayload,
} from '@/shared/agent-runtime';
import {
  agentExecutionConfigSchema,
  agentTriggerInputSchema,
} from '@/shared/schemas/agent-definition.schema';
import { matchAgentEvent } from './agent-event-matcher';

export interface AgentEvaluationPorts {
  resolveExecution(config: AgentExecutionConfig): Promise<AgentResolvedExecutionConfig>;
  now?: () => Date;
  classifyError?: (error: unknown) => { retryable: boolean; retryAfterMs?: number };
}
type Candidate = Awaited<
  ReturnType<typeof agentEvaluationCandidatesAccessor.pending>
>['candidates'][number];

export class AgentEventEvaluationService {
  private cursor: EvaluationCursor | null = null;
  constructor(private readonly ports: AgentEvaluationPorts) {}

  async evaluatePendingEvents(signal: AbortSignal) {
    if (signal.aborted) {
      return;
    }
    let page = await agentEvaluationCandidatesAccessor.pending(this.cursor);
    if (!page.candidates.length && this.cursor) {
      page = await agentEvaluationCandidatesAccessor.pending(null);
    }
    for (const candidate of page.candidates) {
      if (signal.aborted) {
        return;
      }
      await this.evaluate(candidate, signal);
      this.cursor = { triggerId: candidate.trigger.id, eventId: candidate.event.id };
    }
    if (!page.candidates.length) {
      this.cursor = null;
    }
  }

  private async evaluate({ event, trigger, evaluation }: Candidate, signal: AbortSignal) {
    const now = this.ports.now?.() ?? new Date();
    const revisions = triggerRevisions(trigger);
    if (
      evaluation &&
      (await agentEvaluationCandidatesAccessor.settleUnavailable(evaluation.id, now))
    ) {
      return;
    }
    if (
      evaluation?.status === 'ERROR' &&
      (!evaluation.nextAttemptAt || evaluation.nextAttemptAt > now)
    ) {
      return;
    }
    if (evaluation?.status === 'MATCHED') {
      await agentRunAccessor.admitRun({ evaluationId: evaluation.id, ...revisions });
      return;
    }
    const { decision, retryable, retryAfterMs } = await this.decide(
      { event, trigger, evaluation },
      now
    );
    if (signal.aborted) {
      return;
    }
    const result = await agentEvaluationAccessor.recordEvaluation(decision, {
      now,
      retryable,
      retryAfterMs,
      expectedAttemptCount: evaluation?.attemptCount,
    });
    if ('evaluationId' in result && decision.status === 'MATCHED') {
      await agentRunAccessor.admitRun({ evaluationId: result.evaluationId, ...revisions });
    }
  }

  private async decide({ event, trigger }: Candidate, now: Date) {
    const decision: AgentEvaluationInput = {
      eventId: event.id,
      agentDefinitionId: trigger.agentDefinitionId,
      triggerId: trigger.id,
      ...triggerRevisions(trigger),
      status: 'ERROR',
      reasonCode: 'INVALID_STORED_DATA',
      explanation: 'Stored event or configuration is invalid.',
      executionConfig: { version: 1 },
      input: { version: 1, eventId: event.id, context: [] },
    };
    const unavailable = permanentRuntimeStateReason(trigger);
    if (unavailable) {
      Object.assign(decision, {
        status: unavailable === 'INVALID_STORED_DATA' ? 'ERROR' : 'SKIPPED',
        reasonCode: unavailable,
        explanation: 'Runtime eligibility prevents execution.',
      });
      return { decision };
    }
    const payload = agentEventPayloadSchema.safeParse(event.payload);
    const settings = agentTriggerInputSchema.safeParse(rawTriggerInput(trigger));
    const execution = agentExecutionConfigSchema.safeParse(trigger.agentDefinition.executionConfig);
    if (!(payload.success && settings.success && execution.success)) {
      return { decision };
    }
    const eligibility = eventEligibility(trigger, event, now);
    if (eligibility) {
      Object.assign(decision, {
        status: eligibility === 'INVALID_STORED_DATA' ? 'ERROR' : 'SKIPPED',
        reasonCode: eligibility,
        explanation: 'The event is outside the active trigger boundary.',
      });
      return { decision };
    }
    Object.assign(decision, matchAgentEvent(payload.data, settings.data));
    if (decision.status !== 'MATCHED') {
      return { decision };
    }
    return await this.resolveMatch(decision, payload.data, execution.data);
  }

  private async resolveMatch(
    decision: AgentEvaluationInput,
    payload: AgentEventPayload,
    execution: AgentExecutionConfig
  ): Promise<{ decision: AgentEvaluationInput; retryable?: boolean; retryAfterMs?: number }> {
    try {
      decision.executionConfig = agentResolvedExecutionConfigSchema.parse(
        await this.ports.resolveExecution(execution)
      );
      decision.input = eventInput(decision.eventId, payload);
      return { decision };
    } catch (error) {
      const classified = this.ports.classifyError?.(error) ?? {
        retryable: !(
          error instanceof ApplicationError ||
          (error instanceof Error && error.name === 'ZodError')
        ),
      };
      Object.assign(decision, {
        status: 'ERROR',
        reasonCode: classified.retryable
          ? 'EXECUTION_RESOLUTION_RETRY'
          : 'INVALID_EXECUTION_CONFIG',
        explanation: classified.retryable
          ? 'Execution defaults could not be read; retry is bounded.'
          : 'Execution configuration is invalid.',
      });
      return { decision, ...classified };
    }
  }
}
function eventInput(eventId: string, payload: AgentEventPayload) {
  const context =
    payload.provider === 'GITHUB'
      ? [
          { id: `${eventId}:title`, text: payload.issue.title, url: payload.sourceUrl },
          { id: `${eventId}:body`, text: payload.issue.body, url: payload.sourceUrl },
        ]
      : [{ id: eventId, text: payload.text, url: payload.sourceUrl }];
  return { version: 1 as const, eventId, sourceUrl: payload.sourceUrl, context };
}
