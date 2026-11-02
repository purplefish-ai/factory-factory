import { agentRunRecoveryAccessor } from '@/backend/services/agent-definition/resources/agent-run-recovery.accessor';

/** Transport-neutral capabilities; orchestration supplies actual owner proof. */
export const eventRunRecovery = {
  inspect(...input: Parameters<typeof agentRunRecoveryAccessor.inspect>) {
    return agentRunRecoveryAccessor.inspect(...input);
  },
  resolve(...input: Parameters<typeof agentRunRecoveryAccessor.resolve>) {
    return agentRunRecoveryAccessor.resolve(...input);
  },
};
