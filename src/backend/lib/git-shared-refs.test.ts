import { describe, expect, it } from 'vitest';
import {
  classifySharedGitEvent,
  isRefIndependentUpstreamFailure,
  refChangeAffects,
  revisionRefCandidates,
} from './git-shared-refs';

describe('classifySharedGitEvent', () => {
  it.each([
    'HEAD',
    'index',
    'config.worktree',
    'worktrees/w1/HEAD',
    'objects/ab/cdef',
    'logs/refs/heads/main',
    'packed-refs.lock',
  ])('ignores %s', (filename) => {
    expect(classifySharedGitEvent(filename)).toEqual({ kind: 'ignore' });
  });

  it.each([
    ['refs/heads/feature', 'refs/heads/feature'],
    ['refs/heads/feature.lock', 'refs/heads/feature'],
    ['refs/remotes/origin/Feature', 'refs/remotes/origin/feature'],
    ['refs/heads/Café', 'refs/heads/café'],
    ['refs\\tags\\v1', 'refs/tags/v1'],
    ['./refs/heads/nested/name', 'refs/heads/nested/name'],
    ['refs/heads', 'refs/heads'],
    ['refs/remotes/origin', 'refs/remotes/origin'],
  ])('scopes %s to ref %s', (filename, ref) => {
    expect(classifySharedGitEvent(filename)).toEqual({ kind: 'ref', ref });
  });

  it.each([
    null,
    '',
    'refs',
    'refs/headsx/feature',
    'refs/replace/abc',
    'refs/stash',
    'refs/notes/commits',
    'packed-refs',
    'packed-refs.new',
    'reftable/tables.list',
    'config',
    'info/exclude',
    'shallow',
    'FETCH_HEAD',
  ])('invalidates every dependent for %s', (filename) => {
    expect(classifySharedGitEvent(filename)).toEqual({ kind: 'all' });
  });
});

describe('revisionRefCandidates', () => {
  it('lists every full ref a short revision may resolve to', () => {
    expect(revisionRefCandidates('origin/main')).toEqual([
      'refs/origin/main',
      'refs/tags/origin/main',
      'refs/heads/origin/main',
      'refs/remotes/origin/main',
      'refs/remotes/origin/main/HEAD',
    ]);
  });

  it('keeps a full ref name as its own candidate', () => {
    expect(revisionRefCandidates('refs/heads/main')).toContain('refs/heads/main');
  });
});

describe('refChangeAffects', () => {
  const dependencies = new Set(['refs/heads/feature', 'refs/remotes/origin/main']);

  it('matches the exact ref, an enclosing directory, or a ref beneath a dependency', () => {
    expect(refChangeAffects('refs/heads/feature', dependencies)).toBe(true);
    expect(refChangeAffects('refs/remotes/origin', dependencies)).toBe(true);
    expect(refChangeAffects('refs/heads/feature/child', dependencies)).toBe(true);
  });

  it('does not match sibling refs that share a prefix', () => {
    expect(refChangeAffects('refs/heads/feature-2', dependencies)).toBe(false);
    expect(refChangeAffects('refs/heads/feat', dependencies)).toBe(false);
    expect(refChangeAffects('refs/remotes/origin/feature', dependencies)).toBe(false);
  });
});

describe('isRefIndependentUpstreamFailure', () => {
  it('accepts only failures no ref write can change', () => {
    expect(isRefIndependentUpstreamFailure("fatal: no upstream configured for branch 'x'")).toBe(
      true
    );
    expect(isRefIndependentUpstreamFailure('fatal: HEAD does not point to a branch')).toBe(true);
    expect(
      isRefIndependentUpstreamFailure(
        "fatal: ambiguous argument '@{upstream}': unknown revision or path not in the working tree."
      )
    ).toBe(false);
    expect(isRefIndependentUpstreamFailure("fatal: no such branch: 'unborn'")).toBe(false);
  });
});
