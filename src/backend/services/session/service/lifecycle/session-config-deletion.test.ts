import { afterEach, expect, it, vi } from 'vitest';
import { agentSessionAccessor } from '@/backend/services/session/resources/agent-session.accessor';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { sessionDomainService } from '@/backend/services/session/service/session-domain.service';
import { sessionConfigService } from './session-core-services';
import { createLifecycleTestSession } from './session-lifecycle.test-helpers';
import { sessionRepository } from './session.repository';

vi.mock('@/backend/services/session/resources/agent-session.accessor', () => ({
  agentSessionAccessor: { delete: vi.fn() },
}));
afterEach(() => vi.restoreAllMocks());

it.each(['data-service', 'repository'] as const)(
  'releases configuration only after successful durable deletion through %s',
  async (path) => {
    const release = vi.spyOn(sessionConfigService, 'releaseSessionConfiguration');
    const remove = () =>
      path === 'data-service'
        ? sessionDataService.deleteAgentSession('session-1')
        : sessionRepository.deleteSession('session-1');
    sessionDomainService.clearSession('session-1');
    sessionDomainService.clearAllSessions();
    expect(release).not.toHaveBeenCalled();
    vi.mocked(agentSessionAccessor.delete).mockRejectedValueOnce(new Error('deletion failed'));
    await expect(remove()).rejects.toThrow('deletion failed');
    expect(release).not.toHaveBeenCalled();
    vi.mocked(agentSessionAccessor.delete).mockResolvedValueOnce(createLifecycleTestSession());
    await remove();
    expect(release).toHaveBeenCalledExactlyOnceWith('session-1');
  }
);
