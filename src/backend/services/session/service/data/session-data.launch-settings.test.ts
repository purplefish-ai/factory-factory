import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { createLifecycleTestSession } from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';
import { sessionDataService } from './session-data.service';
vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: { create: vi.fn(), createWithinWorkspaceLimit: vi.fn() },
}));
vi.mock('./session-provider-resolver.service', () => ({
  sessionProviderResolverService: {
    resolveSessionDefaults: vi.fn().mockResolvedValue({ provider: 'CODEX', model: 'model' }),
  },
}));
describe('durable session launch settings', () => {
  beforeEach(() => {
    vi.mocked(agentSessionAccessor.create).mockResolvedValue(createLifecycleTestSession());
    vi.mocked(agentSessionAccessor.createWithinWorkspaceLimit).mockResolvedValue({
      outcome: 'created',
      session: createLifecycleTestSession(),
    });
  });
  it.each(['ordinary', 'limited'] as const)(
    'persists native-default and Plan-off intent atomically via %s creation',
    async (kind) => {
      const input = {
        workspaceId: 'workspace',
        workflow: 'followup',
        accessMode: 'agent',
        reasoningEffort: null,
        planModeEnabled: false,
      };
      if (kind === 'ordinary') {
        await sessionDataService.createAgentSession(input);
      } else {
        await sessionDataService.createAgentSessionWithinWorkspaceLimit({
          ...input,
          maxSessions: 2,
        });
      }
      const writer =
        kind === 'ordinary'
          ? agentSessionAccessor.create
          : agentSessionAccessor.createWithinWorkspaceLimit;
      expect(writer).toHaveBeenCalledWith(
        expect.objectContaining({
          providerMetadata: {
            launchSettings: {
              accessMode: 'agent',
              reasoningEffort: null,
              planModeEnabled: false,
              applied: false,
            },
          },
        })
      );
    }
  );
});
