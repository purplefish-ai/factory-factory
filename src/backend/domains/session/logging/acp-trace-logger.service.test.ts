import { mkdtempSync, readFileSync, utimesSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AcpTraceLogger } from './acp-trace-logger.service';

function waitForFlush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 25);
  });
}

describe('AcpTraceLogger', () => {
  const TraceEntrySchema = z.object({
    seq: z.number(),
    sessionId: z.string(),
    channel: z.string(),
    payload: z.unknown(),
  });

  const originalEnabled = process.env.ACP_TRACE_LOGS_ENABLED;
  const originalPath = process.env.ACP_TRACE_LOGS_PATH;
  const originalNodeEnv = process.env.NODE_ENV;
  const createdDirs: string[] = [];

  afterEach(async () => {
    process.env.ACP_TRACE_LOGS_ENABLED = originalEnabled;
    process.env.ACP_TRACE_LOGS_PATH = originalPath;
    process.env.NODE_ENV = originalNodeEnv;

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

    const logger = new AcpTraceLogger();
    logger.log('session-1', 'raw_acp_event', { eventType: 'acp_session_update' });
    logger.log('session-1', 'translated_delta', { type: 'agent_message' });
    logger.closeSession('session-1');
    await waitForFlush();

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const contents = readFileSync(join(dir, files[0]!), 'utf-8').trim().split('\n');
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

    const logger = new AcpTraceLogger();
    logger.log('session-1', 'raw_acp_event', { eventType: 'acp_session_update' });
    logger.closeSession('session-1');
    await waitForFlush();

    const [fileName] = await readdir(dir);
    expect(fileName).toBeDefined();
    const filePath = join(dir, fileName!);
    const oldMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const oldDate = new Date(oldMs);
    utimesSync(filePath, oldDate, oldDate);

    logger.cleanupOldLogs(7);
    const filesAfter = await readdir(dir);
    expect(filesAfter).toHaveLength(0);
  });
});
