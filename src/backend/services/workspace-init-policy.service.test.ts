import { describe, expect, it } from 'vitest';
import { getWorkspaceInitPolicy } from './workspace-init-policy.service';

describe('getWorkspaceInitPolicy', () => {
  it('returns creating worktree phase for NEW workspace', () => {
    const policy = getWorkspaceInitPolicy({
      status: 'NEW',
      worktreePath: null,
      initErrorMessage: null,
    });

    expect(policy.phase).toBe('CREATING_WORKTREE');
    expect(policy.dispatchPolicy).toBe('blocked');
    expect(policy.banner?.message).toBe('Creating worktree...');
  });

  it('returns running init script phase for PROVISIONING workspace with worktree', () => {
    const policy = getWorkspaceInitPolicy({
      status: 'PROVISIONING',
      worktreePath: '/tmp/worktree',
      initErrorMessage: null,
    });

    expect(policy.phase).toBe('RUNNING_INIT_SCRIPT');
    expect(policy.dispatchPolicy).toBe('blocked');
    expect(policy.banner?.message).toBe('Running init script...');
  });

  it('returns manual_resume policy for startup script failures after worktree creation', () => {
    const policy = getWorkspaceInitPolicy({
      status: 'FAILED',
      worktreePath: '/tmp/worktree',
      initErrorMessage: 'npm install failed',
    });

    expect(policy.phase).toBe('READY_WITH_WARNING');
    expect(policy.dispatchPolicy).toBe('manual_resume');
    expect(policy.banner?.showPlay).toBe(true);
  });
});
