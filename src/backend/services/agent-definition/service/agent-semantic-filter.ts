import type { z } from 'zod';
import type {
  AgentEvaluationInput,
  AgentEventPayload,
  agentClassifierIdentitySchema,
} from '@/shared/agent-runtime';
import type { SessionProvider } from '@/shared/core/enums';

type ClassifierIdentity = z.infer<typeof agentClassifierIdentitySchema>;

export interface SemanticFilterInput {
  provider: SessionProvider;
  filterInstructions: string;
  /** Untrusted event content; it is classified, never obeyed. */
  event: AgentEventPayload;
}

export type SemanticFilterOutcome =
  | {
      status: 'DECIDED';
      decision: 'match' | 'skip' | 'uncertain';
      classifier: ClassifierIdentity;
    }
  | {
      status: 'FAILED';
      failure: 'TIMEOUT' | 'RATE_LIMITED' | 'MALFORMED' | 'FAILED';
      retryAfterMs?: number;
      classifier?: ClassifierIdentity;
    };

type SemanticDecision = Pick<AgentEvaluationInput, 'status' | 'reasonCode' | 'explanation'> & {
  retryable: boolean;
  retryAfterMs?: number;
};

const decisions: Record<
  'match' | 'skip' | 'uncertain' | 'UNAVAILABLE',
  Omit<SemanticDecision, 'retryable'>
> = {
  match: {
    status: 'MATCHED',
    reasonCode: 'SEMANTIC_FILTER_MATCH',
    explanation: 'The trigger filters and the natural-language filter match.',
  },
  skip: {
    status: 'SKIPPED',
    reasonCode: 'SEMANTIC_FILTER_SKIP',
    explanation: 'The event does not meet the natural-language filter.',
  },
  uncertain: {
    status: 'SKIPPED',
    reasonCode: 'SEMANTIC_FILTER_UNCERTAIN',
    explanation:
      'The classifier could not tell whether the event meets the natural-language filter; uncertain events never start a run.',
  },
  UNAVAILABLE: {
    status: 'SKIPPED',
    reasonCode: 'SEMANTIC_FILTER_UNAVAILABLE',
    explanation: 'Natural-language filtering is not available, so the event was not run.',
  },
};
const failures: Record<
  Extract<SemanticFilterOutcome, { status: 'FAILED' }>['failure'],
  Omit<SemanticDecision, 'status' | 'retryAfterMs'>
> = {
  MALFORMED: {
    reasonCode: 'SEMANTIC_FILTER_MALFORMED',
    explanation: 'The classifier returned invalid output, so the event was not run.',
    retryable: false,
  },
  TIMEOUT: {
    reasonCode: 'SEMANTIC_FILTER_TIMEOUT',
    explanation: 'The classifier timed out; retry is bounded.',
    retryable: true,
  },
  RATE_LIMITED: {
    reasonCode: 'SEMANTIC_FILTER_RATE_LIMITED',
    explanation: 'The classifier provider is rate limited; retry is bounded.',
    retryable: true,
  },
  FAILED: {
    reasonCode: 'SEMANTIC_FILTER_FAILED',
    explanation: 'The classifier could not run; retry is bounded.',
    retryable: true,
  },
};
const providerNames: Record<SessionProvider, string> = { CLAUDE: 'Claude', CODEX: 'Codex' };

export function unprovenProviderDecision(provider: SessionProvider): SemanticDecision {
  return {
    status: 'SKIPPED',
    reasonCode: 'SEMANTIC_FILTER_PROVIDER_UNPROVEN',
    explanation: `This automation now runs with ${providerNames[provider]}, whose natural-language filter classifier has not passed evaluation, so the event was not run.`,
    retryable: false,
  };
}

export function unavailableDecision(): SemanticDecision {
  return { ...decisions.UNAVAILABLE, retryable: false };
}

/** Maps a classifier outcome to a non-dispatching decision unless it clearly matched. */
export function semanticDecision(outcome: SemanticFilterOutcome): SemanticDecision {
  if (outcome.status === 'DECIDED') {
    return { ...decisions[outcome.decision], retryable: false };
  }
  return {
    status: 'ERROR',
    ...failures[outcome.failure],
    ...(failures[outcome.failure].retryable && outcome.retryAfterMs !== undefined
      ? { retryAfterMs: outcome.retryAfterMs }
      : {}),
  };
}
