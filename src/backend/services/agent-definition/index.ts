import { cryptoService } from '@/backend/services/crypto.service';
import { AgentProposalService } from './service/agent-proposal.service';
import { SlackConnectionService } from './service/slack-connection.service';

export { AgentProposalService } from './service/agent-proposal.service';
export const agentProposalService = new AgentProposalService();

export { SlackConnectionService } from './service/slack-connection.service';
export const slackConnectionService = new SlackConnectionService(cryptoService);

// Provider listeners and dispatch are not implemented here.
export {
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
