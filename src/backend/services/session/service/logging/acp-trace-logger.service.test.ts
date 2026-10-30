import { mkdtempSync, readFileSync, utimesSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configService } from '@/backend/services/config.service';
import { AcpTraceLogger } from './acp-trace-logger.service';

function waitForFlush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 25);
  });
}

// Wait until the stream has written every line. Under CPU load a write can land
// after any fixed delay, and a late write would also refresh the file's mtime.
async function waitForLines(dir: string, count: number): Promise<string> {
  for (;;) {
    const [fileName] = await readdir(dir);
    if (fileName) {
      const filePath = join(dir, fileName);
      if (readFileSync(filePath, 'utf-8').split('\n').length > count) {
        return filePath;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AcpTraceLogger', () => {
  const TraceEntrySchema = z.object({
    ts: z.string(),
    seq: z.number(),
    sessionId: z.string(),
    channel: z.string(),
    payload: z.unknown(),
  });

  const originalEnabled = process.env.ACP_TRACE_LOGS_ENABLED;
  const originalPath = process.env.ACP_TRACE_LOGS_PATH;
  const originalNodeEnv = process.env.NODE_ENV;
  const createdDirs: string[] = [];

  const restoreEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
      return;
    }
    process.env[key] = value;
  };

  afterEach(async () => {
    restoreEnv('ACP_TRACE_LOGS_ENABLED', originalEnabled);
    restoreEnv('ACP_TRACE_LOGS_PATH', originalPath);
    restoreEnv('NODE_ENV', originalNodeEnv);
    configService.reload();

    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (!dir) {
        continue;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes ACP trace entries as JSONL with increasing sequence numbers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-trace-logger-'));
    createdDirs.push(dir);
    process.env.ACP_TRACE_LOGS_ENABLED = 'true';
    process.env.ACP_TRACE_LOGS_PATH = dir;
    configService.reload();

    const logger = new AcpTraceLogger();
    logger.log('session-1', 'raw_acp_event', { eventType: 'acp_session_update' });
    logger.log('session-1', 'translated_delta', { type: 'agent_message' });
    logger.closeSession('session-1');
    const filePath = await waitForLines(dir, 2);

    expect(await readdir(dir)).toHaveLength(1);
    const contents = readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(contents).toHaveLength(2);

    const first = TraceEntrySchema.parse(JSON.parse(contents[0] ?? '{}'));
    const second = TraceEntrySchema.parse(JSON.parse(contents[1] ?? '{}'));

    expect(first.seq).toBe(1);
    expect(first.sessionId).toBe('session-1');
    expect(first.channel).toBe('raw_acp_event');
    expect(z.object({ eventType: z.string() }).parse(first.payload).eventType).toBe(
      'acp_session_update'
    );
    expect(second.seq).toBe(2);
    expect(second.channel).toBe('translated_delta');
  });

  it('does not write files when disabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-trace-logger-'));
    createdDirs.push(dir);
    process.env.ACP_TRACE_LOGS_ENABLED = 'false';
    process.env.ACP_TRACE_LOGS_PATH = dir;
    process.env.NODE_ENV = 'production';
    configService.reload();

    const logger = new AcpTraceLogger();
    logger.log('session-1', 'raw_acp_event', { eventType: 'acp_session_update' });
    logger.cleanup();
    await waitForFlush();

    const files = await readdir(dir);
    expect(files).toHaveLength(0);
  });

  it('cleanupOldLogs removes stale log files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-trace-logger-'));
    createdDirs.push(dir);
    process.env.ACP_TRACE_LOGS_ENABLED = 'true';
    process.env.ACP_TRACE_LOGS_PATH = dir;
    configService.reload();

    const logger = new AcpTraceLogger();
    logger.log('session-1', 'raw_acp_event', { eventType: 'acp_session_update' });
    logger.closeSession('session-1');
    const filePath = await waitForLines(dir, 1);
    const oldMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const oldDate = new Date(oldMs);
    utimesSync(filePath, oldDate, oldDate);

    logger.cleanupOldLogs(7);
    const filesAfter = await readdir(dir);
    expect(filesAfter).toHaveLength(0);
  });
});
