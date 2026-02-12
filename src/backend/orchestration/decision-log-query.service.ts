import type { DecisionLog } from '@prisma-gen/client';
import { decisionLogAccessor } from '@/backend/resource_accessors/decision-log.accessor';

class DecisionLogQueryService {
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

  createAutomatic(
    agentId: string,
    toolName: string,
    type: 'invocation' | 'result' | 'error',
    data: unknown
  ): Promise<DecisionLog> {
    return decisionLogAccessor.createAutomatic(agentId, toolName, type, data);
  }

  createManual(
    agentId: string,
    title: string,
    body: string,
    context?: string
  ): Promise<DecisionLog> {
    return decisionLogAccessor.createManual(agentId, title, body, context);
  }
}

export const decisionLogQueryService = new DecisionLogQueryService();
