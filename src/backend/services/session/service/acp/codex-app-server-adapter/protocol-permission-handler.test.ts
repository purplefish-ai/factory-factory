import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { AdapterSession } from './adapter-state';
import { buildCommandApprovalScopeKey } from './command-metadata';
import { handleCodexServerPermissionRequest } from './protocol-permission-handler';

function createSession(): AdapterSession {
  return {
    sessionId: 'sess_thread_1',
    threadId: 'thread_1',
    cwd: '/tmp/workspace',
    defaults: {
      model: 'gpt-5',
      approvalPolicy: 'on-failure',
      sandboxPolicy: { type: 'workspaceWrite' },
      reasoningEffort: 'medium',
      collaborationMode: 'default',
    },
    activeTurn: null,
    toolCallsByItemId: new Map(),
    syntheticallyCompletedToolItemIds: new Set(),
    reasoningDeltaItemIds: new Set(),
    planTextByItemId: new Map(),
    planApprovalRequestedByTurnId: new Set(),
    pendingPlanApprovalsByTurnId: new Map(),
    pendingTurnCompletionsByTurnId: new Map(),
    commandApprovalScopes: new Set(),
    replayedTurnItemKeys: new Set(),
  };
}

describe('protocol-permission-handler', () => {
  it('responds with unsupported payload for malformed requests', async () => {
    const sessionIdByThreadId = new Map<string, string>();
    const sessions = new Map<string, AdapterSession>();
    const connection = { requestPermission: vi.fn() };
    const codex = { respondSuccess: vi.fn(), respondError: vi.fn() };
    const emitSessionUpdate = vi.fn(async () => undefined);
    const reportShapeDrift = vi.fn();

    await handleCodexServerPermissionRequest({
      request: { id: 1, method: 'unsupported/method', params: {} },
      sessionIdByThreadId,
      sessions,
      connection,
      codex,
      emitSessionUpdate,
      reportShapeDrift,
    });

    expect(codex.respondError).toHaveBeenCalledWith(1, {
      code: -32_602,
      message: 'Unsupported codex server request payload',
    });
    expect(reportShapeDrift).toHaveBeenCalledWith(
      'malformed_server_request',
      expect.objectContaining({ method: 'unsupported/method' })
    );
  });

  it.each([
    { name: 'padded id', ids: ['  color  '], rawKeys: false },
    { name: 'raw padded id', ids: ['  color  '], rawKeys: true },
    { name: 'empty id', ids: [''] },
    { name: 'whitespace id', ids: ['   '] },
    { name: 'mixed multi-question ids', ids: ['  color  ', '', '   ', 'plain'] },
  ])(
    'restores raw Codex question ids from frontend answer keys for $name',
    async ({ ids, rawKeys }) => {
      const session = createSession();
      const questions = ids.map((id, index) => ({
        id,
        header: 'Choice',
        question: `Question ${index}?`,
        isOther: false,
        isSecret: false,
        options: [{ label: 'Blue', description: 'Color' }],
      }));
      const permission = {
        outcome: { outcome: 'selected', optionId: 'allow_once' },
        _meta: {
          factoryFactory: {
            toolUserInputAnswers: {
              ...Object.fromEntries(
                questions.map((question) => [
                  rawKeys ? question.id : question.id.trim() || question.question,
                  [' Blue ', '', 42],
                ])
              ),
              unknown: ['ignored'],
            },
          },
        },
      } satisfies RequestPermissionResponse;
      const codex = { respondSuccess: vi.fn(), respondError: vi.fn() };
      const emitSessionUpdate = vi.fn(async () => undefined);

      await handleCodexServerPermissionRequest({
        request: {
          id: 3,
          method: 'item/tool/requestUserInput',
          params: { threadId: 'thread_1', turnId: 'turn_1', itemId: 'item_1', questions },
        },
        sessionIdByThreadId: new Map([['thread_1', session.sessionId]]),
        sessions: new Map([[session.sessionId, session]]),
        connection: { requestPermission: vi.fn(async () => permission) },
        codex,
        emitSessionUpdate,
        reportShapeDrift: vi.fn(),
      });

      const answers = Object.fromEntries(ids.map((id) => [id, { answers: ['Blue'] }]));
      expect(codex.respondSuccess).toHaveBeenCalledWith(3, { answers });
      expect(codex.respondError).not.toHaveBeenCalled();
      expect(emitSessionUpdate).toHaveBeenLastCalledWith(
        session.sessionId,
        expect.objectContaining({
          status: 'completed',
          rawOutput: { answers },
        })
      );
    }
  );

  it('auto-approves command requests when allow_always scope exists', async () => {
    const session = createSession();
    const scopeKey = buildCommandApprovalScopeKey({
      command: 'cat README.md',
      cwd: '/tmp/workspace',
    });
    expect(scopeKey).toBeTruthy();
    if (scopeKey) {
      session.commandApprovalScopes.add(scopeKey);
    }

    const sessionIdByThreadId = new Map<string, string>([['thread_1', 'sess_thread_1']]);
    const sessions = new Map<string, AdapterSession>([['sess_thread_1', session]]);
    const connection = { requestPermission: vi.fn() };
    const codex = { respondSuccess: vi.fn(), respondError: vi.fn() };
    const emitSessionUpdate = vi.fn(async () => undefined);
    const reportShapeDrift = vi.fn();

    await handleCodexServerPermissionRequest({
      request: {
        id: 2,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread_1',
          turnId: 'turn_1',
          itemId: 'item_1',
          command: 'cat README.md',
          cwd: '/tmp/workspace',
        },
      },
      sessionIdByThreadId,
      sessions,
      connection,
      codex,
      emitSessionUpdate,
      reportShapeDrift,
    });

    expect(connection.requestPermission).not.toHaveBeenCalled();
    expect(codex.respondSuccess).toHaveBeenCalledWith(2, { decision: 'accept' });
    expect(emitSessionUpdate).toHaveBeenCalled();
  });
});
