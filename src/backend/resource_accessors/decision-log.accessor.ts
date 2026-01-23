import { prisma } from '../db';
import { DecisionLog } from '@prisma/client';

export interface CreateDecisionLogInput {
  agentId: string;
  decision: string;
  reasoning: string;
  context?: string;
}

export class DecisionLogAccessor {
  async create(data: CreateDecisionLogInput): Promise<DecisionLog> {
    return prisma.decisionLog.create({
      data: {
        agentId: data.agentId,
        decision: data.decision,
        reasoning: data.reasoning,
        context: data.context,
      },
    });
  }

  async findById(id: string): Promise<DecisionLog | null> {
    return prisma.decisionLog.findUnique({
      where: { id },
      include: {
        agent: true,
      },
    });
  }

  async findByAgentId(agentId: string, limit = 50): Promise<DecisionLog[]> {
    return prisma.decisionLog.findMany({
      where: { agentId },
      orderBy: { timestamp: 'desc' },
      take: limit,
      include: {
        agent: true,
      },
    });
  }

  async findRecent(limit = 100): Promise<DecisionLog[]> {
    return prisma.decisionLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
      include: {
        agent: true,
      },
    });
  }

  async delete(id: string): Promise<DecisionLog> {
    return prisma.decisionLog.delete({
      where: { id },
    });
  }
}

export const decisionLogAccessor = new DecisionLogAccessor();
