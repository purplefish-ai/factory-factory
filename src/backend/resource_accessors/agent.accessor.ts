import { prisma } from '../db';
import { Agent, AgentType, AgentState, Prisma } from '@prisma/client';

export interface CreateAgentInput {
  type: AgentType;
  state?: AgentState;
  currentEpicId?: string;
  currentTaskId?: string;
  tmuxSessionName?: string;
}

export interface UpdateAgentInput {
  state?: AgentState;
  currentEpicId?: string | null;
  currentTaskId?: string | null;
  tmuxSessionName?: string | null;
  sessionId?: string | null;
  lastActiveAt?: Date;
}

export interface ListAgentsFilters {
  type?: AgentType;
  state?: AgentState;
  limit?: number;
  offset?: number;
}

export class AgentAccessor {
  async create(data: CreateAgentInput): Promise<Agent> {
    return prisma.agent.create({
      data: {
        type: data.type,
        state: data.state ?? AgentState.IDLE,
        currentEpicId: data.currentEpicId,
        currentTaskId: data.currentTaskId,
        tmuxSessionName: data.tmuxSessionName,
      },
    });
  }

  async findById(id: string): Promise<Agent | null> {
    return prisma.agent.findUnique({
      where: { id },
      include: {
        currentEpic: true,
        assignedTasks: true,
        mailReceived: {
          where: { isRead: false },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  async update(id: string, data: UpdateAgentInput): Promise<Agent> {
    return prisma.agent.update({
      where: { id },
      data,
    });
  }

  async list(filters?: ListAgentsFilters): Promise<Agent[]> {
    const where: Prisma.AgentWhereInput = {};

    if (filters?.type) {
      where.type = filters.type;
    }
    if (filters?.state) {
      where.state = filters.state;
    }

    return prisma.agent.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { createdAt: 'desc' },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });
  }

  async findByType(type: AgentType): Promise<Agent[]> {
    return prisma.agent.findMany({
      where: { type },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });
  }

  async findByEpicId(epicId: string): Promise<Agent | null> {
    return prisma.agent.findFirst({
      where: { currentEpicId: epicId },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });
  }

  async delete(id: string): Promise<Agent> {
    return prisma.agent.delete({
      where: { id },
    });
  }
}

export const agentAccessor = new AgentAccessor();
