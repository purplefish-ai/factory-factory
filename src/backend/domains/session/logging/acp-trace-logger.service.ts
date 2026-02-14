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
import { configService } from '@/backend/services/config.service';
import { createLogger } from '@/backend/services/logger.service';

const logger = createLogger('acp-trace-logger');

type AcpTraceChannel =
  | 'raw_acp_event'
  | 'translated_delta'
  | 'runtime_exit'
  | 'runtime_error'
  | 'runtime_metadata';

interface AcpTraceState {
  filePath: string;
  stream: WriteStream;
  seq: number;
  closed: boolean;
  errored: boolean;
}

interface AcpTraceEntry {
  ts: string;
  sessionId: string;
  seq: number;
  channel: AcpTraceChannel;
  payload: unknown;
}

function shouldEnableAcpTraceLogging(): boolean {
  const raw = process.env.ACP_TRACE_LOGS_ENABLED;
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  return process.env.NODE_ENV === 'development';
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9-]/g, '_');
}

function serializeLine(entry: AcpTraceEntry): string {
  try {
    return `${JSON.stringify(entry)}\n`;
  } catch {
    return `${JSON.stringify({
      ts: entry.ts,
      sessionId: entry.sessionId,
      seq: entry.seq,
      channel: entry.channel,
      payload: '[Unserializable payload]',
    })}\n`;
  }
}

export class AcpTraceLogger {
  private readonly enabled: boolean;
  private readonly logDir: string;
  private readonly sessionLogs = new Map<string, AcpTraceState>();

  constructor() {
    this.enabled = shouldEnableAcpTraceLogging();
    this.logDir =
      process.env.ACP_TRACE_LOGS_PATH ?? join(configService.getDebugLogDir(), 'acp-events');

    if (this.enabled && !existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  log(sessionId: string, channel: AcpTraceChannel, payload: unknown): void {
    if (!this.enabled) {
      return;
    }

    const state = this.getOrCreateState(sessionId);
    if (!state || state.closed || state.errored) {
      return;
    }

    const entry: AcpTraceEntry = {
      ts: new Date().toISOString(),
      sessionId,
      seq: state.seq,
      channel,
      payload,
    };
    state.seq += 1;

    state.stream.write(serializeLine(entry));
  }

  closeSession(sessionId: string): void {
    if (!this.enabled) {
      return;
    }

    const state = this.sessionLogs.get(sessionId);
    if (!state || state.closed) {
      return;
    }

    state.closed = true;
    state.stream.end();
    this.sessionLogs.delete(sessionId);
  }

  cleanup(): void {
    for (const sessionId of this.sessionLogs.keys()) {
      this.closeSession(sessionId);
    }
  }

  cleanupOldLogs(maxAgeDays = 7): void {
    if (!(this.enabled && existsSync(this.logDir))) {
      return;
    }

    try {
      const files = readdirSync(this.logDir);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      let deletedCount = 0;

      for (const file of files) {
        const filePath = join(this.logDir, file);
        try {
          const fileStat = statSync(filePath);
          if (fileStat.mtimeMs < cutoff) {
            unlinkSync(filePath);
            deletedCount += 1;
          }
        } catch {
          // Ignore individual file errors.
        }
      }

      if (deletedCount > 0) {
        logger.info('Cleaned up old ACP trace logs', { deletedCount, maxAgeDays });
      }
    } catch (error) {
      logger.error('Failed to cleanup ACP trace logs', { error });
    }
  }

  private getOrCreateState(sessionId: string): AcpTraceState | null {
    const existing = this.sessionLogs.get(sessionId);
    if (existing) {
      return existing;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = join(this.logDir, `${safeSessionId(sessionId)}_${timestamp}.jsonl`);
    const stream = createWriteStream(filePath, { flags: 'a' });

    const state: AcpTraceState = {
      filePath,
      stream,
      seq: 1,
      closed: false,
      errored: false,
    };

    stream.on('error', (error) => {
      logger.error('ACP trace stream error', { sessionId, filePath, error });
      state.errored = true;
      this.sessionLogs.delete(sessionId);
      stream.destroy();
    });

    this.sessionLogs.set(sessionId, state);
    logger.info('Created ACP trace log file', { sessionId, filePath });
    return state;
  }
}

export const acpTraceLogger = new AcpTraceLogger();
