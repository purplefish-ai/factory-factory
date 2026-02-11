import { describe, expect, it } from 'vitest';
import {
  deriveWorkspaceSidebarStatus,
  getWorkspaceCiTooltip,
  getWorkspacePrTooltipSuffix,
} from './workspace-sidebar-status';

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

  it('treats ratchet merged as merged when PR snapshot is stale', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'OPEN',
      prCiStatus: 'SUCCESS',
      ratchetState: 'MERGED',
    });

    expect(result.ciState).toBe('MERGED');
  });

  it('prefers PR snapshot CI failure over stale ratchet CI running', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'OPEN',
      prCiStatus: 'FAILURE',
      ratchetState: 'CI_RUNNING',
    });

    expect(result.ciState).toBe('FAILING');
  });

  it('prefers PR snapshot CI passing over stale ratchet CI running', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'OPEN',
      prCiStatus: 'SUCCESS',
      ratchetState: 'CI_RUNNING',
    });

    expect(result.ciState).toBe('PASSING');
  });

  it('uses ratchet CI state as fallback when PR CI status is unknown', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'OPEN',
      prCiStatus: 'UNKNOWN',
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

  it('provides ci tooltip text from centralized helper', () => {
    expect(getWorkspaceCiTooltip('RUNNING', 'OPEN')).toBe('CI checks are running');
    expect(getWorkspaceCiTooltip('UNKNOWN', 'CLOSED')).toBe('PR is closed');
  });

  it('provides pr tooltip suffix text from centralized helper', () => {
    expect(getWorkspacePrTooltipSuffix('PASSING', 'OPEN')).toBe(' · CI passing');
    expect(getWorkspacePrTooltipSuffix('UNKNOWN', 'CLOSED')).toBe(' · Closed');
    expect(getWorkspacePrTooltipSuffix('UNKNOWN', 'OPEN')).toBe('');
  });
});
