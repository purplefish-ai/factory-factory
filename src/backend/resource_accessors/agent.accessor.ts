import type { Agent, Prisma } from '@prisma-gen/client';
import { AgentType, DesiredExecutionState, ExecutionState } from '@prisma-gen/client';
import { prisma } from '../db.js';
import { taskAccessor } from './task.accessor.js';

interface CreateAgentInput {
  type: AgentType;
  currentTaskId?: string;
  tmuxSessionName?: string;
  sessionId?: string;
  executionState?: ExecutionState;
  desiredExecutionState?: DesiredExecutionState;
}

interface UpdateAgentInput {
  currentTaskId?: string | null;
  tmuxSessionName?: string | null;
  sessionId?: string | null;
  executionState?: ExecutionState;
  desiredExecutionState?: DesiredExecutionState;
  lastHeartbeat?: Date | null;
  lastReconcileAt?: Date;
  reconcileFailures?: Prisma.InputJsonValue;
}

interface ListAgentsFilters {
  type?: AgentType;
  executionState?: ExecutionState;
  desiredExecutionState?: DesiredExecutionState;
  projectId?: string;
  limit?: number;
  offset?: number;
}

class AgentAccessor {
  create(data: CreateAgentInput): Promise<Agent> {
    return prisma.agent.create({
      data: {
        type: data.type,
        currentTaskId: data.currentTaskId,
        tmuxSessionName: data.tmuxSessionName,
        sessionId: data.sessionId,
        executionState: data.executionState ?? ExecutionState.IDLE,
        desiredExecutionState: data.desiredExecutionState ?? DesiredExecutionState.IDLE,
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
    if (filters?.executionState) {
      where.executionState = filters.executionState;
    }
    if (filters?.desiredExecutionState) {
      where.desiredExecutionState = filters.desiredExecutionState;
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
   * Update an agent's heartbeat to now
   */
  updateHeartbeat(id: string): Promise<Agent> {
    return prisma.agent.update({
      where: { id },
      data: { lastHeartbeat: new Date() },
    });
  }

  /**
   * Get agents whose last heartbeat is older than the specified number of minutes
   */
  getAgentsSinceHeartbeat(minutes: number): Promise<Agent[]> {
    const threshold = new Date(Date.now() - minutes * 60 * 1000);
    return prisma.agent.findMany({
      where: {
        lastHeartbeat: {
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
   * Get healthy agents of a specific type (heartbeat within threshold and not crashed)
   */
  getHealthyAgents(type: AgentType, minutes: number): Promise<Agent[]> {
    const threshold = new Date(Date.now() - minutes * 60 * 1000);
    return prisma.agent.findMany({
      where: {
        type,
        lastHeartbeat: {
          gte: threshold,
        },
        executionState: {
          not: ExecutionState.CRASHED,
        },
      },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Get unhealthy agents of a specific type (heartbeat older than threshold or crashed)
   */
  getUnhealthyAgents(type: AgentType, minutes: number): Promise<Agent[]> {
    const threshold = new Date(Date.now() - minutes * 60 * 1000);
    return prisma.agent.findMany({
      where: {
        type,
        OR: [
          {
            lastHeartbeat: {
              lt: threshold,
            },
          },
          {
            executionState: ExecutionState.CRASHED,
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
      const heartbeat = agent.lastHeartbeat ?? agent.createdAt;
      const minutesSinceHeartbeat = Math.floor((now - heartbeat.getTime()) / (60 * 1000));
      const isHealthy =
        minutesSinceHeartbeat < healthThresholdMinutes &&
        agent.executionState !== ExecutionState.CRASHED;
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

  // ============================================================================
  // Reconciliation-related methods
  // ============================================================================

  /**
   * Find agents that need reconciliation:
   * - Agents where executionState !== desiredExecutionState
   * - Or agents that haven't been reconciled recently
   */
  async findAgentsNeedingReconciliation(staleMinutes = 5): Promise<Agent[]> {
    const staleThreshold = new Date(Date.now() - staleMinutes * 60 * 1000);

    return await prisma.agent.findMany({
      where: {
        OR: [
          // Agents where actual state differs from desired state
          {
            AND: [
              { desiredExecutionState: DesiredExecutionState.ACTIVE },
              { executionState: { not: ExecutionState.ACTIVE } },
            ],
          },
          {
            AND: [
              { desiredExecutionState: DesiredExecutionState.IDLE },
              { executionState: { not: ExecutionState.IDLE } },
            ],
          },
          {
            AND: [
              { desiredExecutionState: DesiredExecutionState.PAUSED },
              { executionState: { not: ExecutionState.PAUSED } },
            ],
          },
          // Agents that haven't been reconciled recently
          {
            lastReconcileAt: {
              lt: staleThreshold,
            },
          },
          // Agents that have never been reconciled
          {
            lastReconcileAt: null,
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
   * Find agents that should be active but appear crashed
   * (desired ACTIVE but heartbeat is stale)
   */
  async findPotentiallyCrashedAgents(heartbeatThresholdMinutes: number): Promise<Agent[]> {
    const threshold = new Date(Date.now() - heartbeatThresholdMinutes * 60 * 1000);

    return await prisma.agent.findMany({
      where: {
        desiredExecutionState: DesiredExecutionState.ACTIVE,
        executionState: ExecutionState.ACTIVE, // We think it's active
        OR: [
          { lastHeartbeat: { lt: threshold } },
          { lastHeartbeat: null }, // Never sent a heartbeat
        ],
      },
      include: {
        currentTask: true,
        assignedTasks: true,
      },
    });
  }

  /**
   * Mark an agent as crashed
   */
  markAsCrashed(id: string): Promise<Agent> {
    return prisma.agent.update({
      where: { id },
      data: {
        executionState: ExecutionState.CRASHED,
        lastReconcileAt: new Date(),
      },
    });
  }

  /**
   * Update reconciliation timestamp
   */
  markReconciled(id: string): Promise<Agent> {
    return prisma.agent.update({
      where: { id },
      data: { lastReconcileAt: new Date() },
    });
  }

  /**
   * Record a reconciliation failure
   */
  async recordReconcileFailure(id: string, error: string, action: string): Promise<Agent> {
    const agent = await prisma.agent.findUnique({ where: { id } });
    const existingFailures = (agent?.reconcileFailures as unknown[]) ?? [];
    const newFailure = {
      timestamp: new Date().toISOString(),
      error,
      action,
    };

    // Keep last 10 failures
    const failures = [...existingFailures, newFailure].slice(-10) as object[];

    return prisma.agent.update({
      where: { id },
      data: {
        reconcileFailures: failures,
        lastReconcileAt: new Date(),
      },
    });
  }
}

export const agentAccessor = new AgentAccessor();
