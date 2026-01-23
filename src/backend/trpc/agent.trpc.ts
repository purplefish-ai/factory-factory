import { z } from 'zod';
import { router, publicProcedure } from './trpc';
import { agentAccessor } from '../resource_accessors/agent.accessor';
import { readSessionOutput } from '../clients/terminal.client';
import { AgentType, AgentState } from '@prisma/client';

const HEALTH_THRESHOLD_MINUTES = 5;

export const agentRouter = router({
  // List all agents with optional filtering
  list: publicProcedure
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
    .query(async ({ input }) => {
      const agents = await agentAccessor.list(input);

      // Calculate health status for each agent
      const now = Date.now();
      return agents.map((agent) => {
        const minutesSinceHeartbeat = Math.floor(
          (now - agent.lastActiveAt.getTime()) / (60 * 1000)
        );
        const isHealthy =
          minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES &&
          agent.state !== AgentState.FAILED;
        return {
          ...agent,
          isHealthy,
          minutesSinceHeartbeat,
        };
      });
    }),

  // Get agent by ID
  getById: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const agent = await agentAccessor.findById(input.id);
      if (!agent) {
        throw new Error(`Agent not found: ${input.id}`);
      }

      // Calculate health status
      const now = Date.now();
      const minutesSinceHeartbeat = Math.floor(
        (now - agent.lastActiveAt.getTime()) / (60 * 1000)
      );
      const isHealthy =
        minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES &&
        agent.state !== AgentState.FAILED;

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

  // Get agents grouped by type with health status
  listGrouped: publicProcedure.query(async () => {
    const allAgents = await agentAccessor.list();
    const now = Date.now();

    const withHealth = allAgents.map((agent) => {
      const minutesSinceHeartbeat = Math.floor(
        (now - agent.lastActiveAt.getTime()) / (60 * 1000)
      );
      const isHealthy =
        minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES &&
        agent.state !== AgentState.FAILED;
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

  // Get agents for a specific epic (workers and supervisors)
  listByEpic: publicProcedure
    .input(z.object({ epicId: z.string() }))
    .query(async ({ input }) => {
      const agents = await agentAccessor.findAgentsByEpicId(input.epicId);
      const now = Date.now();

      return agents.map((agent) => {
        const minutesSinceHeartbeat = Math.floor(
          (now - agent.lastActiveAt.getTime()) / (60 * 1000)
        );
        const isHealthy =
          minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES &&
          agent.state !== AgentState.FAILED;
        return {
          ...agent,
          isHealthy,
          minutesSinceHeartbeat,
        };
      });
    }),

  // Get stats for dashboard
  getStats: publicProcedure.query(async () => {
    const agents = await agentAccessor.list();
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

      const minutesSinceHeartbeat = Math.floor(
        (now - agent.lastActiveAt.getTime()) / (60 * 1000)
      );
      if (
        minutesSinceHeartbeat < HEALTH_THRESHOLD_MINUTES &&
        agent.state !== AgentState.FAILED
      ) {
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
