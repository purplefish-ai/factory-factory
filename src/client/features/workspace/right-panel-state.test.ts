import { describe, expect, it } from 'vitest';
import { parseStoredTopTab, StoredTopTabSchema } from './right-panel-state';

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
