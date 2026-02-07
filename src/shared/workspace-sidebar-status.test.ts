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
    expect(result.agentStatus).toBe('WORKING');
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
    expect(result.agentStatus).toBe('MERGED');
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
    expect(result.agentStatus).toBe('MERGED');
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
    expect(result.agentStatus).toBe('CI_FAILING');
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
    expect(result.agentStatus).toBe('CI_RUNNING');
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
    expect(result.agentStatus).toBe('CI_FAILING');
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

  it('shows STARTING status when isStarting is true', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      isStarting: true,
      prUrl: null,
      prState: 'NONE',
      prCiStatus: 'UNKNOWN',
      ratchetState: 'IDLE',
    });

    expect(result.agentStatus).toBe('STARTING');
  });

  it('shows IDLE status when nothing is active', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      isStarting: false,
      prUrl: null,
      prState: 'NONE',
      prCiStatus: 'UNKNOWN',
      ratchetState: 'IDLE',
    });

    expect(result.agentStatus).toBe('IDLE');
  });

  it('shows CI_PASSING when PR has successful CI', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: false,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'OPEN',
      prCiStatus: 'SUCCESS',
      ratchetState: 'READY',
    });

    expect(result.agentStatus).toBe('CI_PASSING');
  });

  it('prioritizes STARTING over other states', () => {
    const result = deriveWorkspaceSidebarStatus({
      isWorking: true,
      isStarting: true,
      prUrl: 'https://github.com/o/r/pull/1',
      prState: 'OPEN',
      prCiStatus: 'FAILURE',
      ratchetState: 'CI_FAILED',
    });

    expect(result.agentStatus).toBe('STARTING');
  });
});
