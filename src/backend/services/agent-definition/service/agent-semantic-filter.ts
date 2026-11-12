import type { z } from 'zod';
import {
  evaluationExplanations,
  unprovenProviderExplanation,
} from '@/backend/services/agent-definition/resources/agent-evaluation-explanations';
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
    explanation: evaluationExplanations.semanticMatch,
  },
  skip: {
    status: 'SKIPPED',
    reasonCode: 'SEMANTIC_FILTER_SKIP',
    explanation: evaluationExplanations.semanticSkip,
  },
  uncertain: {
    status: 'SKIPPED',
    reasonCode: 'SEMANTIC_FILTER_UNCERTAIN',
    explanation: evaluationExplanations.semanticUncertain,
  },
  UNAVAILABLE: {
    status: 'SKIPPED',
    reasonCode: 'SEMANTIC_FILTER_UNAVAILABLE',
    explanation: evaluationExplanations.semanticUnavailable,
  },
};
const failures: Record<
  Extract<SemanticFilterOutcome, { status: 'FAILED' }>['failure'],
  Omit<SemanticDecision, 'status' | 'retryAfterMs'>
> = {
  MALFORMED: {
    reasonCode: 'SEMANTIC_FILTER_MALFORMED',
    explanation: evaluationExplanations.semanticMalformed,
    retryable: false,
  },
  TIMEOUT: {
    reasonCode: 'SEMANTIC_FILTER_TIMEOUT',
    explanation: evaluationExplanations.semanticTimeout,
    retryable: true,
  },
  RATE_LIMITED: {
    reasonCode: 'SEMANTIC_FILTER_RATE_LIMITED',
    explanation: evaluationExplanations.semanticRateLimited,
    retryable: true,
  },
  FAILED: {
    reasonCode: 'SEMANTIC_FILTER_FAILED',
    explanation: evaluationExplanations.semanticFailed,
    retryable: true,
  },
};

export function filterTooLongDecision(): SemanticDecision {
  return {
    status: 'ERROR',
    reasonCode: 'SEMANTIC_FILTER_TOO_LONG',
    explanation: evaluationExplanations.filterTooLong,
    retryable: false,
  };
}

export function unprovenProviderDecision(provider: SessionProvider): SemanticDecision {
  return {
    status: 'SKIPPED',
    reasonCode: 'SEMANTIC_FILTER_PROVIDER_UNPROVEN',
    explanation: unprovenProviderExplanation(provider),
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
