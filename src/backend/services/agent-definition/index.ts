import { cryptoService } from '@/backend/services/crypto.service';
import { AgentManagementService } from './service/agent-management.service';
import { AgentProposalService } from './service/agent-proposal.service';
import { SlackConnectionService } from './service/slack-connection.service';

export { AgentProposalService } from './service/agent-proposal.service';
export { AgentSourcePollService } from './service/agent-source-poll.service';
export { AgentActivationService } from './service/agent-activation.service';
export {
  SlackEventSource,
  type SlackSocket,
  type SlackSocketHandlers,
} from './service/slack-event-source';
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
export {
  agentActivationBoundarySchema,
  agentActivationStateSchema,
  agentAdmissionInputSchema,
  agentAdmissionResultSchema,
  agentClaimResultSchema,
  agentClassifierIdentitySchema,
  agentDeliveryStateSchema,
  agentEvaluationFailureSnapshotSchema,
  agentEvaluationInputSchema,
  agentEvaluationResultSchema,
  agentEvaluationSnapshotSchema,
  agentEvaluationStatusSchema,
  agentEventInputSchema,
  agentEventOrderInputSchema,
  agentEventPayloadSchema,
  agentGithubExecutableActions,
  agentGithubPendingActivationSchema,
  agentInitialDeliverySchema,
  agentLaunchPhaseSchema,
  agentPendingActivationSchema,
  agentResolvedExecutionConfigSchema,
  agentRunResultSchema,
  agentRuntimeReasonSchema,
  agentSlackPendingActivationSchema,
  agentSlackVerificationCodeSchema,
  agentSourceCursorSchema,
  agentSourceHealthSchema,
  agentSourceOrderSchema,
  isAgentGithubExecutableAction,
} from '@/shared/agent-runtime';
export type {
  AdmissionResult,
  AgentActivationBoundary,
  AgentAdmissionInput,
  AgentClaimResult,
  AgentEvaluationInput,
  AgentEvaluationResult,
  AgentEventInput,
  AgentEventOrderInput,
  AgentEventPayload,
  AgentExecutionConfig,
  AgentGithubPendingActivation,
  AgentResolvedExecutionConfig,
  AgentRuntimeReason,
  AgentSlackPendingActivation,
} from '@/shared/agent-runtime';
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

export {
  readEventExecutionBinding,
  freezeEventExecution,
  type EventLaunchClaim,
  type FreezeEventExecutionInput,
} from './service/agent-execution-binding.service';
export { agentInitialDelivery } from './service/agent-initial-delivery.service';
export { eventRunLaunch } from './service/agent-launch.service';
export { AgentRunMonitorService } from './service/agent-run-monitor.service';
export { eventRunRecovery } from './service/agent-run-recovery.service';
export { eventRunResults } from './service/agent-run-results.service';
export { AgentLedgerRetentionService } from './service/agent-ledger-retention.service';
export { AgentManagementService } from './service/agent-management.service';
export {
  triggerCapability,
  type SlackIntakeReadiness,
} from './service/agent-management-projection';

export const agentManagementService = new AgentManagementService();
export { workspaceRetryAuthorityService } from './service/workspace-retry-authority.service';

export {
  exportAutomationDefinitionsRecovery,
  planAutomationDefinitionsRecovery,
  restoreAutomationDefinitionsRecovery,
} from './service/agent-definition-recovery';

export {
  exportSlackConnectionsRecovery,
  planSlackConnectionsRecovery,
  restoreSlackConnectionsRecovery,
} from './service/slack-connection-recovery';
