/**
 * Admin tRPC Router
 *
 * Provides admin operations for managing system health.
 */

import { open, stat } from 'node:fs/promises';
import type { DecisionLog } from '@prisma-gen/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { sessionDataService } from '@/backend/domains/session';
import { workspaceDataService } from '@/backend/domains/workspace';
import { dataBackupService } from '@/backend/orchestration/data-backup.service';
import { decisionLogQueryService } from '@/backend/orchestration/decision-log-query.service';
import { getLogFilePath } from '@/backend/services/logger.service';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import { buildAgentProcesses, mergeAgentSessions } from './admin-active-processes';
import { readFilteredLogEntriesPage } from './log-file-reader';
import { type Context, publicProcedure, router } from './trpc';

const loggerName = 'admin-trpc';

const getLogger = (ctx: Context) => ctx.appContext.services.createLogger(loggerName);

export const adminRouter = router({
  /**
   * Get server information (port, environment, etc.)
   */
  getServerInfo: publicProcedure.query(({ ctx }) => {
    const { configService, serverInstanceService } = ctx.appContext.services;
    const backendPort = serverInstanceService.getPort();
    const config = configService.getSystemConfig();

    return {
      backendPort,
      environment: config.nodeEnv,
      version: configService.getAppVersion(),
    };
  }),

  /**
   * Get system statistics
   */
  getSystemStats: publicProcedure.query(({ ctx }) => {
    const { configService, rateLimiter } = ctx.appContext.services;
    const apiUsage = rateLimiter.getApiUsageStats();
    const config = configService.getSystemConfig();

    return {
      apiUsage,
      environment: config.nodeEnv,
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
      const logs = await decisionLogQueryService.list({
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
      })
    )
    .mutation(({ ctx, input }) => {
      const { rateLimiter } = ctx.appContext.services;
      const logger = getLogger(ctx);

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
  getApiUsageByAgent: publicProcedure.query(({ ctx }) => {
    const { rateLimiter } = ctx.appContext.services;
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
  resetApiUsageStats: publicProcedure.mutation(({ ctx }) => {
    const { rateLimiter } = ctx.appContext.services;
    rateLimiter.resetUsageStats();
    return { success: true, message: 'API usage statistics reset' };
  }),

  /**
   * Check CLI dependencies health (Claude CLI, GitHub CLI).
   * Returns status of each CLI and whether all are healthy.
   */
  checkCLIHealth: publicProcedure
    .input(z.object({ forceRefresh: z.boolean().default(false) }).optional())
    .query(({ ctx, input }) => {
      const { cliHealthService } = ctx.appContext.services;
      return cliHealthService.checkHealth(input?.forceRefresh ?? false);
    }),

  /**
   * Upgrade a provider CLI via npm global install and return refreshed health.
   */
  upgradeProviderCLI: publicProcedure
    .input(z.object({ provider: z.enum(['CLAUDE', 'CODEX']) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await ctx.appContext.services.cliHealthService.upgradeProviderCLI(
          input.provider
        );
        return {
          ...result,
          message: `${input.provider === 'CLAUDE' ? 'Claude' : 'Codex'} CLI upgraded successfully.`,
        };
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),

  /**
   * Get all active processes (Agent sessions via ACP and Terminal)
   */
  getActiveProcesses: publicProcedure.query(async ({ ctx }) => {
    const { acpRuntimeManager, terminalService } = ctx.appContext.services;
    const logger = getLogger(ctx);
    // Get active ACP sessions from in-memory map
    const activeAcpProcesses = acpRuntimeManager.getAllActiveProcesses();

    // Resolve active ACP sessions by sessionId (not by providerProcessPid).
    const activeSessionIds = activeAcpProcesses.map((process) => process.sessionId);
    const activeDbSessions = await sessionDataService.findAgentSessionsByIds(activeSessionIds);

    // Get active terminals from in-memory map
    const activeTerminals = terminalService.getAllTerminals();

    // Include PID-backed DB sessions not in memory (orphan/stale edge cases).
    const agentSessionsWithPid = await sessionDataService.findAgentSessionsWithPid();
    const mergedAgentSessions = mergeAgentSessions(activeDbSessions, agentSessionsWithPid);

    // Get terminal sessions with PIDs from database
    const terminalSessionsWithPid = await sessionDataService.findTerminalSessionsWithPid();

    // Get workspace info for all related workspaces (with project for URL generation)
    const workspaceIds = new Set([
      ...mergedAgentSessions.map((s) => s.workspaceId),
      ...terminalSessionsWithPid.map((s) => s.workspaceId),
      ...activeTerminals.map((t) => t.workspaceId),
    ]);
    const workspaces = await workspaceDataService.findByIdsWithProject(Array.from(workspaceIds));
    const workspaceMap = new Map(workspaces.map((w) => [w.id, w]));

    const { agentProcesses, orphanedSessionIds } = buildAgentProcesses({
      activeAcpProcesses,
      dbSessions: mergedAgentSessions,
      workspaceById: workspaceMap,
    });
    for (const sessionId of orphanedSessionIds) {
      const memProcess = activeAcpProcesses.find((process) => process.sessionId === sessionId);
      logger.warn('Found in-memory ACP process without DB record', {
        sessionId,
        pid: memProcess?.pid,
        status: memProcess?.status,
      });
    }

    // Build enriched terminal process list
    const terminalProcesses = activeTerminals.map((terminal) => {
      const dbSession = terminalSessionsWithPid.find(
        (s) => s.workspaceId === terminal.workspaceId && s.pid === terminal.pid
      );
      const workspace = workspaceMap.get(terminal.workspaceId);
      return {
        terminalId: terminal.id,
        workspaceId: terminal.workspaceId,
        workspaceName: workspace?.name ?? 'Unknown',
        workspaceBranch: workspace?.branchName ?? null,
        projectSlug: workspace?.project.slug ?? null,
        pid: terminal.pid,
        cols: terminal.cols,
        rows: terminal.rows,
        createdAt: terminal.createdAt,
        dbSessionId: dbSession?.id ?? null,
        // Resource monitoring data
        cpuPercent: terminal.resourceUsage?.cpu ?? null,
        memoryBytes: terminal.resourceUsage?.memory ?? null,
      };
    });

    return {
      agent: agentProcesses,
      terminal: terminalProcesses,
      summary: {
        totalAgent: agentProcesses.length,
        totalTerminal: terminalProcesses.length,
        total: agentProcesses.length + terminalProcesses.length,
      },
    };
  }),

  /**
   * Manually trigger ratchet check for all workspaces with PRs.
   * Useful for testing ratchet functionality.
   */
  triggerRatchetCheck: publicProcedure.mutation(async ({ ctx }) => {
    const { ratchetService } = ctx.appContext.services;
    const logger = getLogger(ctx);

    logger.info('Manually triggering ratchet check for all workspaces');
    const result = await ratchetService.checkAllWorkspaces();
    return {
      success: true,
      checked: result.checked,
      stateChanges: result.stateChanges,
      actionsTriggered: result.actionsTriggered,
    };
  }),

  /**
   * Export all data for backup/migration.
   * Exports projects, workspaces, sessions, and user preferences.
   * Excludes cached data (workspaceOrder, cachedSlashCommands) which will rebuild.
   */
  exportData: publicProcedure.query(({ ctx }) => {
    const { configService } = ctx.appContext.services;
    return dataBackupService.exportData(configService.getAppVersion());
  }),

  /**
   * Import data from a backup file.
   * Skips records that already exist (by ID).
   * Returns counts of imported/skipped records.
   */
  importData: publicProcedure.input(exportDataSchema).mutation(async ({ input }) => {
    const results = await dataBackupService.importData(input);
    return {
      success: true,
      results,
    };
  }),

  /**
   * Get parsed log entries from server.log with filtering and pagination.
   */
  getLogs: publicProcedure
    .input(
      z.object({
        search: z.string().optional(),
        level: z.enum(['error', 'warn', 'info', 'debug']).optional(),
        since: z.string().optional(), // ISO date string
        until: z.string().optional(), // ISO date string
        limit: z.number().min(1).max(1000).default(200),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const filePath = getLogFilePath();

      const filter = {
        level: input.level,
        search: input.search?.toLowerCase(),
        sinceMs: input.since ? new Date(input.since).getTime() : null,
        untilMs: input.until ? new Date(input.until).getTime() : null,
      };

      try {
        const page = await readFilteredLogEntriesPage(filePath, filter, {
          limit: input.limit,
          offset: input.offset,
        });
        return { ...page, filePath };
      } catch {
        return {
          entries: [],
          total: 0,
          totalIsExact: false,
          hasMore: false,
          filePath,
        };
      }
    }),

  /**
   * Download the raw log file content.
   */
  downloadLogFile: publicProcedure.query(async () => {
    const filePath = getLogFilePath();
    const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
    try {
      const fileStats = await stat(filePath);
      const startByte = Math.max(0, fileStats.size - MAX_DOWNLOAD_BYTES);
      const fh = await open(filePath, 'r');
      try {
        const buf = Buffer.alloc(fileStats.size - startByte);
        await fh.read(buf, 0, buf.length, startByte);
        let content = buf.toString('utf-8');
        // If we skipped the beginning, trim to the first complete line
        if (startByte > 0) {
          const firstNewline = content.indexOf('\n');
          if (firstNewline !== -1) {
            content = content.slice(firstNewline + 1);
          }
        }
        return content;
      } finally {
        await fh.close();
      }
    } catch {
      return '';
    }
  }),

  /**
   * Stop a session by ID (admin override).
   * This allows admins to forcefully stop sessions that may be stuck or consuming resources.
   */
  stopSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionService } = ctx.appContext.services;
      const logger = getLogger(ctx);

      const wasRunning = sessionService.isSessionRunning(input.sessionId);

      logger.info('Admin stopping session', {
        sessionId: input.sessionId,
        wasRunning,
      });

      await sessionService.stopSession(input.sessionId);

      return {
        wasRunning,
      };
    }),
});
