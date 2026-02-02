/**
 * Session File Logger Service
 *
 * Logs WebSocket events to a per-session file for debugging.
 * Log files are stored in .context/ws-logs/<session-id>.log
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';
import { configService } from './config.service';
import { createLogger } from './logger.service';

const logger = createLogger('session-file-logger');

/**
 * Logs WebSocket events to a per-session file for debugging.
 * Log files are stored in .context/ws-logs/<session-id>.log
 */
export class SessionFileLogger {
  private enabled: boolean;
  private logDir: string;
  private sessionLogs = new Map<
    string,
    {
      logFile: string;
      stream: WriteStream;
      pending: string[];
      flushing: boolean;
      closed: boolean;
    }
  >();

  constructor() {
    // Default: only enabled in development unless explicitly overridden
    this.enabled = configService.isDevelopment() || process.env.WS_LOGS_ENABLED === 'true';
    // Get from config service (which uses WS_LOGS_PATH env var or falls back to .context/ws-logs in cwd)
    // For Electron, this will be in userData directory
    this.logDir = configService.getWsLogsPath();
    // Ensure log directory exists only when enabled
    if (this.enabled && !existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Initialize a log file for a session.
   * Returns early if already initialized to prevent duplicate log files.
   */
  initSession(sessionId: string): void {
    if (!this.enabled) {
      return;
    }
    // Skip if already initialized (prevents duplicate log files when multiple windows connect)
    if (this.sessionLogs.has(sessionId)) {
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9-]/g, '_');
    const logFile = join(this.logDir, `${safeSessionId}_${timestamp}.log`);
    const stream = createWriteStream(logFile, { flags: 'a' });
    this.sessionLogs.set(sessionId, {
      logFile,
      stream,
      pending: [],
      flushing: false,
      closed: false,
    });

    // Write header
    const header = [
      '='.repeat(80),
      `WebSocket Session Log`,
      `Session ID: ${sessionId}`,
      `Started: ${new Date().toISOString()}`,
      `Log File: ${logFile}`,
      '='.repeat(80),
      '',
    ].join('\n');

    stream.write(header);
    logger.info('Created log file', { sessionId, logFile });
  }

  /**
   * Log a message to the session's log file
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: debug logging with intentional branching for summary extraction
  log(
    sessionId: string,
    direction: 'OUT_TO_CLIENT' | 'IN_FROM_CLIENT' | 'FROM_CLAUDE_CLI' | 'INFO',
    data: unknown
  ): void {
    if (!this.enabled) {
      return;
    }

    const logState = this.sessionLogs.get(sessionId);
    if (!logState || logState.closed) {
      return;
    }

    const timestamp = new Date().toISOString();
    const directionIcon =
      direction === 'OUT_TO_CLIENT'
        ? '>>> OUT->CLIENT'
        : direction === 'IN_FROM_CLIENT'
          ? '<<< IN<-CLIENT'
          : direction === 'FROM_CLAUDE_CLI'
            ? '### FROM_CLI'
            : '*** INFO';

    // Extract summary info for quick scanning
    let summary = '';
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      summary = `type=${String(obj.type ?? 'unknown')}`;

      // For claude_message, extract inner type
      if (obj.type === 'claude_message' && obj.data) {
        const innerData = obj.data as Record<string, unknown>;
        summary += ` inner_type=${String(innerData.type ?? 'unknown')}`;

        // For stream events, extract event type
        if (innerData.type === 'stream_event' && innerData.event) {
          const event = innerData.event as Record<string, unknown>;
          summary += ` event_type=${String(event.type ?? 'unknown')}`;
          if (event.content_block) {
            const block = event.content_block as Record<string, unknown>;
            summary += ` block_type=${String(block.type ?? 'unknown')}`;
            if (block.name) {
              summary += ` tool=${String(block.name)}`;
            }
          }
        }

        // For user messages with tool_result
        if (innerData.type === 'user' && innerData.message) {
          const msg = innerData.message as { content?: Array<{ type?: string }> };
          if (Array.isArray(msg.content)) {
            const types = msg.content.map((c) => c.type).join(',');
            summary += ` content_types=[${types}]`;
          }
        }

        // For result messages
        if (innerData.type === 'result') {
          summary += ` result_present=${innerData.result != null}`;
        }
      }
    }

    const logEntry = [
      '-'.repeat(80),
      `[${timestamp}] ${directionIcon}`,
      `Summary: ${summary}`,
      'Full Data:',
      JSON.stringify(data, null, 2),
      '',
    ].join('\n');

    logState.pending.push(logEntry);
    this.flushAsync(sessionId, logState);
  }

  /**
   * Close a session's log file
   */
  closeSession(sessionId: string): void {
    if (!this.enabled) {
      return;
    }

    const logState = this.sessionLogs.get(sessionId);
    if (logState && !logState.closed) {
      const footer = [
        '',
        '='.repeat(80),
        `Session ended: ${new Date().toISOString()}`,
        '='.repeat(80),
      ].join('\n');

      logState.pending.push(footer);
      logState.closed = true;
      this.flushAsync(sessionId, logState, true);
    }
  }

  /**
   * Close all active session logs (called during shutdown)
   */
  cleanup(): void {
    for (const sessionId of this.sessionLogs.keys()) {
      this.closeSession(sessionId);
    }
  }

  /**
   * Delete log files older than maxAgeDays (default 7 days)
   */
  cleanupOldLogs(maxAgeDays: number = 7): void {
    if (!this.enabled) {
      return;
    }
    try {
      if (!existsSync(this.logDir)) {
        return;
      }

      const files = readdirSync(this.logDir);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      let deletedCount = 0;

      for (const file of files) {
        const filePath = join(this.logDir, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            unlinkSync(filePath);
            deletedCount++;
          }
        } catch {
          // Ignore individual file errors
        }
      }

      if (deletedCount > 0) {
        logger.info('Cleaned up old log files', { deletedCount, maxAgeDays });
      }
    } catch (error) {
      logger.error('Failed to cleanup old logs', { error });
    }
  }

  private flushAsync(
    sessionId: string,
    logState: {
      logFile: string;
      stream: WriteStream;
      pending: string[];
      flushing: boolean;
      closed: boolean;
    },
    endWhenDone: boolean = false
  ): void {
    if (logState.flushing) {
      return;
    }
    logState.flushing = true;

    const flush = () => {
      while (logState.pending.length > 0) {
        const chunk = logState.pending.shift();
        if (!chunk) {
          continue;
        }
        const canContinue = logState.stream.write(chunk);
        if (!canContinue) {
          logState.stream.once('drain', flush);
          return;
        }
      }

      logState.flushing = false;

      if (endWhenDone && logState.pending.length === 0) {
        logState.stream.end(() => {
          this.sessionLogs.delete(sessionId);
          logger.info('Closed log file', { sessionId, logFile: logState.logFile });
        });
      }
    };

    setImmediate(flush);
  }
}

/**
 * Singleton instance for use in handlers
 */
export const sessionFileLogger = new SessionFileLogger();
