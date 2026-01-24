import type { Agent, Prisma } from '@prisma-gen/client';
import { AgentState, AgentType } from '@prisma-gen/client';
import { prisma } from '../db.js';
import { taskAccessor } from './task.accessor.js';

interface CreateAgentInput {
  type: AgentType;
  state?: AgentState;
  currentTaskId?: string;
  tmuxSessionName?: string;
}

interface UpdateAgentInput {
  state?: AgentState;
  currentTaskId?: string | null;
  tmuxSessionName?: string | null;
  sessionId?: string | null;
  lastActiveAt?: Date;
}

interface ListAgentsFilters {
  type?: AgentType;
  state?: AgentState;
  projectId?: string;
  limit?: number;
  offset?: number;
}

class AgentAccessor {
  create(data: CreateAgentInput): Promise<Agent> {
    return prisma.agent.create({
      data: {
        type: data.type,
        state: data.state ?? AgentState.IDLE,
        currentTaskId: data.currentTaskId,
        tmuxSessionName: data.tmuxSessionName,
      },
    });
  }

  findById(id: string): Promise<Agent | null> {
    return prisma.agent.findUnique({
      where: { id },
      include: {
        currentTask: true,
        assignedTasks: true,
        mailReceived: {
          where: { isRead: false },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  update(id: string, data: UpdateAgentInput): Promise<Agent> {
    return prisma.agent.update({
      where: { id },
      data,
    });
  }

  list(filters?: ListAgentsFilters): Promise<Agent[]> {
    const where: Prisma.AgentWhereInput = {};

    if (filters?.type) {
      where.type = filters.type;
    }
    if (filters?.state) {
      where.state = filters.state;
    }
    // Filter by project via currentTask → projectId
    if (filters?.projectId) {
      where.currentTask = {
        projectId: filters.projectId,
      };
    }

    return prisma.agent.findMany({
      where,
      take: filters?.limit,
      skip: filters?.offset,
      orderBy: { createdAt: 'desc' },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  findByType(type: AgentType): Promise<Agent[]> {
    return prisma.agent.findMany({
      where: { type },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Find agent by their current task ID
   * Works for both supervisors (top-level tasks) and workers (leaf tasks)
   */
  findByTaskId(taskId: string): Promise<Agent | null> {
    return prisma.agent.findFirst({
      where: { currentTaskId: taskId },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Find supervisor for a top-level task
   * (Alias for findByTaskId for semantic clarity)
   */
  findSupervisorByTopLevelTaskId(taskId: string): Promise<Agent | null> {
    return prisma.agent.findFirst({
      where: {
        currentTaskId: taskId,
        type: AgentType.SUPERVISOR,
      },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  delete(id: string): Promise<Agent> {
    return prisma.agent.delete({
      where: { id },
    });
  }

  /**
   * Update an agent's heartbeat (lastActiveAt) to now
   */
  updateHeartbeat(id: string): Promise<Agent> {
    return prisma.agent.update({
      where: { id },
      data: { lastActiveAt: new Date() },
    });
  }

  /**
   * Get agents whose last heartbeat is older than the specified number of minutes
   */
  getAgentsSinceHeartbeat(minutes: number): Promise<Agent[]> {
    const threshold = new Date(Date.now() - minutes * 60 * 1000);
    return prisma.agent.findMany({
      where: {
        lastActiveAt: {
          lt: threshold,
        },
      },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Get healthy agents of a specific type (heartbeat within threshold)
   */
  getHealthyAgents(type: AgentType, minutes: number): Promise<Agent[]> {
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
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Get unhealthy agents of a specific type (heartbeat older than threshold)
   */
  getUnhealthyAgents(type: AgentType, minutes: number): Promise<Agent[]> {
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
        currentTask: true,
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
        currentTask: true,
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
   * Find all workers for a specific top-level task (formerly "epic")
   * Workers are assigned to leaf tasks that are descendants of the top-level task
   * Supports arbitrary nesting depth by getting all descendant task IDs first
   */
  async findWorkersByTopLevelTaskId(topLevelTaskId: string): Promise<Agent[]> {
    // Get all descendant tasks (supports arbitrary nesting)
    const descendants = await taskAccessor.getDescendants(topLevelTaskId);
    const descendantIds = descendants.map((t) => t.id);

    if (descendantIds.length === 0) {
      return [];
    }

    return prisma.agent.findMany({
      where: {
        type: AgentType.WORKER,
        assignedTasks: {
          some: {
            id: { in: descendantIds },
          },
        },
      },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Find all agents (workers and supervisors) for a specific top-level task
   * Supports arbitrary nesting depth by getting all descendant task IDs first
   */
  async findAgentsByTopLevelTaskId(topLevelTaskId: string): Promise<Agent[]> {
    // Get all descendant tasks (supports arbitrary nesting)
    const descendants = await taskAccessor.getDescendants(topLevelTaskId);
    const descendantIds = descendants.map((t) => t.id);

    return prisma.agent.findMany({
      where: {
        OR: [
          // Workers assigned to tasks under this top-level task
          ...(descendantIds.length > 0
            ? [
                {
                  type: AgentType.WORKER,
                  assignedTasks: {
                    some: {
                      id: { in: descendantIds },
                    },
                  },
                },
              ]
            : []),
          // Supervisor managing this top-level task
          {
            type: AgentType.SUPERVISOR,
            currentTaskId: topLevelTaskId,
          },
        ],
      },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Find the supervisor for a specific top-level task (returns single agent or null)
   */
  findByTopLevelTaskId(topLevelTaskId: string): Promise<Agent | null> {
    return prisma.agent.findFirst({
      where: {
        type: AgentType.SUPERVISOR,
        currentTaskId: topLevelTaskId,
      },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }
}

export const agentAccessor = new AgentAccessor();
