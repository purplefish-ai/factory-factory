import { describe, expect, it } from 'vitest';
import { parseStoredTopTab, resolveTopTab, StoredTopTabSchema } from './right-panel-state';

describe('right panel persisted state', () => {
  it('restores the Inbox preference', () => {
    expect(parseStoredTopTab('inbox')).toBe('inbox');
  });

  it('round-trips the Agents tab', () => {
    expect(parseStoredTopTab('agents')).toBe('agents');
    expect(StoredTopTabSchema.parse('agents')).toBe('agents');
  });

  it('migrates the legacy child-workspaces tab', () => {
    expect(StoredTopTabSchema.parse('child-workspaces')).toBe('agents');
  });

  it.each(['unstaged', 'diff-vs-main', 'auto-iteration', 'tasks'])(
    'keeps the existing %s migration',
    (legacyTab) => {
      expect(StoredTopTabSchema.parse(legacyTab)).toBe('changes');
    }
  );

  it('rejects unknown values so the caller falls back to changes', () => {
    expect(parseStoredTopTab('mystery')).toBeNull();
    expect(StoredTopTabSchema.safeParse('mystery').success).toBe(false);
  });
});

describe('resolveTopTab', () => {
  const periodic = { periodicTaskId: 'task-1' };
  const plain = { periodicTaskId: null };
  it.each([
    [null, undefined, 'changes'],
    [null, plain, 'changes'],
    [null, periodic, 'periodic-task'],
    ['files', periodic, 'files'],
    // A periodic-task choice waits for the workspace before falling back.
    ['periodic-task', undefined, 'periodic-task'],
    ['periodic-task', periodic, 'periodic-task'],
    ['periodic-task', plain, 'changes'],
  ] as const)('shows %s with workspace %o as %s', (stored, workspace, expected) => {
    expect(resolveTopTab(stored, workspace)).toBe(expected);
  });
});
