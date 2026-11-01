import type {
  AgentAdmissionInput,
  AgentEvaluationInput,
  AgentEventInput,
  AgentEventOrderInput,
} from '@/shared/agent-runtime';
import { agentEvaluationAccessor } from '../resources/agent-evaluation.accessor';
import { agentEventAccessor } from '../resources/agent-event.accessor';
import { agentRunClaimAccessor } from '../resources/agent-run-claim.accessor';
import { agentRunAccessor } from '../resources/agent-run.accessor';

export function ingestEvent(input: AgentEventInput) {
  return agentEventAccessor.ingestEvent(input);
}
export function finalizeEventOrder(input: AgentEventOrderInput) {
  return agentEventAccessor.finalizeEventOrder(input);
}
export function recordEvaluation(input: AgentEvaluationInput) {
  return agentEvaluationAccessor.recordEvaluation(input);
}
export function admitRun(input: AgentAdmissionInput) {
  return agentRunAccessor.admitRun(input);
}
export function claimNextRun() {
  return agentRunClaimAccessor.claimNextRun();
}
