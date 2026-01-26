/**
 * Admin tRPC Router
 *
 * Provides admin operations for managing system health.
 */

import type { DecisionLog } from '@prisma-gen/client';
import { z } from 'zod';
import { decisionLogAccessor } from '../resource_accessors/index.js';
import { configService, createLogger, rateLimiter } from '../services/index.js';
import { publicProcedure, router } from './trpc.js';

const logger = createLogger('admin-trpc');

export const adminRouter = router({
  /**
   * Get system statistics
   */
  getSystemStats: publicProcedure.query(() => {
    const apiUsage = rateLimiter.getApiUsageStats();
    const concurrency = rateLimiter.getConcurrencyStats();
    const config = configService.getSystemConfig();

    return {
      apiUsage,
      concurrency,
      environment: config.nodeEnv,
      features: config.features,
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
