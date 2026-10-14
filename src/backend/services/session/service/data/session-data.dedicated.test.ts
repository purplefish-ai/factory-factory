import { beforeEach, expect, it, vi } from 'vitest';
import { sessionDataService } from '@/backend/services/session/service/data/session-data.service';
import { createLifecycleTestSession } from '@/backend/services/session/service/lifecycle/session-lifecycle.test-helpers';
const mocks = vi.hoisted(() => ({
  findWorkspace: vi.fn(),
  acquire: vi.fn(),
  find: vi.fn(),
  restore: vi.fn(),
  defaults: vi.fn(),
}));
vi.mock('@/backend/services/session/resources/pr-dedicated-session.accessor', () => ({
  prDedicatedSessionAccessor: mocks,
}));
vi.mock('@/backend/services/session/service/data/session-provider-resolver.service', () => ({
  sessionProviderResolverService: { resolveSessionDefaults: mocks.defaults },
}));
const workspace = { id: 'w', defaultSessionProvider: 'CODEX' };
const input = { workspaceId: 'w', prId: 'a', maxSessions: 3 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findWorkspace.mockResolvedValue(workspace);
  mocks.defaults.mockResolvedValue({ provider: 'CODEX', model: 'configured-model' });
  mocks.acquire.mockResolvedValue({
    outcome: 'created',
    session: createLifecycleTestSession({ workflow: 'pr-monitoring', workspacePrId: 'a' }),
  });
});
it('resolves normal workspace provider and model defaults before atomic acquisition', async () => {
  expect(await sessionDataService.acquirePRDedicatedSession(input)).toMatchObject({
    outcome: 'created',
    session: { workflow: 'pr-monitoring', workspacePrId: 'a' },
  });
  expect(mocks.defaults).toHaveBeenCalledWith({
    workspace,
    workspaceId: 'w',
    explicitProvider: undefined,
    explicitModel: undefined,
  });
  expect(mocks.acquire).toHaveBeenCalledWith({
    ...input,
    provider: 'CODEX',
    model: 'configured-model',
  });
});
it('returns unavailable for a missing target before resolving preferences', async () => {
  mocks.findWorkspace.mockResolvedValue(null);
  expect(await sessionDataService.acquirePRDedicatedSession(input)).toEqual({
    outcome: 'unavailable',
  });
  expect(mocks.defaults).not.toHaveBeenCalled();
  expect(mocks.acquire).not.toHaveBeenCalled();
});
it('fences acquisition when a stop occurs while preferences resolve', async () => {
  let valid = true;
  mocks.defaults.mockImplementation(() => {
    valid = false;
    return Promise.resolve({ provider: 'CODEX', model: 'configured-model' });
  });
  expect(
    await sessionDataService.acquirePRDedicatedSession({ ...input, isCurrent: () => valid })
  ).toEqual({ outcome: 'unavailable' });
  expect(mocks.acquire).not.toHaveBeenCalled();
});
it.each(['limit_reached', 'unavailable'] as const)(
  'retains the %s resource outcome',
  async (outcome) => {
    mocks.acquire.mockResolvedValue({ outcome });
    expect(await sessionDataService.acquirePRDedicatedSession(input)).toEqual({ outcome });
  }
);
