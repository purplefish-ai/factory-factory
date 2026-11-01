import { cryptoService } from '@/backend/services/crypto.service';
import { AgentProposalService } from './service/agent-proposal.service';
import { SlackConnectionService } from './service/slack-connection.service';

export { AgentProposalService } from './service/agent-proposal.service';
export const agentProposalService = new AgentProposalService();

export { SlackConnectionService } from './service/slack-connection.service';
export const slackConnectionService = new SlackConnectionService(cryptoService);

// Durable primitives only; no source listener, activation or execution worker is started.
export {
  ingestEvent,
  finalizeEventOrder,
  recordEvaluation,
  admitRun,
  claimNextRun,
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
