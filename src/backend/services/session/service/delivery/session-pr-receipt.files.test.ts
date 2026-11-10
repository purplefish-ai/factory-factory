import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  closedSessionAccessor: {
    findBySessionIdWithWorkspace: mocks.archives,
    findByIdWithWorkspace: async (id: string) =>
      (await mocks.archives()).find((archive: { id: string }) => archive.id === id) ?? null,
  },
}));
vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: { findById: mocks.session },
}));
vi.mock('@/backend/services/codex-accounts', () => ({
  codexAccountService: { getHistoryContext: mocks.codexHistoryContext },
}));

import { findPRDeliveryReceipt } from './session-pr-receipt';

const marker = prEventMarker('delivery-1');
const worktreePath = '/work/repo';
let tempDir: string;
let originalClaudeConfigDir: string | undefined;
let originalCodexSessionsDir: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  tempDir = mkdtempSync(join(tmpdir(), 'ff-pr-receipt-'));
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  originalCodexSessionsDir = process.env.CODEX_SESSIONS_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude');
  process.env.CODEX_SESSIONS_DIR = join(tempDir, 'default-codex-sessions');
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
  if (typeof originalCodexSessionsDir === 'string') {
    process.env.CODEX_SESSIONS_DIR = originalCodexSessionsDir;
  } else {
    Reflect.deleteProperty(process.env, 'CODEX_SESSIONS_DIR');
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

function writeCodexHistory(
  entries: unknown[],
  sessionsDir = join(tempDir, 'codex-sessions'),
  workingDir = worktreePath
): void {
  writeJsonl(join(sessionsDir, '2026', '10', '30', 'rollout-x-provider-1.jsonl'), [
    { type: 'session_meta', payload: { id: 'provider-1', cwd: workingDir } },
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
        {
          id: 'closed-1',
          sessionId: 'main',
          workspaceId: 'workspace-1',
          provider,
          transcriptPath,
          workspace: { id: 'workspace-1', worktreePath: repo },
        },
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

  it.each(['lexical', 'symlink', 'workspace'] as const)(
    'does not use a %s escape as archived receipt evidence',
    async (unsafeKind) => {
      mocks.session.mockResolvedValue(null);
      const repo = join(tempDir, 'repo');
      mkdirSync(repo);
      const outside = join(tempDir, 'outside.json');
      const transcriptPath = unsafeKind === 'lexical' ? '../outside.json' : 'archive.json';
      const content = JSON.stringify({
        sessionId: 'main',
        workspaceId: unsafeKind === 'workspace' ? 'another-workspace' : 'workspace-1',
        metadata: { provider: 'CLAUDE', providerSessionId: 'provider-1' },
        messages: [],
      });
      if (unsafeKind === 'symlink') {
        writeFileSync(outside, content);
        symlinkSync(outside, join(repo, transcriptPath));
      } else {
        writeFileSync(join(repo, transcriptPath), content);
      }
      mocks.archives.mockResolvedValue([
        {
          id: 'closed-1',
          sessionId: 'main',
          workspaceId: 'workspace-1',
          provider: 'CLAUDE',
          transcriptPath,
          workspace: { id: 'workspace-1', worktreePath: repo },
        },
      ]);
      writeJsonl(
        join(tempDir, 'claude', 'projects', repo.replace(/\//g, '-'), 'provider-1.jsonl'),
        claudeDelivered
      );
      await expect(findPRDeliveryReceipt('main', 'delivery-1')).resolves.toBe('unavailable');
    }
  );

  it.each(['absent', 'missing', 'account-unavailable'] as const)(
    'does not use another account or default history when scoped history is %s',
    async (status) => {
      mocks.session.mockResolvedValue(null);
      const repo = join(tempDir, 'repo');
      const transcriptPath = 'transcripts/main.json';
      mkdirSync(join(repo, 'transcripts'), { recursive: true });
      writeFileSync(
        join(repo, transcriptPath),
        JSON.stringify({
          sessionId: 'main',
          workspaceId: 'workspace-1',
          metadata: {
            provider: 'CODEX',
            providerSessionId: 'provider-1',
            codexAccountId: 'account-1',
          },
          // Archive text is never delivery evidence, either.
          messages: [{ type: 'user', content: marker }],
        })
      );
      mocks.archives.mockResolvedValue([
        {
          id: 'closed-1',
          sessionId: 'main',
          workspaceId: 'workspace-1',
          provider: 'CODEX',
          transcriptPath,
          workspace: { id: 'workspace-1', worktreePath: repo },
        },
      ]);
      const requested = join(tempDir, 'requested-account');
      mkdirSync(requested);
      writeCodexHistory(codexDelivered, join(tempDir, 'another-account'), repo);
      writeCodexHistory(codexDelivered, configService.getCodexSessionsDir(), repo);
      if (status === 'absent') {
        writeCodexHistory([], requested, repo);
      }
      if (status === 'account-unavailable') {
        mocks.codexHistoryContext.mockRejectedValue(new Error('Account unavailable'));
      } else {
        mocks.codexHistoryContext.mockResolvedValue({ sessionsDir: requested });
      }
      await expect(findPRDeliveryReceipt('main', 'delivery-1')).resolves.toBe(
        status === 'absent' ? 'absent' : 'unavailable'
      );
      expect(mocks.codexHistoryContext).toHaveBeenCalledExactlyOnceWith('account-1');
    }
  );

  it.each([undefined, null])(
    'retains legacy default-history lookup for archived account %s without a live binding',
    async (codexAccountId) => {
      mocks.session.mockResolvedValue(null);
      const repo = join(tempDir, 'repo');
      mkdirSync(join(repo, 'transcripts'), { recursive: true });
      writeFileSync(
        join(repo, 'transcripts/main.json'),
        JSON.stringify({
          sessionId: 'main',
          metadata: { provider: 'CODEX', providerSessionId: 'provider-1', codexAccountId },
          messages: [],
        })
      );
      mocks.archives.mockResolvedValue([
        {
          id: 'closed-1',
          sessionId: 'main',
          workspaceId: 'workspace-1',
          provider: 'CODEX',
          transcriptPath: 'transcripts/main.json',
          workspace: { id: 'workspace-1', worktreePath: repo },
        },
      ]);
      writeCodexHistory(codexDelivered, configService.getCodexSessionsDir(), repo);
      await expect(findPRDeliveryReceipt('main', 'delivery-1')).resolves.toBe('delivered');
      expect(mocks.codexHistoryContext).not.toHaveBeenCalled();
    }
  );
});
