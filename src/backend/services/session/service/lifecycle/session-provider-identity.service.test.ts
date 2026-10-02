import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AcpProviderIdentityEvent } from '@/backend/services/session/service/acp';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import type { closedSessionPersistenceService } from './closed-session-persistence.service';
import type { SessionRepository } from './session.repository';
import {
  createLifecycleTestSession,
  createLifecycleTestWorkspace,
} from './session-lifecycle.test-helpers';
import { SessionProviderIdentityService } from './session-provider-identity.service';

function harness() {
  let session = createLifecycleTestSession({
    provider: 'CODEX',
    providerSessionId: 'old',
    providerMetadata: { retained: 'metadata', acpConfigSnapshot: { providerSessionId: 'old' } },
  });
  const domain = new SessionDomainService();
  domain.replaceTranscript(
    session.id,
    [
      {
        id: 'old-user',
        source: 'user',
        text: 'previous turn',
        timestamp: '2026-01-01T00:00:00Z',
        order: 0,
      },
    ],
    { historySource: 'jsonl' }
  );
  domain.setHistoryRetryAt(session.id, Date.now() + 30_000);
  const archive = {
    persistClosedSession: vi.fn<typeof closedSessionPersistenceService.persistClosedSession>(() =>
      Promise.resolve()
    ),
  };
  const processor = { clearPendingToolCalls: vi.fn(), setReplaySuppression: vi.fn() };
  const repository = {
    getSessionById: vi.fn(async () => session),
    getWorkspaceById: vi.fn(async () =>
      createLifecycleTestWorkspace({ worktreePath: '/tmp/identity-test' })
    ),
    rolloverProviderIdentity: vi.fn<SessionRepository['rolloverProviderIdentity']>((_id, input) => {
      if (session.providerSessionId !== input.previousProviderSessionId) {
        throw new Error('stale');
      }
      if (
        session.updatedAt !== input.expectedUpdatedAt ||
        session.providerMetadata !== input.expectedProviderMetadata
      ) {
        throw new Error('stale CAS expectations');
      }
      session = {
        ...session,
        providerSessionId: input.providerSessionId,
        providerMetadata: z.json().parse(input.providerMetadata),
      };
      return Promise.resolve();
    }),
  };
  const event: AcpProviderIdentityEvent = {
    sessionId: session.id,
    provider: 'CODEX',
    providerSessionId: 'new',
    incarnationId: 'runtime-1',
    outcome: { kind: 'resume_fallback', previousProviderSessionId: 'old', reason: 'load_failed' },
    configOptions: [],
    assertCurrent: vi.fn(),
  };
  const service = new SessionProviderIdentityService({
    repository,
    sessionDomainService: domain,
    archive,
    processor,
  });
  return { service, repository, domain, archive, event, session: () => session };
}

