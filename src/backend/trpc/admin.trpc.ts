/**
 * Admin tRPC Router
 *
 * Provides admin operations for managing agents, tasks, epics, and system health.
 */

import type { DecisionLog } from '@prisma-gen/client';
import { AgentState, AgentType, EpicState, TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import { killSupervisorAndCleanup, recreateSupervisor } from '../agents/supervisor/lifecycle.js';
import { killWorkerAndCleanup } from '../agents/worker/lifecycle.js';
import {
  agentAccessor,
  decisionLogAccessor,
  epicAccessor,
  taskAccessor,
} from '../resource_accessors/index.js';
import {
  configService,
  crashRecoveryService,
  createLogger,
  rateLimiter,
  worktreeService,
} from '../services/index.js';
import { publicProcedure, router } from './trpc.js';

const logger = createLogger('admin-trpc');

export const adminRouter = router({
  /**
   * Kill an agent (worker or supervisor)
   */
  killAgent: publicProcedure
    .input(
      z.object({
        agentId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const agent = await agentAccessor.findById(input.agentId);
      if (!agent) {
        throw new Error(`Agent ${input.agentId} not found`);
      }

      logger.info('Killing agent', { agentId: input.agentId, type: agent.type });

      try {
        if (agent.type === AgentType.WORKER) {
          await killWorkerAndCleanup(input.agentId);
        } else if (agent.type === AgentType.SUPERVISOR) {
          await killSupervisorAndCleanup(input.agentId);
        } else {
          // Orchestrator - just mark as failed
          await agentAccessor.update(input.agentId, {
            state: AgentState.FAILED,
          });
        }

        return {
          success: true,
          message: `Agent ${input.agentId} killed successfully`,
        };
      } catch (error) {
        logger.error('Failed to kill agent', error as Error, {
          agentId: input.agentId,
        });
        throw error;
      }
    }),

  /**
   * Restart an agent (recreate supervisor or reset task for worker)
   */
  restartAgent: publicProcedure
    .input(
      z.object({
        agentId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const agent = await agentAccessor.findById(input.agentId);
      if (!agent) {
        throw new Error(`Agent ${input.agentId} not found`);
      }

      logger.info('Restarting agent', { agentId: input.agentId, type: agent.type });

      if (agent.type === AgentType.SUPERVISOR && agent.currentEpicId) {
        const newAgentId = await recreateSupervisor(agent.currentEpicId);
        return {
          success: true,
          newAgentId,
          message: `Supervisor recreated with ID ${newAgentId}`,
        };
      } else if (agent.type === AgentType.WORKER) {
        // Find the task this worker was assigned to
        const tasks = await taskAccessor.list({});
        const task = tasks.find((t) => t.assignedAgentId === input.agentId);

        if (task) {
          // Reset task to pending
          await taskAccessor.update(task.id, {
            state: TaskState.PENDING,
            assignedAgentId: null,
          });

          await agentAccessor.update(input.agentId, {
            state: AgentState.FAILED,
          });

          return {
            success: true,
            message: `Task ${task.id} reset for new worker`,
          };
        }
      }

      throw new Error(`Cannot restart agent of type ${agent.type}`);
    }),

  /**
   * Cleanup orphaned worktrees
   */
  cleanupWorktrees: publicProcedure.mutation(async () => {
    logger.info('Cleaning up orphaned worktrees');

    const result = await worktreeService.cleanupOrphanedWorktrees(true);

    return {
      success: true,
      cleaned: result.cleaned,
      failed: result.failed,
      details: result.details,
    };
  }),

  /**
   * Reset a task to PENDING state
   */
  resetTask: publicProcedure
    .input(
      z.object({
        taskId: z.string(),
        clearAttempts: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const task = await taskAccessor.findById(input.taskId);
      if (!task) {
        throw new Error(`Task ${input.taskId} not found`);
      }

      logger.info('Resetting task', { taskId: input.taskId });

      // If task has an assigned agent, mark it as failed
      if (task.assignedAgentId) {
        await agentAccessor.update(task.assignedAgentId, {
          state: AgentState.FAILED,
        });
      }

      await taskAccessor.update(input.taskId, {
        state: TaskState.PENDING,
        assignedAgentId: null,
        failureReason: null,
        attempts: input.clearAttempts ? 0 : undefined,
      });

      return {
        success: true,
        message: `Task ${input.taskId} reset to PENDING`,
      };
    }),

  /**
   * Reset an epic to IN_PROGRESS state
   */
  resetEpic: publicProcedure
    .input(
      z.object({
        epicId: z.string(),
        resetTasks: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const epic = await epicAccessor.findById(input.epicId);
      if (!epic) {
        throw new Error(`Epic ${input.epicId} not found`);
      }

      logger.info('Resetting epic', { epicId: input.epicId });

      await epicAccessor.update(input.epicId, {
        state: EpicState.IN_PROGRESS,
        completedAt: null,
      });

      if (input.resetTasks) {
        const tasks = await taskAccessor.list({ epicId: input.epicId });
        for (const task of tasks) {
          if (task.state === TaskState.FAILED || task.state === TaskState.BLOCKED) {
            await taskAccessor.update(task.id, {
              state: TaskState.PENDING,
              assignedAgentId: null,
              failureReason: null,
            });
          }
        }
      }

      return {
        success: true,
        message: `Epic ${input.epicId} reset to IN_PROGRESS`,
      };
    }),

  /**
   * Get system statistics
   */
  getSystemStats: publicProcedure.query(async () => {
    const healthStatus = await crashRecoveryService.getSystemHealthStatus();
    const apiUsage = rateLimiter.getApiUsageStats();
    const concurrency = rateLimiter.getConcurrencyStats();
    const worktreeStats = await worktreeService.getWorktreeStats();
    const config = configService.getSystemConfig();

    // Get epic and task counts
    const epics = await epicAccessor.list();
    const tasks = await taskAccessor.list({});

    const epicStats = {
      total: epics.length,
      planning: epics.filter((e) => e.state === EpicState.PLANNING).length,
      inProgress: epics.filter((e) => e.state === EpicState.IN_PROGRESS).length,
      completed: epics.filter((e) => e.state === EpicState.COMPLETED).length,
      blocked: epics.filter((e) => e.state === EpicState.BLOCKED).length,
      cancelled: epics.filter((e) => e.state === EpicState.CANCELLED).length,
    };

    const taskStats = {
      total: tasks.length,
      pending: tasks.filter((t) => t.state === TaskState.PENDING).length,
      assigned: tasks.filter((t) => t.state === TaskState.ASSIGNED).length,
      inProgress: tasks.filter((t) => t.state === TaskState.IN_PROGRESS).length,
      review: tasks.filter((t) => t.state === TaskState.REVIEW).length,
      completed: tasks.filter((t) => t.state === TaskState.COMPLETED).length,
      failed: tasks.filter((t) => t.state === TaskState.FAILED).length,
      blocked: tasks.filter((t) => t.state === TaskState.BLOCKED).length,
    };

    return {
      health: healthStatus,
      apiUsage,
      concurrency,
      worktrees: worktreeStats,
      epics: epicStats,
      tasks: taskStats,
      environment: config.nodeEnv,
      features: config.features,
    };
  }),

  /**
   * Trigger a health check
   */
  triggerHealthCheck: publicProcedure.mutation(async () => {
    logger.info('Manual health check triggered');

    const healthStatus = await crashRecoveryService.getSystemHealthStatus();

    return {
      timestamp: new Date().toISOString(),
      ...healthStatus,
    };
  }),

  /**
   * Export decision logs to JSON
   */
  exportDecisionLogs: publicProcedure
    .input(
      z.object({
        agentId: z.string().optional(),
        since: z.string().optional(), // ISO date string
        limit: z.number().default(1000),
      })
    )
    .query(async ({ input }) => {
      const logs = await decisionLogAccessor.list({
        agentId: input.agentId,
        limit: input.limit,
      });

      // Filter by date if provided
      const sinceDate = input.since ? new Date(input.since) : null;
      const filteredLogs: DecisionLog[] = sinceDate
        ? logs.filter((log: DecisionLog) => new Date(log.timestamp) >= sinceDate)
        : logs;

      return {
        count: filteredLogs.length,
        logs: filteredLogs.map((log: DecisionLog) => ({
          id: log.id,
          agentId: log.agentId,
          decision: log.decision,
          reasoning: log.reasoning,
          context: log.context,
          timestamp: log.timestamp.toISOString(),
        })),
      };
    }),

  /**
   * Get agent profile configuration
   */
  getAgentProfiles: publicProcedure.query(() => {
    return {
      profiles: {
        ORCHESTRATOR: configService.getAgentProfile(AgentType.ORCHESTRATOR),
        SUPERVISOR: configService.getAgentProfile(AgentType.SUPERVISOR),
        WORKER: configService.getAgentProfile(AgentType.WORKER),
      },
      availableModels: configService.getAvailableModels(),
      availablePermissionModes: configService.getAvailablePermissionModes(),
    };
  }),

  /**
   * Update rate limiter configuration
   */
  updateRateLimits: publicProcedure
    .input(
      z.object({
        claudeRequestsPerMinute: z.number().optional(),
        claudeRequestsPerHour: z.number().optional(),
        maxConcurrentWorkers: z.number().optional(),
        maxConcurrentSupervisors: z.number().optional(),
        maxConcurrentEpics: z.number().optional(),
      })
    )
    .mutation(({ input }) => {
      logger.info('Updating rate limits', input);

      rateLimiter.updateConfig(input);

      return {
        success: true,
        newConfig: rateLimiter.getConfig(),
      };
    }),

  /**
   * Clear crash records for an agent
   */
  clearCrashRecords: publicProcedure
    .input(
      z.object({
        agentId: z.string().optional(),
      })
    )
    .mutation(({ input }) => {
      if (input.agentId) {
        crashRecoveryService.clearCrashRecords(input.agentId);
        return { success: true, message: `Crash records cleared for ${input.agentId}` };
      } else {
        crashRecoveryService.clearAllCrashRecords();
        return { success: true, message: 'All crash records cleared' };
      }
    }),

  /**
   * List all agents with their status
   */
  listAgents: publicProcedure.query(async () => {
    const agents = await agentAccessor.list();

    return agents.map((agent) => ({
      id: agent.id,
      type: agent.type,
      state: agent.state,
      currentEpicId: agent.currentEpicId,
      currentTaskId: agent.currentTaskId,
      tmuxSessionName: agent.tmuxSessionName,
      lastActiveAt: agent.lastActiveAt.toISOString(),
      createdAt: agent.createdAt.toISOString(),
      isInCrashLoop: crashRecoveryService.isInCrashLoop(agent.id),
    }));
  }),

  /**
   * Get API usage by agent
   */
  getApiUsageByAgent: publicProcedure.query(() => {
    const usageByAgent = rateLimiter.getUsageByAgent();
    const usageByEpic = rateLimiter.getUsageByEpic();

    return {
      byAgent: Object.fromEntries(usageByAgent),
      byEpic: Object.fromEntries(usageByEpic),
    };
  }),

  /**
   * Reset API usage statistics
   */
  resetApiUsageStats: publicProcedure.mutation(() => {
    rateLimiter.resetUsageStats();
    return { success: true, message: 'API usage statistics reset' };
  }),
});
