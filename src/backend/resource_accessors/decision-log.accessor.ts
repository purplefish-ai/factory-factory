import type { DecisionLog } from '@prisma/client';
import { prisma } from '../db';

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

  /**
   * Create an automatic decision log entry for MCP tool calls
   */
  async createAutomatic(
    agentId: string,
    toolName: string,
    type: 'invocation' | 'result' | 'error',
    data: unknown
  ): Promise<DecisionLog> {
    let decision: string;
    let reasoning: string;
    let context: string;

    switch (type) {
      case 'invocation':
        decision = `Invoked tool: ${toolName}`;
        reasoning = 'Automatic tool invocation log';
        context = JSON.stringify(data, null, 2);
        break;
      case 'result':
        decision = `Tool result: ${toolName}`;
        reasoning = 'Automatic tool result log';
        context = JSON.stringify(data, null, 2);
        break;
      case 'error':
        decision = `Tool error: ${toolName}`;
        reasoning = 'Automatic tool error log';
        context = JSON.stringify(data, null, 2);
        break;
    }

    return this.create({
      agentId,
      decision,
      reasoning,
      context,
    });
  }

  /**
   * Create a manual decision log entry for business logic
   */
  async createManual(
    agentId: string,
    title: string,
    body: string,
    context?: string
  ): Promise<DecisionLog> {
    return this.create({
      agentId,
      decision: title,
      reasoning: body,
      context,
    });
  }

  /**
   * Get recent logs for a specific agent
   */
  async findByAgentIdRecent(agentId: string, limit = 50): Promise<DecisionLog[]> {
    return this.findByAgentId(agentId, limit);
  }

  /**
   * Get recent logs across all agents
   */
  async findAllRecent(limit = 100): Promise<DecisionLog[]> {
    return this.findRecent(limit);
  }

  /**
   * List decision logs with optional filters
   */
  async list(options: { agentId?: string; limit?: number }): Promise<DecisionLog[]> {
    const { agentId, limit = 100 } = options;

    if (agentId) {
      return this.findByAgentId(agentId, limit);
    }
    return this.findRecent(limit);
  }
}

export const decisionLogAccessor = new DecisionLogAccessor();
