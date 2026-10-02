import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import { expect, it, vi } from 'vitest';
import type { AcpProcessHandle } from '@/backend/services/session/service/acp';
import { applyReadOnlyReviewPermissions } from '@/backend/services/session/service/lifecycle/session-permission-policy';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { CodexAppServerAcpAdapter } from './codex-app-server-acp-adapter';

it('sends review turns with read-only sandbox and no escalation even after leaving plan mode', async () => {
  const request = vi.fn((method: string) => {
    switch (method) {
      case 'initialize':
        return Promise.resolve({});
      case 'configRequirements/read':
        return Promise.resolve({
          requirements: {
            allowedApprovalPolicies: ['on-request', 'never'],
            allowedSandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
          },
        });
      case 'collaborationMode/list':
        return Promise.resolve({
          data: [
            { name: 'Default', mode: 'default' },
            { name: 'Plan', mode: 'plan' },
          ],
          nextCursor: null,
        });
      case 'model/list':
        return Promise.resolve({
          data: [
            {
              id: 'gpt-5',
              displayName: 'GPT-5',
              description: '',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [],
              inputModalities: ['text'],
              isDefault: true,
            },
          ],
          nextCursor: null,
        });
      case 'thread/start':
        return Promise.resolve({
          thread: { id: 'review-thread', cwd: '/tmp/review' },
          approvalPolicy: 'never',
          sandbox: { type: 'dangerFullAccess' },
          reasoningEffort: 'medium',
        });
      case 'thread/goal/get':
        return Promise.resolve({ goal: null });
      case 'turn/start':
        return Promise.resolve({ turn: { id: 'review-turn', status: 'completed' } });
      default:
        throw new Error(`Unexpected Codex request: ${method}`);
    }
  });
  const adapter = new CodexAppServerAcpAdapter(
    unsafeCoerce<AgentSideConnection>({
      closed: new Promise(() => {
        /* Keep the mock ACP connection open for both turns. */
      }),
      sessionUpdate: vi.fn(() => Promise.resolve()),
      requestPermission: vi.fn(),
      extNotification: vi.fn(() => Promise.resolve()),
    }),
    unsafeCoerce({ start: vi.fn(), stop: vi.fn(), request, notify: vi.fn() })
  );
  await adapter.initialize({
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  const session = await adapter.newSession({ cwd: '/tmp/review', mcpServers: [] });
  const handle = unsafeCoerce<AcpProcessHandle>({
    provider: 'CODEX',
    configOptions: session.configOptions,
  });
  await applyReadOnlyReviewPermissions(session.sessionId, handle, {
    setSessionMode: async (_id, mode) => {
      await adapter.setSessionMode({ sessionId: session.sessionId, modeId: mode });
      const response = await adapter.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'mode',
        value: mode,
      });
      return response.configOptions;
    },
    setConfigOption: async (_id, configId, value) => {
      const response = await adapter.setSessionConfigOption({
        sessionId: session.sessionId,
        configId,
        value,
      });
      return response.configOptions;
    },
  });
  for (const mode of ['plan', 'default']) {
    await adapter.setSessionMode({ sessionId: session.sessionId, modeId: mode });
    await adapter.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Review this change' }],
    });
    expect(request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' } },
        collaborationMode: expect.objectContaining({ mode }),
      })
    );
  }
});
