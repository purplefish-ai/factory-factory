import { describe, expect, it } from 'vitest';
import { deriveWorkspaceSidebarStatus } from './workspace-sidebar-status';

describe('workspace-sidebar-status', () => {
  it('marks activity as working when isWorking is true', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: true,
      prUrl: null,
      prState: 'NONE',
      prCiStatus: 'UNKNOWN',
      ratchetState: 'IDLE',
    });

    expect(result.activityState).toBe('WORKING');
    expect(result.ciState).toBe('NONE');
  });

  it('prioritizes merged PR over CI fields', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'MERGED',
      prCiStatus: 'FAILURE',
      ratchetState: 'CI_FAILED',
    });

    expect(result.ciState).toBe('MERGED');
  });

  it('uses ratchet CI failure even when PR snapshot is stale', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'OPEN',
      prCiStatus: 'SUCCESS',
      ratchetState: 'CI_FAILED',
    });

    expect(result.ciState).toBe('FAILING');
  });

  it('uses ratchet CI running even when PR snapshot is stale', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'OPEN',
      prCiStatus: 'SUCCESS',
      ratchetState: 'CI_RUNNING',
    });

    expect(result.ciState).toBe('RUNNING');
  });

  it('falls back to prCiStatus when ratchet state is not CI-specific', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'OPEN',
      prCiStatus: 'FAILURE',
      ratchetState: 'READY',
    });

    expect(result.ciState).toBe('FAILING');
  });
});
