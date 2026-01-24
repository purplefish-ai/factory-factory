import { AgentState, AgentType } from '@prisma-gen/client';
import { z } from 'zod';
import { readSessionOutput } from '../clients/terminal.client';
import { agentAccessor } from '../resource_accessors/agent.accessor';
import { projectScopedProcedure } from './procedures/project-scoped.js';
import { publicProcedure, router } from './trpc';

const HEALTH_THRESHOLD_MINUTES = 5;

export const agentRouter = router({
  // List all agents with optional filtering (scoped to project from context)
  list: projectScopedProcedure
    .input(
      z
        .object({
          type: z.nativeEnum(AgentType).optional(),
          state: z.nativeEnum(AgentState).optional(),
          epicId: z.string().optional(),
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
      const now = Date.now();
      return agents.map((agent) => {
        const minutesSinceHeartbeat = Math.floor(
          (now - agent.lastActiveAt.getTime()) / (60 * 1000)
        );
        const isHealthy =
          minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES && agent.state !== AgentState.FAILED;
        return {
          ...agent,
          isHealthy,
          minutesSinceHeartbeat,
        };
      });
    }),

  // Get agent by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const agent = await agentAccessor.findById(input.id);
    if (!agent) {
      throw new Error(`Agent not found: ${input.id}`);
    }

    // Calculate health status
    const now = Date.now();
    const minutesSinceHeartbeat = Math.floor((now - agent.lastActiveAt.getTime()) / (60 * 1000));
    const isHealthy =
      minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES && agent.state !== AgentState.FAILED;

    return {
      ...agent,
      isHealthy,
      minutesSinceHeartbeat,
    };
  }),

  // Get terminal output for an agent
  getTerminalOutput: publicProcedure
    .input(
      z.object({
        agentId: z.string().optional(),
        sessionName: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      let sessionName = input.sessionName;

      // If agentId provided, look up the session name
      if (input.agentId && !sessionName) {
        const agent = await agentAccessor.findById(input.agentId);
        if (!agent) {
          throw new Error(`Agent not found: ${input.agentId}`);
        }
        sessionName = agent.tmuxSessionName || undefined;
      }

      if (!sessionName) {
        throw new Error('No tmux session found for agent');
      }

      try {
        const output = await readSessionOutput(sessionName);
        return { output, sessionName };
      } catch (error) {
        return {
          output: `Error reading session: ${error instanceof Error ? error.message : 'Unknown error'}`,
          sessionName,
        };
      }
    }),

  // Get agents grouped by type with health status (scoped to project from context)
  listGrouped: projectScopedProcedure.query(async ({ ctx }) => {
    const allAgents = await agentAccessor.list({ projectId: ctx.projectId });
    const now = Date.now();

    const withHealth = allAgents.map((agent) => {
      const minutesSinceHeartbeat = Math.floor((now - agent.lastActiveAt.getTime()) / (60 * 1000));
      const isHealthy =
        minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES && agent.state !== AgentState.FAILED;
      return {
        ...agent,
        isHealthy,
        minutesSinceHeartbeat,
      };
    });

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
      const now = Date.now();

      return agents.map((agent) => {
        const minutesSinceHeartbeat = Math.floor(
          (now - agent.lastActiveAt.getTime()) / (60 * 1000)
        );
        const isHealthy =
          minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES && agent.state !== AgentState.FAILED;
        return {
          ...agent,
          isHealthy,
          minutesSinceHeartbeat,
        };
      });
    }),

  // Get stats for dashboard (scoped to project from context)
  getStats: projectScopedProcedure.query(async ({ ctx }) => {
    const agents = await agentAccessor.list({ projectId: ctx.projectId });
    const now = Date.now();

    let healthy = 0;
    let unhealthy = 0;

    const byType: Record<AgentType, number> = {
      ORCHESTRATOR: 0,
      SUPERVISOR: 0,
      WORKER: 0,
    };

    const byState: Record<AgentState, number> = {
      IDLE: 0,
      BUSY: 0,
      WAITING: 0,
      FAILED: 0,
    };

    agents.forEach((agent) => {
      byType[agent.type]++;
      byState[agent.state]++;

      const minutesSinceHeartbeat = Math.floor((now - agent.lastActiveAt.getTime()) / (60 * 1000));
      if (minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES && agent.state !== AgentState.FAILED) {
        healthy++;
      } else {
        unhealthy++;
      }
    });

    return {
      total: agents.length,
      healthy,
      unhealthy,
      byType,
      byState,
    };
  }),
});
