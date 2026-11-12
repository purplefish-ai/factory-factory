import { ApplicationError } from '@/backend/lib/application-error';
import {
  agentEvaluationCandidatesAccessor,
  type EvaluationCursor,
} from '@/backend/services/agent-definition/resources/agent-evaluation-candidates.accessor';
import {
  evaluationExplanations,
  MAX_FILTER_INSTRUCTIONS_LENGTH,
} from '@/backend/services/agent-definition/resources/agent-evaluation-explanations';
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
import type { SessionProvider } from '@/shared/core/enums';
import {
  agentExecutionConfigSchema,
  agentTriggerInputSchema,
} from '@/shared/schemas/agent-definition.schema';
import { matchAgentEvent } from './agent-event-matcher';
import {
  filterTooLongDecision,
  type SemanticFilterInput,
  type SemanticFilterOutcome,
  semanticDecision,
  unavailableDecision,
  unprovenProviderDecision,
} from './agent-semantic-filter';
import { isClassifierProven } from './semantic-filter-gate';
import {
  type SlackContextConfig,
  type SlackContextEvent,
  type SlackContextOutcome,
  slackMessageItems,
} from './slack-event-context';

export interface AgentEvaluationPorts {
  resolveExecution(config: AgentExecutionConfig): Promise<AgentResolvedExecutionConfig>;
  now?: () => Date;
  classifyError?: (error: unknown) => { retryable: boolean; retryAfterMs?: number };
  /** Natural-language filter classifier; without it filtered triggers never dispatch. */
  classifyEvent?: (
    input: SemanticFilterInput,
    signal: AbortSignal
  ) => Promise<SemanticFilterOutcome>;
  /** Defaults to the checked-in live classifier gate. */
  isClassifierProven?: (provider: SessionProvider) => boolean;
  /** Bounded Slack thread and channel context; without it Slack matches never dispatch. */
  resolveSlackContext?: (
    event: SlackContextEvent,
    config: SlackContextConfig,
    signal: AbortSignal
  ) => Promise<SlackContextOutcome>;
}
type Decided = { decision: AgentEvaluationInput; retryable?: boolean; retryAfterMs?: number };
type Candidate = Awaited<
  ReturnType<typeof agentEvaluationCandidatesAccessor.pending>
>['candidates'][number];

export class AgentEventEvaluationService {
  private cursor: EvaluationCursor | null = null;
  constructor(private readonly ports: AgentEvaluationPorts) {}

  /** Starts the next pass from the first trigger, so newly activated triggers are not passed over. */
  restartRotation() {
    this.cursor = null;
  }

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
      now,
      signal
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

  private async decide(
    { event, trigger }: Candidate,
    now: Date,
    signal: AbortSignal
  ): Promise<Decided> {
    const decision: AgentEvaluationInput = {
      eventId: event.id,
      agentDefinitionId: trigger.agentDefinitionId,
      triggerId: trigger.id,
      ...triggerRevisions(trigger),
      status: 'ERROR',
      reasonCode: 'INVALID_STORED_DATA',
      explanation: evaluationExplanations.invalidStoredData,
      executionConfig: { version: 1 },
      input: { version: 1, eventId: event.id, context: [] },
    };
    const unavailable = permanentRuntimeStateReason(trigger);
    if (unavailable) {
      Object.assign(decision, {
        status: unavailable === 'INVALID_STORED_DATA' ? 'ERROR' : 'SKIPPED',
        reasonCode: unavailable,
        explanation: evaluationExplanations.runtimeIneligible,
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
        explanation: evaluationExplanations.outsideBoundary,
      });
      return { decision };
    }
    Object.assign(decision, matchAgentEvent(payload.data, settings.data));
    if (decision.status !== 'MATCHED') {
      return { decision };
    }
    const resolved = await this.resolveMatch(decision, payload.data, execution.data);
    if (decision.status !== 'MATCHED') {
      return resolved;
    }
    // Context comes before the classifier: a run never starts, and no classifier
    // call is spent, on an event whose required context cannot be read.
    if (payload.data.provider === 'SLACK' && settings.data.type === 'SLACK_MESSAGE') {
      const context = await this.slackContext(
        decision,
        { id: event.id, connectionId: event.connectionId, payload: payload.data },
        settings.data.config,
        signal
      );
      if (decision.status !== 'MATCHED') {
        return context;
      }
    }
    const filterInstructions = settings.data.filterInstructions;
    if (!filterInstructions) {
      return resolved;
    }
    return await this.filterMatch(decision, filterInstructions, payload.data, signal);
  }

