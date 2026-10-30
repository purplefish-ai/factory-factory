import { expect, it } from 'vitest';
import { buildWorkspaceSessionSummaries } from '@/backend/lib/session-summaries';
import { hasStartingSessionSummary } from '@/shared/session-runtime';
import { createLifecycleHarness } from './session-lifecycle.test-helpers';

it('preserves startup while a live provider is being configured, then reports idle', () => {
  const h = createLifecycleHarness();
  h.runtimeManager.getClient.mockReturnValue(h.handle);
  h.runtimeManager.isSessionWorking.mockReturnValue(false);
  const updatedAt = '2026-10-30T00:00:00.000Z';
  h.sessionDomainService.getRuntimeSnapshot.mockReturnValue({
    phase: 'starting',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt,
  });

  const summaries = () =>
    buildWorkspaceSessionSummaries([h.session], (id) => h.service.getRuntimeSnapshot(id));
  expect(hasStartingSessionSummary(summaries())).toBe(true);
  expect(h.service.getRuntimeSnapshot(h.session.id)).toMatchObject({
    phase: 'starting',
    activity: 'IDLE',
    updatedAt,
  });

  // The startup owner explicitly publishes idle after configuration finishes.
  h.sessionDomainService.getRuntimeSnapshot.mockReturnValue({
    phase: 'idle',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt,
  });
  expect(hasStartingSessionSummary(summaries())).toBe(false);
  expect(h.service.getRuntimeSnapshot(h.session.id).phase).toBe('idle');
});

it('reports actual work and errors ahead of the startup phase', () => {
  const h = createLifecycleHarness();
  h.runtimeManager.getClient.mockReturnValue(h.handle);
  h.sessionDomainService.getRuntimeSnapshot.mockReturnValue({
    phase: 'starting',
    processState: 'alive',
    activity: 'IDLE',
    updatedAt: '2026-10-30T00:00:00.000Z',
  });
  h.runtimeManager.isSessionWorking.mockReturnValue(true);
  expect(h.service.getRuntimeSnapshot(h.session.id)).toMatchObject({
    phase: 'running',
    activity: 'WORKING',
  });
  h.sessionDomainService.getRuntimeSnapshot.mockReturnValue({
    phase: 'error',
    processState: 'alive',
    activity: 'IDLE',
    errorMessage: 'Configuration failed',
    updatedAt: '2026-10-30T00:00:00.000Z',
  });
  expect(h.service.getRuntimeSnapshot(h.session.id)).toMatchObject({
    phase: 'error',
    errorMessage: 'Configuration failed',
  });
});
