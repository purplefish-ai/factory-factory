import type { Agent, Prisma } from '@prisma-gen/client';
import { AgentState, AgentType } from '@prisma-gen/client';
import { prisma } from '../db';

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

  /**
   * Update an agent's heartbeat (lastActiveAt) to now
   */
  async updateHeartbeat(id: string): Promise<Agent> {
    return prisma.agent.update({
      where: { id },
      data: { lastActiveAt: new Date() },
    });
  }

  /**
   * Get agents whose last heartbeat is older than the specified number of minutes
   */
  async getAgentsSinceHeartbeat(minutes: number): Promise<Agent[]> {
    const threshold = new Date(Date.now() - minutes * 60 * 1000);
    return prisma.agent.findMany({
      where: {
        lastActiveAt: {
          lt: threshold,
        },
      },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Get healthy agents of a specific type (heartbeat within threshold)
   */
  async getHealthyAgents(type: AgentType, minutes: number): Promise<Agent[]> {
    const threshold = new Date(Date.now() - minutes * 60 * 1000);
    return prisma.agent.findMany({
      where: {
        type,
        lastActiveAt: {
          gte: threshold,
        },
        state: {
          not: AgentState.FAILED,
        },
      },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Get unhealthy agents of a specific type (heartbeat older than threshold)
   */
  async getUnhealthyAgents(type: AgentType, minutes: number): Promise<Agent[]> {
    const threshold = new Date(Date.now() - minutes * 60 * 1000);
    return prisma.agent.findMany({
      where: {
        type,
        OR: [
          {
            lastActiveAt: {
              lt: threshold,
            },
          },
          {
            state: AgentState.FAILED,
          },
        ],
      },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Get all agents of a specific type with their health status
   */
  async getAgentsWithHealthStatus(
    type: AgentType,
    healthThresholdMinutes: number
  ): Promise<Array<Agent & { isHealthy: boolean; minutesSinceHeartbeat: number }>> {
    const agents = await prisma.agent.findMany({
      where: { type },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });

    const now = Date.now();
    return agents.map((agent) => {
      const minutesSinceHeartbeat = Math.floor((now - agent.lastActiveAt.getTime()) / (60 * 1000));
      const isHealthy =
        minutesSinceHeartbeat < healthThresholdMinutes && agent.state !== AgentState.FAILED;
      return {
        ...agent,
        isHealthy,
        minutesSinceHeartbeat,
      };
    });
  }

  /**
   * Find agent by task ID (for workers)
   */
  async findByTaskId(taskId: string): Promise<Agent | null> {
    return prisma.agent.findFirst({
      where: { currentTaskId: taskId },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Find all workers for a specific epic
   */
  async findWorkersByEpicId(epicId: string): Promise<Agent[]> {
    return prisma.agent.findMany({
      where: {
        type: AgentType.WORKER,
        assignedTasks: {
          some: {
            epicId,
          },
        },
      },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Find all agents for a specific epic (workers and supervisors)
   */
  async findAgentsByEpicId(epicId: string): Promise<Agent[]> {
    return prisma.agent.findMany({
      where: {
        OR: [
          // Workers assigned to tasks in this epic
          {
            type: AgentType.WORKER,
            assignedTasks: {
              some: {
                epicId,
              },
            },
          },
          // Supervisor orchestrating this epic
          {
            type: AgentType.SUPERVISOR,
            currentEpicId: epicId,
          },
        ],
      },
      include: {
        currentEpic: true,
        assignedTasks: true,
      },
    });
  }
}

export const agentAccessor = new AgentAccessor();
