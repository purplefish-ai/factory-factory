import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpClientHandler } from './acp-client-handler';
import {
  createManagerTestHarness,
  mockAcpClients,
  mockLoadSession,
  mockNewSession,
  mockPrompt,
  setupSuccessfulSpawn,
} from './acp-runtime-manager.test-harness';
import {
  defaultConfigOptions,
  defaultContext,
  defaultHandlers,
  defaultOptions,
  exitChildAfterSigterm,
} from './acp-runtime-manager.test-helpers';

describe('observed empty provider conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcpClients.length = 0;
  });
  it('retains only identity proof across stopping a new session until explicitly forgotten', async () => {
    const { manager } = createManagerTestHarness();
    const child = setupSuccessfulSpawn();
    exitChildAfterSigterm(child);
    const handle = await manager.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    expect(
      manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', handle.providerSessionId)
    ).toBe(true);
    expect(manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', 'another-identity')).toBe(
      false
    );
    expect(
      manager.hasObservedEmptyProviderSession('session-1', 'CODEX', handle.providerSessionId)
    ).toBe(false);
    await manager.stopClient('session-1');
    expect(manager.getClient('session-1')).toBeUndefined();
    expect(
      manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', handle.providerSessionId)
    ).toBe(true);
    manager.forgetObservedEmptyProviderSession('session-1');
    expect(
      manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', handle.providerSessionId)
    ).toBe(false);
  });

  it('revokes empty proof before even a failed first prompt reaches the provider', async () => {
    const { manager } = createManagerTestHarness();
    const child = setupSuccessfulSpawn();
    exitChildAfterSigterm(child);
    const handle = await manager.getOrCreateClient(
      'session-1',
      defaultOptions(),
      defaultHandlers(),
      defaultContext()
    );
    mockPrompt.mockImplementationOnce(() => {
      expect(
        manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', handle.providerSessionId)
      ).toBe(false);
      throw new Error('provider disconnected');
    });
    await expect(
      manager.sendPrompt('session-1', [{ type: 'text', text: 'hello' }])
    ).rejects.toThrow('provider disconnected');
    await manager.stopClient('session-1');
    expect(
      manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', handle.providerSessionId)
    ).toBe(false);
  });

  it.each([
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Autonomous response' },
    },
    {
      sessionUpdate: 'plan',
      entries: [{ content: 'Review implementation', priority: 'medium', status: 'pending' }],
    },
  ] satisfies SessionUpdate[])(
    'revokes proof on $sessionUpdate activity without a local prompt',
    async (update) => {
      const { manager } = createManagerTestHarness();
      const child = setupSuccessfulSpawn();
      exitChildAfterSigterm(child);
      const handle = await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      await (mockAcpClients[0] as AcpClientHandler).sessionUpdate({
        sessionId: handle.providerSessionId,
        update,
      });
      await manager.stopClient('session-1');
      expect(
        manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', handle.providerSessionId)
      ).toBe(false);
    }
  );

  it('forgets empty proof when installed candidate startup fails before event dispatch', async () => {
    const { manager } = createManagerTestHarness();
    const child = setupSuccessfulSpawn();
    exitChildAfterSigterm(child);
    await expect(
      manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        {
          ...defaultHandlers(),
          onSessionId: () => Promise.reject(new Error('identity persistence failed')),
        },
        defaultContext()
      )
    ).rejects.toThrow('identity persistence failed');
    expect(
      manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', 'provider-session-123')
    ).toBe(false);
  });

  it.each(['resumed', 'resume_fallback'] as const)(
    'never infers an empty conversation from %s',
    async (outcome) => {
      const { manager } = createManagerTestHarness();
      const firstChild = setupSuccessfulSpawn();
      exitChildAfterSigterm(firstChild);
      await manager.getOrCreateClient(
        'session-1',
        defaultOptions(),
        defaultHandlers(),
        defaultContext()
      );
      await manager.stopClient('session-1');
      expect(
        manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', 'provider-session-123')
      ).toBe(true);
      const child = setupSuccessfulSpawn({ loadSession: true });
      exitChildAfterSigterm(child);
      if (outcome === 'resume_fallback') {
        mockLoadSession.mockRejectedValueOnce(new Error('history unavailable'));
        mockNewSession.mockResolvedValueOnce({
          sessionId: 'replacement-session',
          configOptions: defaultConfigOptions(),
        });
      }
      const handle = await manager.getOrCreateClient(
        'session-1',
        { ...defaultOptions(), resumeProviderSessionId: 'provider-session-123' },
        { ...defaultHandlers(), onProviderIdentityRollover: () => Promise.resolve() },
        defaultContext()
      );
      expect(handle.sessionCreationOutcome.kind).toBe(outcome);
      await manager.stopClient('session-1');
      expect(
        manager.hasObservedEmptyProviderSession('session-1', 'CLAUDE', handle.providerSessionId)
      ).toBe(false);
    }
  );
});
