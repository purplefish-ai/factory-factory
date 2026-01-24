/**
 * Admin tRPC Router
 *
 * Provides admin operations for managing agents, tasks, epics, and system health.
 */

import type { DecisionLog } from '@prisma-gen/client';
import { AgentType, ExecutionState, TaskState } from '@prisma-gen/client';
import { z } from 'zod';
import { killSupervisorAndCleanup, recreateSupervisor } from '../agents/supervisor/lifecycle.js';
import { killWorkerAndCleanup } from '../agents/worker/lifecycle.js';
import { agentAccessor, decisionLogAccessor, taskAccessor } from '../resource_accessors/index.js';
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
          // Orchestrator - just mark as crashed
          await agentAccessor.update(input.agentId, {
            executionState: ExecutionState.CRASHED,
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

      if (agent.type === AgentType.SUPERVISOR && agent.currentTaskId) {
        const newAgentId = await recreateSupervisor(agent.currentTaskId);
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
            executionState: ExecutionState.CRASHED,
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

      // If task has an assigned agent, mark it as crashed
      if (task.assignedAgentId) {
        await agentAccessor.update(task.assignedAgentId, {
          executionState: ExecutionState.CRASHED,
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
   * Reset a top-level task to IN_PROGRESS state
   */
  resetTopLevelTask: publicProcedure
    .input(
      z.object({
        topLevelTaskId: z.string(),
        resetChildTasks: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const task = await taskAccessor.findById(input.topLevelTaskId);
      if (!task) {
        throw new Error(`Top-level task ${input.topLevelTaskId} not found`);
      }

      // Verify it's a top-level task
      if (task.parentId !== null) {
        throw new Error(`Task ${input.topLevelTaskId} is not a top-level task`);
      }

      logger.info('Resetting top-level task', { topLevelTaskId: input.topLevelTaskId });

      await taskAccessor.update(input.topLevelTaskId, {
        state: TaskState.IN_PROGRESS,
        completedAt: null,
      });

      if (input.resetChildTasks) {
        const childTasks = await taskAccessor.findByParentId(input.topLevelTaskId);
        for (const childTask of childTasks) {
          if (childTask.state === TaskState.FAILED || childTask.state === TaskState.BLOCKED) {
            await taskAccessor.update(childTask.id, {
              state: TaskState.PENDING,
              assignedAgentId: null,
              failureReason: null,
            });
          }
        }
      }

      return {
        success: true,
        message: `Top-level task ${input.topLevelTaskId} reset to IN_PROGRESS`,
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

    // Get top-level tasks (epics) and all tasks
    const topLevelTasks = await taskAccessor.list({ isTopLevel: true });
    const allTasks = await taskAccessor.list({});

    const epicStats = {
      total: topLevelTasks.length,
      planning: topLevelTasks.filter((t) => t.state === TaskState.PLANNING).length,
      inProgress: topLevelTasks.filter((t) => t.state === TaskState.IN_PROGRESS).length,
      review: topLevelTasks.filter((t) => t.state === TaskState.REVIEW).length,
      completed: topLevelTasks.filter((t) => t.state === TaskState.COMPLETED).length,
      blocked: topLevelTasks.filter((t) => t.state === TaskState.BLOCKED).length,
      failed: topLevelTasks.filter((t) => t.state === TaskState.FAILED).length,
    };

    const taskStats = {
      total: allTasks.length,
      pending: allTasks.filter((t) => t.state === TaskState.PENDING).length,
      planning: allTasks.filter((t) => t.state === TaskState.PLANNING).length,
      inProgress: allTasks.filter((t) => t.state === TaskState.IN_PROGRESS).length,
      review: allTasks.filter((t) => t.state === TaskState.REVIEW).length,
      completed: allTasks.filter((t) => t.state === TaskState.COMPLETED).length,
      failed: allTasks.filter((t) => t.state === TaskState.FAILED).length,
      blocked: allTasks.filter((t) => t.state === TaskState.BLOCKED).length,
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
      executionState: agent.executionState,
      desiredExecutionState: agent.desiredExecutionState,
      currentTaskId: agent.currentTaskId,
      tmuxSessionName: agent.tmuxSessionName,
      lastHeartbeat: (agent.lastHeartbeat ?? agent.createdAt).toISOString(),
      createdAt: agent.createdAt.toISOString(),
      isInCrashLoop: crashRecoveryService.isInCrashLoop(agent.id),
    }));
  }),

  /**
   * Get API usage by agent
   */
  getApiUsageByAgent: publicProcedure.query(() => {
    const usageByAgent = rateLimiter.getUsageByAgent();
    const usageByTopLevelTask = rateLimiter.getUsageByTopLevelTask();

    return {
      byAgent: Object.fromEntries(usageByAgent),
      byTopLevelTask: Object.fromEntries(usageByTopLevelTask),
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
