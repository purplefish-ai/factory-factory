import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSessionHistoryLoaderService } from './claude-session-history-loader.service';

function encodeProjectPath(cwd: string): string {
  const windowsPathMatch = cwd.match(/^([A-Za-z]):[\\/]/);
  if (windowsPathMatch) {
    const driveLetter = windowsPathMatch[1];
    const rest = cwd.slice(2);
    return `${driveLetter}${rest.replace(/[\\/]/g, '-')}`;
  }

  return cwd.replace(/\//g, '-');
}

function writeSessionFile(params: {
  claudeConfigDir: string;
  cwd: string;
  providerSessionId: string;
  entries: Array<Record<string, unknown> | string>;
}): string {
  const projectDir = join(params.claudeConfigDir, 'projects', encodeProjectPath(params.cwd));
  mkdirSync(projectDir, { recursive: true });

  const sessionFilePath = join(projectDir, `${params.providerSessionId}.jsonl`);
  const lines = params.entries.map((entry) =>
    typeof entry === 'string' ? entry : JSON.stringify(entry)
  );
  writeFileSync(sessionFilePath, lines.join('\n'), 'utf-8');
  return sessionFilePath;
}

describe('claudeSessionHistoryLoaderService', () => {
  let tempDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ff-claude-history-'));
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    if (typeof originalClaudeConfigDir === 'string') {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      process.env.CLAUDE_CONFIG_DIR = undefined;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips loading when providerSessionId is missing', async () => {
    const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: null,
      workingDir: '/tmp/work',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'missing_provider_session_id' });
  });

  it('skips loading when providerSessionId is unsafe', async () => {
    const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: '../../etc/passwd',
      workingDir: '/tmp/work',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'invalid_provider_session_id' });
  });

  it('loads and parses history from Claude session JSONL', async () => {
    const providerSessionId = 'provider-session-1';
    const cwd = '/Users/test/project';
    const filePath = writeSessionFile({
      claudeConfigDir: tempDir,
      cwd,
      providerSessionId,
      entries: [
        '{not-json}',
        { type: 'summary', summary: 'ignore me' },
        {
          type: 'user',
          sessionId: providerSessionId,
          timestamp: '2026-02-14T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'assistant',
          sessionId: providerSessionId,
          timestamp: '2026-02-14T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'thinking...' },
              { type: 'text', text: 'hi' },
            ],
          },
        },
        {
          type: 'assistant',
          sessionId: providerSessionId,
          timestamp: '2026-02-14T00:00:02.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } }],
          },
        },
        {
          type: 'user',
          sessionId: providerSessionId,
          timestamp: '2026-02-14T00:00:03.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
          },
        },
      ],
    });

    const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId,
      workingDir: cwd,
    });

    expect(result).toMatchObject({ status: 'loaded', filePath });
    if (result.status !== 'loaded') {
      return;
    }

    expect(result.history).toEqual([
      {
        type: 'user',
        content: 'hello',
        timestamp: '2026-02-14T00:00:00.000Z',
      },
      {
        type: 'thinking',
        content: 'thinking...',
        timestamp: '2026-02-14T00:00:01.000Z',
      },
      {
        type: 'assistant',
        content: 'hi',
        timestamp: '2026-02-14T00:00:01.000Z',
      },
      {
        type: 'tool_use',
        content: 'Read',
        toolName: 'Read',
        toolId: 'tool-1',
        toolInput: { path: 'a.ts' },
        timestamp: '2026-02-14T00:00:02.000Z',
      },
      {
        type: 'tool_result',
        content: 'ok',
        toolId: 'tool-1',
        timestamp: '2026-02-14T00:00:03.000Z',
      },
    ]);
  });

  it('falls back to scanning all project directories when cwd differs', async () => {
    const providerSessionId = 'provider-session-2';
    const originalCwd = '/Users/test/original';
    writeSessionFile({
      claudeConfigDir: tempDir,
      cwd: originalCwd,
      providerSessionId,
      entries: [
        {
          type: 'user',
          sessionId: providerSessionId,
          message: { role: 'user', content: 'hello from original cwd' },
        },
      ],
    });

    const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId,
      workingDir: '/Users/test/different',
    });

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      return;
    }
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      type: 'user',
      content: 'hello from original cwd',
    });
  });

  it('returns not_found when session file does not exist', async () => {
    const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: 'missing-session',
      workingDir: '/Users/test/missing',
    });

    expect(result).toEqual({ status: 'not_found' });
  });

  it('uses non-epoch fallback timestamps when history entries have invalid timestamps', async () => {
    const providerSessionId = 'provider-session-invalid-ts';
    const cwd = '/Users/test/project';
    writeSessionFile({
      claudeConfigDir: tempDir,
      cwd,
      providerSessionId,
      entries: [
        {
          type: 'user',
          sessionId: providerSessionId,
          timestamp: 'not-a-date',
          message: { role: 'user', content: 'first' },
        },
        {
          type: 'assistant',
          sessionId: providerSessionId,
          createdAt: 'also-not-a-date',
          message: {
            role: 'assistant',
            timestamp: 'still-bad',
            content: 'second',
          },
        },
      ],
    });

    const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId,
      workingDir: cwd,
    });

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      return;
    }

    const firstTs = Date.parse(result.history[0]?.timestamp ?? '');
    const secondTs = Date.parse(result.history[1]?.timestamp ?? '');
    expect(firstTs).toBeGreaterThan(Date.parse('2000-01-01T00:00:00.000Z'));
    expect(secondTs).toBeGreaterThanOrEqual(firstTs);
  });

  it('returns error when the located session path cannot be read as a file', async () => {
    const providerSessionId = 'provider-session-dir';
    const cwd = '/Users/test/project-dir';
    const projectDir = join(tempDir, 'projects', encodeProjectPath(cwd));
    mkdirSync(projectDir, { recursive: true });
    const directoryPath = join(projectDir, `${providerSessionId}.jsonl`);
    mkdirSync(directoryPath, { recursive: true });

    const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId,
      workingDir: cwd,
    });

    expect(result).toEqual({
      status: 'error',
      reason: 'read_failed',
      filePath: directoryPath,
    });
  });
});
