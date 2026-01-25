import type { Agent } from '@prisma-gen/client';
import { AgentType, type DesiredExecutionState, ExecutionState } from '@prisma-gen/client';
import { z } from 'zod';
import { agentAccessor } from '../resource_accessors/agent.accessor';
import { projectScopedProcedure } from './procedures/project-scoped.js';
import { publicProcedure, router } from './trpc';

const HEALTH_THRESHOLD_MINUTES = 5;

/**
 * Calculate health status for an agent based on heartbeat and execution state
 */
function calculateAgentHealth(agent: Agent): {
  isHealthy: boolean;
  minutesSinceHeartbeat: number;
} {
  const now = Date.now();
  const heartbeatTime = agent.lastHeartbeat ?? agent.createdAt;
  const minutesSinceHeartbeat = Math.floor((now - heartbeatTime.getTime()) / (60 * 1000));
  const isHealthy =
    minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES &&
    agent.executionState !== ExecutionState.CRASHED;
  return { isHealthy, minutesSinceHeartbeat };
}

export const agentRouter = router({
  // List all agents with optional filtering (scoped to project from context)
  list: projectScopedProcedure
    .input(
      z
        .object({
          type: z.nativeEnum(AgentType).optional(),
          executionState: z.nativeEnum(ExecutionState).optional(),
          topLevelTaskId: z.string().optional(),
          limit: z.number().min(1).max(100).optional(),
          offset: z.number().min(0).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const agents = await agentAccessor.list({
        ...input,
        projectId: ctx.projectId,
      });

      // Calculate health status for each agent
      return agents.map((agent) => ({
        ...agent,
        ...calculateAgentHealth(agent),
      }));
    }),

  // Get agent by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const agent = await agentAccessor.findById(input.id);
    if (!agent) {
      throw new Error(`Agent not found: ${input.id}`);
    }

    return {
      ...agent,
      ...calculateAgentHealth(agent),
    };
  }),

  // Get agents grouped by type with health status (scoped to project from context)
  listGrouped: projectScopedProcedure.query(async ({ ctx }) => {
    const allAgents = await agentAccessor.list({ projectId: ctx.projectId });

    const withHealth = allAgents.map((agent) => ({
      ...agent,
      ...calculateAgentHealth(agent),
    }));

    return {
      orchestrators: withHealth.filter((a) => a.type === AgentType.ORCHESTRATOR),
      supervisors: withHealth.filter((a) => a.type === AgentType.SUPERVISOR),
      workers: withHealth.filter((a) => a.type === AgentType.WORKER),
    };
  }),

  // Get agents for a specific top-level task (workers and supervisors)
  listByTopLevelTask: publicProcedure
    .input(z.object({ topLevelTaskId: z.string() }))
    .query(async ({ input }) => {
      const agents = await agentAccessor.findAgentsByTopLevelTaskId(input.topLevelTaskId);

      return agents.map((agent) => ({
        ...agent,
        ...calculateAgentHealth(agent),
      }));
    }),

  // Get stats for dashboard (scoped to project from context)
  getStats: projectScopedProcedure.query(async ({ ctx }) => {
    const agents = await agentAccessor.list({ projectId: ctx.projectId });

    let healthy = 0;
    let unhealthy = 0;

    const byType: Record<AgentType, number> = {
      ORCHESTRATOR: 0,
      SUPERVISOR: 0,
      WORKER: 0,
    };

    const byExecutionState: Record<ExecutionState, number> = {
      IDLE: 0,
      ACTIVE: 0,
      PAUSED: 0,
      CRASHED: 0,
    };

    const byDesiredState: Record<DesiredExecutionState, number> = {
      IDLE: 0,
      ACTIVE: 0,
      PAUSED: 0,
    };

    for (const agent of agents) {
      byType[agent.type]++;
      byExecutionState[agent.executionState]++;
      byDesiredState[agent.desiredExecutionState]++;

      const { isHealthy } = calculateAgentHealth(agent);
      if (isHealthy) {
        healthy++;
      } else {
        unhealthy++;
      }
    }

    return {
      total: agents.length,
      healthy,
      unhealthy,
      byType,
      byExecutionState,
      byDesiredState,
    };
  }),
});
