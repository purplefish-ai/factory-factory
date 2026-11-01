import { agentEvaluationAccessor } from '@/backend/services/agent-definition/resources/agent-evaluation.accessor';
import { agentEventAccessor } from '@/backend/services/agent-definition/resources/agent-event.accessor';
import { agentRunClaimAccessor } from '@/backend/services/agent-definition/resources/agent-run-claim.accessor';
import { agentRunAccessor } from '@/backend/services/agent-definition/resources/agent-run.accessor';
import { agentSourceAccessor } from '@/backend/services/agent-definition/resources/agent-source.accessor';
import type {
  AgentAdmissionInput,
  AgentEvaluationInput,
  AgentEventInput,
  AgentEventOrderInput,
} from '@/shared/agent-runtime';

export function ingestEvent(input: AgentEventInput) {
  return agentEventAccessor.ingestEvent(input);
}
export function finalizeEventOrder(input: AgentEventOrderInput) {
  return agentSourceAccessor.finalizeEventOrder(input);
}
export function recordEvaluation(input: AgentEvaluationInput) {
  return agentEvaluationAccessor.recordEvaluation(input);
}
export function admitRun(input: AgentAdmissionInput) {
  return agentRunAccessor.admitRun(input);
}
export function claimNextRun(now = new Date()) {
  return agentRunClaimAccessor.claimNextRun(now);
}

export function maintainQueue(now = new Date()) {
  return agentRunClaimAccessor.maintainQueue(now);
}
