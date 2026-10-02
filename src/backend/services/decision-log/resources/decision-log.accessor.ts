import type { DecisionLog } from '@prisma-gen/client';
import { prisma } from '@/backend/db';

class DecisionLogAccessor {
  findById(id: string): Promise<DecisionLog | null> {
    return prisma.decisionLog.findUnique({
      where: { id },
    });
  }

  findByAgentId(agentId: string, limit = 50): Promise<DecisionLog[]> {
    return prisma.decisionLog.findMany({
      where: { agentId },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  findRecent(limit = 100): Promise<DecisionLog[]> {
    return prisma.decisionLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
    });
  }

  delete(id: string): Promise<DecisionLog> {
    return prisma.decisionLog.delete({
      where: { id },
    });
  }

  /**
   * List decision logs with optional filters
   */
  list(options: { agentId?: string; limit?: number }): Promise<DecisionLog[]> {
    const { agentId, limit = 100 } = options;

    if (agentId) {
      return this.findByAgentId(agentId, limit);
    }
    return this.findRecent(limit);
  }
}

export const decisionLogAccessor = new DecisionLogAccessor();
