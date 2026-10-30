import { describe, expect, it, vi } from 'vitest';
import { createFakeApplicationGraph } from '@/test-utils/application-graph';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import { sessionRouter } from './session.trpc';
import type { RequestTrustInfo } from './trpc';

function setup(requestTrust: RequestTrustInfo) {
  const graph = createFakeApplicationGraph('session-account-creation');
  const create = vi.fn().mockResolvedValue({ outcome: 'created', session: { id: 'created' } });
  const caller = sessionRouter.createCaller({
    requestTrust,
    appContext: {
      ...graph,
      services: {
        ...graph.services,
        configService: unsafeCoerce({
          getMaxSessionsPerWorkspace: () => 3,
          getCorsConfig: () => ({
            allowedOrigins: ['http://localhost:3000'],
            trustedLocalCidrs: [],
            disableCorsChecks: false,
          }),
        }),
        sessionProviderResolverService: unsafeCoerce({
          resolveSessionProvider: async () => 'CODEX',
        }),
        cliHealthService: unsafeCoerce({
          checkHealth: async () => ({
            claude: { isInstalled: true },
            codex: { isInstalled: true, isAuthenticated: true },
          }),
        }),
        sessionDataService: unsafeCoerce({ createAgentSessionWithinWorkspaceLimit: create }),
        sessionLifecycleService: unsafeCoerce({ startSession: vi.fn() }),
      },
    },
  });
  return { caller, create };
}

describe('account-bound session creation trust', () => {
  it.each([
    { isLocal: false, remoteAddress: '203.0.113.2' },
    { isLocal: true, remoteAddress: '127.0.0.1', origin: 'https://untrusted.example' },
  ])('rejects explicit account selection in both public mutations (%j)', async (trust) => {
    const { caller, create } = setup(trust);
    const input = { workspaceId: 'w', workflow: 'followup', codexAccountId: 'managed' };
    await expect(caller.createSession(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.createAndStartSession(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves Auto creation for untrusted HTTP callers', async () => {
    const { caller, create } = setup({ isLocal: false, remoteAddress: '203.0.113.2' });
    await expect(caller.createSession({ workspaceId: 'w', workflow: 'followup' })).resolves.toEqual(
      { id: 'created' }
    );
    expect(create).toHaveBeenCalledOnce();
  });
  it('accepts an explicit account from a local browser with an allowed origin', async () => {
    const { caller, create } = setup({
      isLocal: true,
      remoteAddress: '127.0.0.1',
      origin: 'http://localhost:3000',
    });
    await expect(
      caller.createSession({ workspaceId: 'w', workflow: 'followup', codexAccountId: 'managed' })
    ).resolves.toEqual({ id: 'created' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ codexAccountId: 'managed' }));
  });
});
