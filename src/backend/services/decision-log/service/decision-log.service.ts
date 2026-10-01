import type { DecisionLog } from '@prisma-gen/client';
import { decisionLogAccessor } from '@/backend/services/decision-log/resources/decision-log.accessor';

class DecisionLogService {
  findByAgentId(agentId: string, limit?: number): Promise<DecisionLog[]> {
    return decisionLogAccessor.findByAgentId(agentId, limit);
  }

  findRecent(limit?: number): Promise<DecisionLog[]> {
    return decisionLogAccessor.findRecent(limit);
  }

  findById(id: string): Promise<DecisionLog | null> {
    return decisionLogAccessor.findById(id);
  }

  list(options: { agentId?: string; limit?: number }): Promise<DecisionLog[]> {
    return decisionLogAccessor.list(options);
  }
}

export const decisionLogService = new DecisionLogService();
