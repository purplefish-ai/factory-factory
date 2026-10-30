import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import { prEventMarker } from '@/shared/pr-monitoring';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  archives: vi.fn(),
  codexHistoryContext: vi.fn(),
}));
vi.mock('@/backend/services/session/resources/closed-session.accessor', () => ({
  closedSessionAccessor: { findBySessionIdWithWorkspace: mocks.archives },
}));
vi.mock('@/backend/services/session/service/data/session-data.service', () => ({
  sessionDataService: { findAgentSessionById: mocks.session },
}));
vi.mock('@/backend/services/codex-accounts', () => ({
  codexAccountService: { getHistoryContext: mocks.codexHistoryContext },
}));

import { findPRDeliveryReceipt } from './session-pr-receipt';

const marker = prEventMarker('delivery-1');
const worktreePath = '/work/repo';
let tempDir: string;
let originalClaudeConfigDir: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  tempDir = mkdtempSync(join(tmpdir(), 'ff-pr-receipt-'));
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude');
  configService.reload();
  mocks.archives.mockResolvedValue([]);
  mocks.codexHistoryContext.mockResolvedValue({ sessionsDir: join(tempDir, 'codex-sessions') });
});

afterEach(() => {
  if (typeof originalClaudeConfigDir === 'string') {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  } else {
    Reflect.deleteProperty(process.env, 'CLAUDE_CONFIG_DIR');
  }
  configService.reload();
  rmSync(tempDir, { recursive: true, force: true });
});

function writeJsonl(filePath: string, entries: unknown[]): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n'));
}

function claudeEntry(type: 'user' | 'assistant', content: unknown, extra = {}) {
  return { type, sessionId: 'provider-1', message: { role: type, content }, ...extra };
}

function writeClaudeHistory(entries: unknown[]): void {
  writeJsonl(
    join(tempDir, 'claude', 'projects', worktreePath.replace(/\//g, '-'), 'provider-1.jsonl'),
    entries
  );
}

function writeCodexHistory(entries: unknown[]): void {
  writeJsonl(join(tempDir, 'codex-sessions', '2026', '10', '30', 'rollout-x-provider-1.jsonl'), [
    { type: 'session_meta', payload: { id: 'provider-1', cwd: worktreePath } },
    ...entries,
  ]);
}

function useLiveSession(provider: 'CLAUDE' | 'CODEX') {
  mocks.session.mockResolvedValue({
    provider,
    providerSessionId: 'provider-1',
    codexAccountId: provider === 'CODEX' ? 'account-1' : null,
    workspace: { worktreePath },
  });
}

const claudeDelivered = [
  claudeEntry('assistant', [{ type: 'text', text: 'working' }]),
  claudeEntry('user', [{ type: 'text', text: `${marker}\nPR update: CI failed` }]),
];
const codexDelivered = [
  { type: 'event_msg', payload: { type: 'agent_message', message: 'working' } },
  { type: 'event_msg', payload: { type: 'user_message', message: `${marker}\nPR update` } },
];

describe('findPRDeliveryReceipt against provider transcripts', () => {
  it.each([
    ['CLAUDE', () => writeClaudeHistory(claudeDelivered)],
    ['CODEX', () => writeCodexHistory(codexDelivered)],
  ] as const)('finds a delivered %s marker in a user message', async (provider, write) => {
    useLiveSession(provider);
    write();
    await expect(findPRDeliveryReceipt('main', 'delivery-1')).resolves.toBe('delivered');
    await expect(findPRDeliveryReceipt('main', 'delivery-2')).resolves.toBe('absent');
    if (provider === 'CODEX') {
      expect(mocks.codexHistoryContext).toHaveBeenCalledWith('account-1');
    }
  });

  it.each(['CLAUDE', 'CODEX'] as const)(
    'reports %s as unavailable when the transcript is missing',
    async (provider) => {
      useLiveSession(provider);
      mkdirSync(join(tempDir, 'codex-sessions'), { recursive: true });
      await expect(findPRDeliveryReceipt('main', 'delivery-1')).resolves.toBe('unavailable');
    }
  );

  it('ignores Claude markers outside user prompt text', async () => {
    useLiveSession('CLAUDE');
    writeClaudeHistory([
      claudeEntry('assistant', [{ type: 'text', text: `${marker}\nquoted by the agent` }]),
      claudeEntry('assistant', [{ type: 'thinking', thinking: marker }]),
      claudeEntry('user', [{ type: 'tool_result', tool_use_id: 't1', content: marker }]),
      claudeEntry('user', [{ type: 'text', text: `inline ${marker} mention` }]),
      claudeEntry('user', marker, { isSidechain: true }),
      claudeEntry('user', marker, { isMeta: true }),
      claudeEntry('user', marker, { sessionId: 'another-session' }),
      { type: 'summary', summary: marker },
    ]);
    await expect(findPRDeliveryReceipt('main', 'delivery-1')).resolves.toBe('absent');
  });

  it('ignores Codex markers outside user prompt text', async () => {
    useLiveSession('CODEX');
    writeCodexHistory([
      { type: 'event_msg', payload: { type: 'agent_message', message: marker } },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: marker },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'visible prompt' },
            { type: 'input_text', text: marker },
          ],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ['user.text', 'context'],
          },
        },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: `see ${marker}` } },
    ]);
    await expect(findPRDeliveryReceipt('main', 'delivery-1')).resolves.toBe('absent');
  });

  it.each(['CLAUDE', 'CODEX'] as const)(
    'finds a %s receipt through a closed session archive',
    async (provider) => {
      mocks.session.mockResolvedValue(null);
      const repo = join(tempDir, 'repo');
      const transcriptPath = '.context/closed-sessions/main.json';
      mkdirSync(join(repo, '.context', 'closed-sessions'), { recursive: true });
      // Same shape and formatting as closed-session persistence. The message
      // list is cut off past the header probe, so only a header-only read can
      // recover the provider identity.
      const archive = JSON.stringify(
        {
          version: 1,
          sessionId: 'main',
          workspaceId: 'workspace-1',
          metadata: {
            provider,
            ...(provider === 'CODEX' ? { codexAccountId: 'account-1' } : {}),
            providerSessionId: 'provider-1',
          },
          messages: [{ type: 'user', content: 'x'.repeat(200_000) }],
        },
        null,
        2
      );
      writeFileSync(join(repo, transcriptPath), archive.slice(0, 100_000));
      mocks.archives.mockResolvedValue([
        { sessionId: 'main', provider, transcriptPath, workspace: { worktreePath: repo } },
      ]);
      if (provider === 'CLAUDE') {
        writeJsonl(
          join(tempDir, 'claude', 'projects', repo.replace(/\//g, '-'), 'provider-1.jsonl'),
          claudeDelivered
        );
      } else {
        writeJsonl(
          join(tempDir, 'codex-sessions', '2026', '10', '30', 'rollout-x-provider-1.jsonl'),
          [{ type: 'session_meta', payload: { id: 'provider-1', cwd: repo } }, ...codexDelivered]
        );
      }
      await expect(findPRDeliveryReceipt('main', 'delivery-1')).resolves.toBe('delivered');
      await expect(findPRDeliveryReceipt('main', 'delivery-2')).resolves.toBe('absent');
      if (provider === 'CODEX') {
        expect(mocks.codexHistoryContext).toHaveBeenCalledWith('account-1');
      }
    }
  );
});
