import {
  agentExecutionBindingAccessor,
  type EventLaunchClaim,
  type FreezeEventExecutionInput,
} from '@/backend/services/agent-definition/resources/agent-execution-binding.accessor';

export type {
  EventLaunchClaim,
  FreezeEventExecutionInput,
} from '@/backend/services/agent-definition/resources/agent-execution-binding.accessor';
/** Read before account selection; an existing binding must always use its exact account. */
export function readEventExecutionBinding(claim: EventLaunchClaim) {
  return agentExecutionBindingAccessor.read(claim);
}
/** Call inside the selected account's reservation, before creating the reserved session. */
export function freezeEventExecution(input: FreezeEventExecutionInput) {
  return agentExecutionBindingAccessor.freeze(input);
}
