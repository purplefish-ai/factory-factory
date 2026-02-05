/**
 * Admin tRPC Router
 *
 * Provides admin operations for managing system health.
 */

import { type DecisionLog, SessionStatus } from '@prisma-gen/client';
import { z } from 'zod';
import {
  claudeSessionAccessor,
  decisionLogAccessor,
  terminalSessionAccessor,
  workspaceAccessor,
} from '../resource_accessors/index';
import { dataBackupService, exportDataSchema } from '../services';
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
   * Get all active processes (Claude and Terminal)
   */
  getActiveProcesses: publicProcedure.query(async ({ ctx }) => {
    const { sessionService, terminalService } = ctx.appContext.services;
    const logger = getLogger(ctx);
    // Get active Claude processes from in-memory map
    const activeClaudeProcesses = sessionService.getAllActiveProcesses();

    // Get active terminals from in-memory map
    const activeTerminals = terminalService.getAllTerminals();

    // Get Claude sessions with PIDs from database for enriched info
    const claudeSessionsWithPid = await claudeSessionAccessor.findWithPid();

    // Get terminal sessions with PIDs from database
    const terminalSessionsWithPid = await terminalSessionAccessor.findWithPid();

    // Get workspace info for all related workspaces (with project for URL generation)
    const workspaceIds = new Set([
      ...claudeSessionsWithPid.map((s) => s.workspaceId),
      ...terminalSessionsWithPid.map((s) => s.workspaceId),
      ...activeTerminals.map((t) => t.workspaceId),
    ]);
    const workspaces = await workspaceAccessor.findByIdsWithProject(Array.from(workspaceIds));
    const workspaceMap = new Map(workspaces.map((w) => [w.id, w]));

    // Build enriched Claude process list from DB sessions
    const dbSessionIds = new Set(claudeSessionsWithPid.map((s) => s.id));
    const claudeProcesses = claudeSessionsWithPid.map((session) => {
      const memProcess = activeClaudeProcesses.find((p) => p.sessionId === session.id);
      const workspace = workspaceMap.get(session.workspaceId);
      return {
        sessionId: session.id,
        workspaceId: session.workspaceId,
        workspaceName: workspace?.name ?? 'Unknown',
        workspaceBranch: workspace?.branchName ?? null,
        projectSlug: workspace?.project.slug ?? null,
        name: session.name,
        workflow: session.workflow,
        model: session.model,
        pid: session.claudeProcessPid,
        status: session.status,
        inMemory: !!memProcess,
        memoryStatus: memProcess?.status ?? null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        // Resource monitoring data
        cpuPercent: memProcess?.resourceUsage?.cpu ?? null,
        memoryBytes: memProcess?.resourceUsage?.memory ?? null,
        idleTimeMs: memProcess?.idleTimeMs ?? null,
      };
    });

    // Add in-memory processes that don't have a DB record (edge case)
    for (const memProcess of activeClaudeProcesses) {
      if (!dbSessionIds.has(memProcess.sessionId)) {
        logger.warn('Found in-memory Claude process without DB record', {
          sessionId: memProcess.sessionId,
          pid: memProcess.pid,
          status: memProcess.status,
        });
        // Map in-memory status to DB SessionStatus
        const statusMap: Record<string, SessionStatus> = {
          starting: SessionStatus.RUNNING, // starting maps to running
          ready: SessionStatus.IDLE,
          running: SessionStatus.RUNNING,
          exited: SessionStatus.COMPLETED,
        };
        claudeProcesses.push({
          sessionId: memProcess.sessionId,
          workspaceId: 'unknown',
          workspaceName: 'Unknown (orphan)',
          workspaceBranch: null,
          projectSlug: null,
          name: null,
          workflow: 'unknown',
          model: 'unknown',
          pid: memProcess.pid ?? null,
          status: statusMap[memProcess.status] ?? SessionStatus.RUNNING,
          inMemory: true,
          memoryStatus: memProcess.status,
          createdAt: new Date(),
          updatedAt: new Date(),
          cpuPercent: memProcess.resourceUsage?.cpu ?? null,
          memoryBytes: memProcess.resourceUsage?.memory ?? null,
          idleTimeMs: memProcess.idleTimeMs ?? null,
        });
      }
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
      claude: claudeProcesses,
      terminal: terminalProcesses,
      summary: {
        totalClaude: claudeProcesses.length,
        totalTerminal: terminalProcesses.length,
        total: claudeProcesses.length + terminalProcesses.length,
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
});
