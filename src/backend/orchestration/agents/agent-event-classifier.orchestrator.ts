import type { AgentEvaluationPorts } from '@/backend/services/agent-definition';
import { AgentEventClassificationError, classifyAgentEvent } from '@/backend/services/session';

type ClassifyEvent = NonNullable<AgentEvaluationPorts['classifyEvent']>;

/**
 * Adapts the session capsule's disposable classifier to the evaluation port.
 * The classifier's reason text is dropped: evaluations persist only the
 * decision, classifier identity and input hash.
 */
export function createEventClassifierPort(
  classify: typeof classifyAgentEvent = classifyAgentEvent
): ClassifyEvent {
  return async ({ provider, filterInstructions, event }, signal) => {
    try {
      const result = await classify(
        // No account is bound before admission; Codex uses the default account.
        { provider, accountId: null, filterInstructions, eventContext: event },
        signal
      );
      return { status: 'DECIDED', decision: result.decision, classifier: result.classifier };
    } catch (error) {
      if (error instanceof AgentEventClassificationError) {
        return {
          status: 'FAILED',
          failure: error.code,
          classifier: error.classifier,
          ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        };
      }
      return { status: 'FAILED', failure: 'FAILED' };
    }
  };
}
