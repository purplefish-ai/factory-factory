import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexSessionHistoryLoaderService } from './codex-session-history-loader.service';

function writeSessionFile(params: {
  codexHomeDir: string;
  relativeDir: string;
  fileName: string;
  entries: Array<Record<string, unknown> | string>;
}): string {
  const sessionDir = join(params.codexHomeDir, 'sessions', params.relativeDir);
  mkdirSync(sessionDir, { recursive: true });

  const sessionFilePath = join(sessionDir, params.fileName);
  const lines = params.entries.map((entry) =>
    typeof entry === 'string' ? entry : JSON.stringify(entry)
  );
  writeFileSync(sessionFilePath, lines.join('\n'), 'utf-8');
  return sessionFilePath;
}

describe('codexSessionHistoryLoaderService', () => {
  let tempDir: string;
  let originalCodexHome: string | undefined;
  let originalCodexSessionsDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ff-codex-history-'));
    originalCodexHome = process.env.CODEX_HOME;
    originalCodexSessionsDir = process.env.CODEX_SESSIONS_DIR;
    process.env.CODEX_HOME = tempDir;
    process.env.CODEX_SESSIONS_DIR = undefined;
  });

  afterEach(() => {
    if (typeof originalCodexHome === 'string') {
      process.env.CODEX_HOME = originalCodexHome;
    } else {
      process.env.CODEX_HOME = undefined;
    }
    if (typeof originalCodexSessionsDir === 'string') {
      process.env.CODEX_SESSIONS_DIR = originalCodexSessionsDir;
    } else {
      process.env.CODEX_SESSIONS_DIR = undefined;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('skips loading when providerSessionId is missing', async () => {
    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: null,
      workingDir: '/tmp/work',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'missing_provider_session_id' });
  });

  it('skips loading when providerSessionId is unsafe', async () => {
    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: '../../etc/passwd',
      workingDir: '/tmp/work',
    });

    expect(result).toEqual({ status: 'skipped', reason: 'invalid_provider_session_id' });
  });

  it('loads and parses history from Codex session JSONL', async () => {
    const providerSessionId = '019c5dad-78c4-7d02-8f3a-e5cb6f68ae5b';
    const cwd = '/Users/test/project';
    const filePath = writeSessionFile({
      codexHomeDir: tempDir,
      relativeDir: '2026/02/14',
      fileName: `rollout-2026-02-14T00-00-00-${providerSessionId}.jsonl`,
      entries: [
        '{not-json}',
        {
          type: 'session_meta',
          payload: {
            id: providerSessionId,
            cwd,
          },
        },
        {
          timestamp: '2026-02-14T00:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'hello',
          },
        },
        {
          timestamp: '2026-02-14T00:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'hi',
          },
        },
        {
          timestamp: '2026-02-14T00:00:03.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_reasoning',
            text: 'reasoning text',
          },
        },
        {
          timestamp: '2026-02-14T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call-1',
            arguments: '{"cmd":"git status --short"}',
          },
        },
        {
          timestamp: '2026-02-14T00:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: 'M package.json',
          },
        },
      ],
    });

    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
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
        timestamp: '2026-02-14T00:00:01.000Z',
      },
      {
        type: 'assistant',
        content: 'hi',
        timestamp: '2026-02-14T00:00:02.000Z',
      },
      {
        type: 'thinking',
        content: 'reasoning text',
        timestamp: '2026-02-14T00:00:03.000Z',
      },
      {
        type: 'tool_use',
        content: '',
        timestamp: '2026-02-14T00:00:04.000Z',
        toolName: 'exec_command',
        toolId: 'call-1',
        toolInput: { cmd: 'git status --short' },
      },
      {
        type: 'tool_result',
        content: 'M package.json',
        timestamp: '2026-02-14T00:00:05.000Z',
        toolId: 'call-1',
      },
    ]);
  });

  it('records raw function args when response_item arguments are not valid JSON objects', async () => {
    const providerSessionId = 'session-fn-args';
    const cwd = '/Users/test/project';
    writeSessionFile({
      codexHomeDir: tempDir,
      relativeDir: '2026/02/14',
      fileName: `rollout-2026-02-14T00-00-00-${providerSessionId}.jsonl`,
      entries: [
        {
          type: 'session_meta',
          payload: {
            id: providerSessionId,
            cwd,
          },
        },
        {
          timestamp: '2026-02-14T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call-2',
            arguments: 'not-json',
          },
        },
      ],
    });

    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId,
      workingDir: cwd,
    });

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      return;
    }

    expect(result.history).toEqual([
      {
        type: 'tool_use',
        content: '',
        timestamp: '2026-02-14T00:00:04.000Z',
        toolName: 'exec_command',
        toolId: 'call-2',
        toolInput: { rawArguments: 'not-json' },
      },
    ]);
  });

  it('ignores response_item reasoning because event_msg reasoning is the source of thought history', async () => {
    const providerSessionId = 'session-reasoning-1';
    const cwd = '/Users/test/project';
    writeSessionFile({
      codexHomeDir: tempDir,
      relativeDir: '2026/02/15',
      fileName: `rollout-2026-02-15T00-00-00-${providerSessionId}.jsonl`,
      entries: [
        {
          type: 'session_meta',
          payload: {
            id: providerSessionId,
            cwd,
          },
        },
        {
          timestamp: '2026-02-15T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: '**Counting files in directory**' }],
            content: null,
          },
        },
      ],
    });

    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId,
      workingDir: cwd,
    });

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      return;
    }

    expect(result.history).toEqual([]);
  });

  it('prefers a matching cwd when multiple files have the same providerSessionId', async () => {
    const providerSessionId = 'session-dup-1';
    writeSessionFile({
      codexHomeDir: tempDir,
      relativeDir: '2026/02/13',
      fileName: `rollout-2026-02-13T00-00-00-${providerSessionId}.jsonl`,
      entries: [
        {
          type: 'session_meta',
          payload: { id: providerSessionId, cwd: '/Users/test/other' },
        },
        {
          timestamp: '2026-02-14T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'from other cwd' },
        },
      ],
    });
    const expectedPath = writeSessionFile({
      codexHomeDir: tempDir,
      relativeDir: '2026/02/14',
      fileName: `rollout-2026-02-14T00-00-00-${providerSessionId}.jsonl`,
      entries: [
        {
          type: 'session_meta',
          payload: { id: providerSessionId, cwd: '/Users/test/match' },
        },
        {
          timestamp: '2026-02-14T00:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'from matching cwd' },
        },
      ],
    });

    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId,
      workingDir: '/Users/test/match',
    });

    expect(result).toMatchObject({ status: 'loaded', filePath: expectedPath });
    if (result.status !== 'loaded') {
      return;
    }
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      type: 'user',
      content: 'from matching cwd',
    });
  });

  it('returns not_found when candidate filename matches but session_meta id does not', async () => {
    const providerSessionId = 'session-meta-mismatch';
    writeSessionFile({
      codexHomeDir: tempDir,
      relativeDir: '2026/02/14',
      fileName: `rollout-2026-02-14T00-00-00-${providerSessionId}.jsonl`,
      entries: [
        {
          type: 'session_meta',
          payload: { id: 'different-session-id', cwd: '/Users/test/project' },
        },
        {
          timestamp: '2026-02-14T00:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'wrong session transcript' },
        },
      ],
    });

    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId,
      workingDir: '/Users/test/project',
    });

    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns not_found when session file does not exist', async () => {
    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: 'missing-session',
      workingDir: '/Users/test/missing',
    });

    expect(result).toEqual({ status: 'not_found' });
  });

  it('loads history when providerSessionId includes sess_ prefix but file/meta use unprefixed id', async () => {
    const unprefixedSessionId = '019c620a-8a8d-7b33-9b20-f9bd7c6512a7';
    const providerSessionId = `sess_${unprefixedSessionId}`;
    const cwd = '/Users/test/project';
    const filePath = writeSessionFile({
      codexHomeDir: tempDir,
      relativeDir: '2026/02/15',
      fileName: `rollout-2026-02-15T00-00-00-${unprefixedSessionId}.jsonl`,
      entries: [
        {
          type: 'session_meta',
          payload: {
            id: unprefixedSessionId,
            cwd,
          },
        },
        {
          timestamp: '2026-02-15T00:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'hello from prefixed id',
          },
        },
      ],
    });

    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
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
        content: 'hello from prefixed id',
        timestamp: '2026-02-15T00:00:01.000Z',
      },
    ]);
  });

  it('uses non-epoch fallback timestamps when entries have invalid timestamps', async () => {
    const providerSessionId = 'session-invalid-ts';
    const cwd = '/Users/test/project';
    writeSessionFile({
      codexHomeDir: tempDir,
      relativeDir: '2026/02/14',
      fileName: `rollout-2026-02-14T00-00-00-${providerSessionId}.jsonl`,
      entries: [
        {
          type: 'session_meta',
          payload: {
            id: providerSessionId,
            cwd,
          },
        },
        {
          timestamp: 'not-a-date',
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'first',
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: 'second',
          },
        },
      ],
    });

    const result = await codexSessionHistoryLoaderService.loadSessionHistory({
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
});