  /** Appends the trigger's Slack context to the run input, or turns the match into an ERROR. */
  private async slackContext(
    decision: AgentEvaluationInput,
    event: SlackContextEvent,
    config: SlackContextConfig,
    signal: AbortSignal
  ): Promise<Decided> {
    const outcome: SlackContextOutcome = this.ports.resolveSlackContext
      ? await this.ports
          .resolveSlackContext(event, config, signal)
          .catch((): SlackContextOutcome => contextFailure('SLACK_CONTEXT_RETRY', true))
      : contextFailure('SLACK_CONTEXT_UNAVAILABLE', false);
    if (outcome.status === 'RESOLVED') {
      decision.input = {
        ...decision.input,
        context: [...(decision.input.context ?? []), ...outcome.context],
      };
      return { decision };
    }
    const { reasonCode, explanation, retryable, retryAfterMs } = outcome;
    Object.assign(decision, { status: 'ERROR', reasonCode, explanation });
    return { decision, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }

  /** Only a deterministic match reaches the classifier; anything but a clear match never runs. */
  private async filterMatch(
    decision: AgentEvaluationInput,
    filterInstructions: string,
    event: AgentEventPayload,
    signal: AbortSignal
  ): Promise<Decided> {
    const { provider } = agentResolvedExecutionConfigSchema.parse(decision.executionConfig);
    const result = await this.semanticFilter(
      decision,
      { provider, filterInstructions, event },
      signal
    );
    const { retryable, retryAfterMs, ...fields } = result;
    Object.assign(decision, fields);
    return { decision, retryable, retryAfterMs };
  }

  private async semanticFilter(
    decision: AgentEvaluationInput,
    input: SemanticFilterInput,
    signal: AbortSignal
  ) {
    if (!(this.ports.isClassifierProven ?? isClassifierProven)(input.provider)) {
      return unprovenProviderDecision(input.provider);
    }
    if (input.filterInstructions.length > MAX_FILTER_INSTRUCTIONS_LENGTH) {
      return filterTooLongDecision();
    }
    if (!this.ports.classifyEvent) {
      return unavailableDecision();
    }
    const outcome = await this.ports
      .classifyEvent(input, signal)
      .catch((): SemanticFilterOutcome => ({ status: 'FAILED', failure: 'FAILED' }));
    if (outcome.classifier) {
      decision.classifier = outcome.classifier;
    }
    return semanticDecision(outcome);
  }

  private async resolveMatch(
    decision: AgentEvaluationInput,
    payload: AgentEventPayload,
    execution: AgentExecutionConfig
  ): Promise<Decided> {
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
          ? evaluationExplanations.executionRetry
          : evaluationExplanations.invalidExecution,
      });
      return { decision, ...classified };
    }
  }
}
function contextFailure(
  reasonCode: 'SLACK_CONTEXT_RETRY' | 'SLACK_CONTEXT_UNAVAILABLE',
  retryable: boolean
): SlackContextOutcome {
  return {
    status: 'FAILED',
    reasonCode,
    explanation: retryable
      ? evaluationExplanations.slackContextRetry
      : evaluationExplanations.slackContextUnavailable,
    retryable,
  };
}
function eventInput(eventId: string, payload: AgentEventPayload) {
  const context =
    payload.provider === 'GITHUB'
      ? [
          { id: `${eventId}:source`, text: githubSourceText(payload), url: payload.sourceUrl },
          { id: `${eventId}:title`, text: payload.issue.title, url: payload.sourceUrl },
          { id: `${eventId}:body`, text: payload.issue.body, url: payload.sourceUrl },
        ]
      : slackMessageItems(eventId, payload);
  return { version: 1 as const, eventId, sourceUrl: payload.sourceUrl, context };
}
/**
 * States where the event came from as task data, ahead of the issue's own text. The label is
 * JSON-quoted so a provider label cannot add lines to this item.
 */
function githubSourceText(payload: Extract<AgentEventPayload, { provider: 'GITHUB' }>) {
  const label = payload.action === 'labeled' && payload.issue.addedLabel;
  return [
    `Repository: ${payload.repositoryFullName}`,
    `Issue: #${payload.issue.number} ${payload.sourceUrl}`,
    `Trigger: ${payload.action}${label ? ` ${JSON.stringify(label)}` : ''}`,
  ].join('\n');
}
