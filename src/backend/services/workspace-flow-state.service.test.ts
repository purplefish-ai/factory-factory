import { CIStatus, PRState, RatchetState } from '@prisma-gen/client';
import { describe, expect, it } from 'vitest';
import { deriveWorkspaceFlowState } from './workspace-flow-state.service';

describe('deriveWorkspaceFlowState', () => {
  it('returns CI_WAIT and working when PR CI is pending (ratchet off)', () => {
    const result = deriveWorkspaceFlowState({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: CIStatus.PENDING,
      ratchetEnabled: false,
      ratchetState: RatchetState.IDLE,
    });

    expect(result.phase).toBe('CI_WAIT');
    expect(result.isWorking).toBe(true);
    expect(result.shouldAnimateRatchetButton).toBe(false);
  });

  it('animates ratchet button only while waiting for CI with ratchet enabled', () => {
    const result = deriveWorkspaceFlowState({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: CIStatus.PENDING,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_RUNNING,
    });

    expect(result.phase).toBe('CI_WAIT');
    expect(result.isWorking).toBe(true);
    expect(result.shouldAnimateRatchetButton).toBe(true);
  });

  it('keeps workspace working in RATCHET_VERIFY after CI finishes', () => {
    const result = deriveWorkspaceFlowState({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: CIStatus.SUCCESS,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
    });

    expect(result.phase).toBe('RATCHET_VERIFY');
    expect(result.isWorking).toBe(true);
    expect(result.shouldAnimateRatchetButton).toBe(false);
  });

  it('moves to non-working READY when ratchet has verified readiness', () => {
    const result = deriveWorkspaceFlowState({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: CIStatus.SUCCESS,
      ratchetEnabled: true,
      ratchetState: RatchetState.READY,
    });

    expect(result.phase).toBe('READY');
    expect(result.isWorking).toBe(false);
    expect(result.shouldAnimateRatchetButton).toBe(false);
  });

  it('returns RATCHET_FIXING and working for actionable ratchet states', () => {
    const result = deriveWorkspaceFlowState({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: CIStatus.FAILURE,
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_FAILED,
    });

    expect(result.phase).toBe('RATCHET_FIXING');
    expect(result.isWorking).toBe(true);
  });

  it('returns MERGED phase for merged PRs', () => {
    const result = deriveWorkspaceFlowState({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.MERGED,
      prCiStatus: CIStatus.SUCCESS,
      ratchetEnabled: true,
      ratchetState: RatchetState.MERGED,
    });

    expect(result.phase).toBe('MERGED');
    expect(result.isWorking).toBe(false);
    expect(result.hasActivePr).toBe(false);
  });
});
