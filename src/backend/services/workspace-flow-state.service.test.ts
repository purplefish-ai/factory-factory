import { CIStatus, PRState, RatchetState } from '@prisma-gen/client';
import { describe, expect, it } from 'vitest';
import {
  deriveWorkspaceFlowState,
  deriveWorkspaceFlowStateFromWorkspace,
} from './workspace-flow-state.service';

describe('deriveWorkspaceFlowState', () => {
  it('returns CI_WAIT and working when PR CI is pending (ratchet off)', () => {
    const result = deriveWorkspaceFlowState({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: CIStatus.PENDING,
      prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
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
      prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
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
      prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
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
      prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
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
      prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
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
      prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetEnabled: true,
      ratchetState: RatchetState.MERGED,
    });

    expect(result.phase).toBe('MERGED');
    expect(result.isWorking).toBe(false);
    expect(result.hasActivePr).toBe(false);
  });

  it('distinguishes unknown CI as not fetched when PR has never been synced', () => {
    const result = deriveWorkspaceFlowState({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: CIStatus.UNKNOWN,
      prUpdatedAt: null,
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
    });

    expect(result.ciObservation).toBe('NOT_FETCHED');
    expect(result.phase).toBe('CI_WAIT');
    expect(result.isWorking).toBe(true);
  });

  it('distinguishes unknown CI as no checks after PR sync', () => {
    const result = deriveWorkspaceFlowState({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: CIStatus.UNKNOWN,
      prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetEnabled: true,
      ratchetState: RatchetState.IDLE,
    });

    expect(result.ciObservation).toBe('NO_CHECKS');
    expect(result.phase).toBe('RATCHET_VERIFY');
  });

  it('derives flow state directly from a workspace-like object', () => {
    const result = deriveWorkspaceFlowStateFromWorkspace({
      prUrl: 'https://github.com/acme/repo/pull/1',
      prState: PRState.OPEN,
      prCiStatus: CIStatus.PENDING,
      prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      ratchetEnabled: true,
      ratchetState: RatchetState.CI_RUNNING,
    });

    expect(result.phase).toBe('CI_WAIT');
    expect(result.shouldAnimateRatchetButton).toBe(true);
  });
});
