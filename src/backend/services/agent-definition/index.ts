import { cryptoService } from '@/backend/services/crypto.service';
import { AgentProposalService } from './service/agent-proposal.service';
import { SlackConnectionService } from './service/slack-connection.service';

export { AgentProposalService } from './service/agent-proposal.service';
export { AgentSourcePollService } from './service/agent-source-poll.service';
export const agentProposalService = new AgentProposalService();

export { SlackConnectionService } from './service/slack-connection.service';
export const slackConnectionService = new SlackConnectionService(cryptoService);

// Durable primitives and injectable source intake; no activation or execution worker starts here.
export {
  ingestEvent,
  finalizeEventOrder,
  recordEvaluation,
  admitRun,
  claimNextRun,
  maintainQueue,
} from './service/agent-runtime.service';
export * from '@/shared/agent-runtime';
export {
  agentActivationGenerationSchema,
  agentDefinitionRevisionSchema,
  agentTriggerRevisionSchema,
  agentConnectionInputSchema,
  agentConnectionProviderSchema,
  agentDefinitionInputSchema,
  agentExecutionConfigSchema,
  agentRunInputSchema,
  agentRunStatusSchema,
  agentTriggerInputSchema,
  agentTriggerTypeSchema,
  type AgentConnectionInput,
  type AgentDefinitionInput,
  type AgentRunInput,
  type AgentTriggerInput,
} from '@/shared/schemas/agent-definition.schema';

export { matchAgentEvent } from './service/agent-event-matcher';
export {
  AgentEventEvaluationService,
  type AgentEvaluationPorts,
} from './service/agent-event-evaluation.service';
