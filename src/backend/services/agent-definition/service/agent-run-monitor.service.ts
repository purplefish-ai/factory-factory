import { agentRunSettlementAccessor } from '@/backend/services/agent-definition/resources/agent-run-settlement.accessor';

export class AgentRunMonitorService {
  observeRun(...input: Parameters<typeof agentRunSettlementAccessor.observe>) {
    return agentRunSettlementAccessor.observe(...input);
  }
}
