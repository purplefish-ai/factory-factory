import { eventAgentExecutionSchema } from './event-agent-launch';

/** Frozen launch evidence uses source account identity, never a local operational FK. */
export function validateRecoveryExecution(input: unknown) {
  return eventAgentExecutionSchema.parse(input);
}
