import { agentPromptAccessor } from '@/backend/services/agent-definition/resources/agent-prompt.accessor';
import type { InitialDeliveryOwnerPort } from '@/shared/event-agent-delivery';

/** Owner API for orchestration-injected session observation/fencing ports. */
export const agentInitialDelivery: InitialDeliveryOwnerPort = {
  readFence: (runId, sessionId) => agentPromptAccessor.readFence(runId, sessionId),
  beforeSend: (attempt, source) => agentPromptAccessor.beforeSend(attempt, source),
  outcome: (attempt, outcome) => agentPromptAccessor.outcome(attempt, outcome),
  ambiguous: (attempt) => agentPromptAccessor.ambiguous(attempt),
  stop: (attempt, evidence) => agentPromptAccessor.stop(attempt, evidence),
};