describe('provider identity lifecycle reconciliation', () => {
  it('archives the observed transcript before atomically replacing identity and snapshot', async () => {
    const h = harness();
    const original = h.session();
    await h.service.reconcile(h.event);
    expect(h.repository.rolloverProviderIdentity).toHaveBeenCalledWith(
      h.event.sessionId,
      expect.objectContaining({
        expectedUpdatedAt: original.updatedAt,
        expectedProviderMetadata: original.providerMetadata,
      })
    );
    expect(h.event.assertCurrent).toHaveBeenCalledTimes(5);
    const fences = vi.mocked(h.event.assertCurrent).mock.invocationCallOrder;
    expect(fences[1]).toBeGreaterThan(h.repository.getSessionById.mock.invocationCallOrder[0]!);
    expect(fences[2]).toBeGreaterThan(h.repository.getWorkspaceById.mock.invocationCallOrder[0]!);
    expect(fences[3]).toBeGreaterThan(h.archive.persistClosedSession.mock.invocationCallOrder[0]!);
    expect(fences[4]).toBeLessThan(
      h.repository.rolloverProviderIdentity.mock.invocationCallOrder[0]!
    );
    expect(h.archive.persistClosedSession.mock.calls[0]?.[0].messages[0]?.text).toBe(
      'previous turn'
    );
    expect(h.archive.persistClosedSession.mock.invocationCallOrder[0]).toBeLessThan(
      h.repository.rolloverProviderIdentity.mock.invocationCallOrder[0]!
    );
    expect(h.session().providerSessionId).toBe('new');
    expect(h.session().providerMetadata).toMatchObject({
      retained: 'metadata',
      acpConfigSnapshot: { providerSessionId: 'new', provider: 'CODEX' },
      providerIdentityRollovers: [
        {
          previousProviderSessionId: 'old',
          providerSessionId: 'new',
          incarnationId: 'runtime-1',
          reason: 'load_failed',
          transcriptPolicy: 'archive_then_clear',
        },
      ],
    });
    expect(h.domain.getTranscriptSnapshot(h.event.sessionId)).toEqual([]);
    expect(h.domain.isHistoryHydrated(h.event.sessionId)).toBe(false);
    expect(h.domain.canAttemptHistoryHydration(h.event.sessionId)).toBe(true);
    expect(h.domain.acceptProviderHistoryIdentity(h.event.sessionId, 'old')).toBe(false);
  });

  it.each(['archive', 'identity'] as const)(
    'preserves old identity and transcript when %s persistence fails',
    async (failure) => {
      const h = harness();
      if (failure === 'archive') {
        h.archive.persistClosedSession.mockRejectedValue(new Error('archive failed'));
      } else {
        h.repository.rolloverProviderIdentity.mockRejectedValue(new Error('identity failed'));
      }
      await expect(h.service.reconcile(h.event)).rejects.toThrow(`${failure} failed`);
      expect(h.session().providerSessionId).toBe('old');
      expect(h.domain.acceptProviderHistoryIdentity(h.event.sessionId, 'old')).toBe(true);
      expect(h.domain.getTranscriptSnapshot(h.event.sessionId)[0]?.text).toBe('previous turn');
      if (failure === 'archive') {
        expect(h.repository.rolloverProviderIdentity).not.toHaveBeenCalled();
      }
    }
  );

  it('refuses a stale incarnation before writing durable identity after archival', async () => {
    const h = harness();
    const archival = createDeferred<void>();
    let stopped = false;
    h.archive.persistClosedSession.mockImplementation(() => archival.promise);
    const repair = h.service.reconcile({
      ...h.event,
      assertCurrent() {
        if (stopped) {
          throw new Error('stale incarnation');
        }
      },
    });
    await vi.waitFor(() => expect(h.archive.persistClosedSession).toHaveBeenCalledOnce());
    stopped = true;
    archival.resolve(undefined);
    await expect(repair).rejects.toThrow('stale incarnation');
    expect(h.repository.rolloverProviderIdentity).not.toHaveBeenCalled();
    expect(h.session().providerSessionId).toBe('old');
  });

  it('completes the history reset when a stop races a successful durable commit', async () => {
    const h = harness();
    const persist = h.repository.rolloverProviderIdentity.getMockImplementation()!;
    let stopped = false;
    h.repository.rolloverProviderIdentity.mockImplementation(async (...args) => {
      await persist(...args);
      stopped = true;
    });
    await h.service.reconcile({
      ...h.event,
      assertCurrent() {
        if (stopped) {
          throw new Error('stop requested');
        }
      },
    });
    expect(h.session().providerSessionId).toBe('new');
    expect(h.domain.getTranscriptSnapshot(h.event.sessionId)).toEqual([]);
    expect(h.domain.acceptProviderHistoryIdentity(h.event.sessionId, 'old')).toBe(false);
  });

  it('rejects a stale durable identity before archiving or resetting history', async () => {
    const h = harness();
    await expect(
      h.service.reconcile({
        ...h.event,
        outcome: { ...h.event.outcome, previousProviderSessionId: 'other' },
      })
    ).rejects.toThrow('Stale provider identity');
    expect(h.archive.persistClosedSession).not.toHaveBeenCalled();
    expect(h.domain.getTranscriptSnapshot(h.event.sessionId)).toHaveLength(1);
  });
});
