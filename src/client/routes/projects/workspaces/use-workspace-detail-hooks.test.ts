import { describe, expect, it } from 'vitest';
import { resolveSelectedSessionId } from './use-workspace-detail-hooks';

describe('resolveSelectedSessionId', () => {
  it('keeps current selection while sessions are still loading', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 's2',
      persistedSessionId: 's2',
      initialDbSessionId: 's1',
      sessionIds: [],
    });

    expect(selected).toBe('s2');
  });

  it('keeps current selection when still valid', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 's2',
      persistedSessionId: 's1',
      initialDbSessionId: 's1',
      sessionIds: ['s1', 's2'],
    });

    expect(selected).toBe('s2');
  });

  it('restores persisted selection when current is invalid', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 'missing',
      persistedSessionId: 's2',
      initialDbSessionId: 's1',
      sessionIds: ['s1', 's2'],
    });

    expect(selected).toBe('s2');
  });

  it('falls back to initial session when persisted is not available', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: null,
      persistedSessionId: 'missing',
      initialDbSessionId: 's2',
      sessionIds: ['s1', 's2'],
    });

    expect(selected).toBe('s2');
  });

  it('preserves a pending explicit selection while session list catches up', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 's3',
      persistedSessionId: 's3',
      initialDbSessionId: 's1',
      sessionIds: ['s1', 's2'],
      pendingSelectionId: 's3',
      pendingSelectionSetAtMs: 1000,
      nowMs: 1200,
    });

    expect(selected).toBe('s3');
  });

  it('does not preserve pending selection after grace period expires', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: 's3',
      persistedSessionId: 's3',
      initialDbSessionId: 's1',
      sessionIds: ['s1', 's2'],
      pendingSelectionId: 's3',
      pendingSelectionSetAtMs: 1000,
      nowMs: 7000,
    });

    expect(selected).toBe('s1');
  });

  it('falls back to the first session when no preference is valid', () => {
    const selected = resolveSelectedSessionId({
      currentSelectedDbSessionId: null,
      persistedSessionId: 'missing',
      initialDbSessionId: 'also-missing',
      sessionIds: ['s1', 's2'],
    });

    expect(selected).toBe('s1');
  });
});
