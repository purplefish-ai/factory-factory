/**
 * Admin tRPC Router
 *
 * Provides admin operations for managing system health.
 */

import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { type DecisionLog, SessionStatus } from '@prisma-gen/client';
import { z } from 'zod';
import { exportDataSchema } from '@/shared/schemas/export-data.schema';
import { dataBackupService } from '../services';
import { decisionLogQueryService } from '../services/decision-log-query.service';
import { getLogFilePath } from '../services/logger.service';
import { sessionDataService } from '../services/session-data.service';
import { workspaceDataService } from '../services/workspace-data.service';
import { type Context, publicProcedure, router } from './trpc';

const loggerName = 'admin-trpc';

const getLogger = (ctx: Context) => ctx.appContext.services.createLogger(loggerName);

export interface ParsedLogEntry {
  level: string;
  timestamp: string;
  message: string;
  component: string;
  context: Record<string, unknown>;
}

interface LogFilter {
  level?: string;
  search?: string;
  sinceMs?: number | null;
  untilMs?: number | null;
}

function matchesTimestamp(timestamp: string | undefined, filter: LogFilter): boolean {
  if (!(timestamp && (filter.sinceMs || filter.untilMs))) {
    return true;
  }
  const ts = new Date(timestamp).getTime();
  if (filter.sinceMs && ts < filter.sinceMs) {
    return false;
  }
  return !(filter.untilMs && ts > filter.untilMs);
}

function matchesLogFilter(entry: Record<string, unknown>, filter: LogFilter): boolean {
  if (filter.level && entry.level !== filter.level) {
    return false;
  }
  if (!matchesTimestamp(entry.timestamp as string | undefined, filter)) {
    return false;
  }
  if (filter.search) {
    const msg = (entry.message as string)?.toLowerCase() ?? '';
    const comp = (entry.context as Record<string, unknown>)?.component as string | undefined;
    if (!(msg.includes(filter.search) || comp?.toLowerCase().includes(filter.search))) {
      return false;
    }
  }
  return true;
}

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
    const claudeSessionsWithPid = await sessionDataService.findClaudeSessionsWithPid();

    // Get terminal sessions with PIDs from database
    const terminalSessionsWithPid = await sessionDataService.findTerminalSessionsWithPid();

    // Get workspace info for all related workspaces (with project for URL generation)
    const workspaceIds = new Set([
      ...claudeSessionsWithPid.map((s) => s.workspaceId),
      ...terminalSessionsWithPid.map((s) => s.workspaceId),
      ...activeTerminals.map((t) => t.workspaceId),
    ]);
    const workspaces = await workspaceDataService.findByIdsWithProject(Array.from(workspaceIds));
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

      // Stream the log file line-by-line to avoid loading the entire file into memory
      const filter: LogFilter = {
        level: input.level,
        search: input.search?.toLowerCase(),
        sinceMs: input.since ? new Date(input.since).getTime() : null,
        untilMs: input.until ? new Date(input.until).getTime() : null,
      };
      const filtered: ParsedLogEntry[] = [];
      try {
        const rl = createInterface({
          input: createReadStream(filePath, 'utf-8'),
          crlfDelay: Number.POSITIVE_INFINITY,
        });
        for await (const line of rl) {
          if (!line) {
            continue;
          }
          try {
            const entry = JSON.parse(line);
            if (!matchesLogFilter(entry, filter)) {
              continue;
            }
            filtered.push({
              level: entry.level,
              timestamp: entry.timestamp,
              message: entry.message,
              component: entry.context?.component ?? '',
              context: entry.context ?? {},
            });
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        return { entries: [], total: 0, filePath };
      }

      // Reverse so newest entries come first, then paginate
      filtered.reverse();
      const page = filtered.slice(input.offset, input.offset + input.limit);

      return { entries: page, total: filtered.length, filePath };
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
   * Stop a Claude session by ID (admin override).
   * This allows admins to forcefully stop sessions that may be stuck or consuming resources.
   */
  stopClaudeSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { sessionService } = ctx.appContext.services;
      const logger = getLogger(ctx);

      logger.info('Admin stopping Claude session', { sessionId: input.sessionId });

      await sessionService.stopClaudeSession(input.sessionId);

      return {
        success: true,
        message: `Session ${input.sessionId} stopped`,
      };
    }),
});
