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
