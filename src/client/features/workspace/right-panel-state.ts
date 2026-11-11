import { z } from 'zod';

export const STORAGE_KEY_TOP_TAB_PREFIX = 'workspace-right-panel-tab-';

export type TopPanelTab =
  | 'changes'
  | 'files'
  | 'screenshots'
  | 'periodic-task'
  | 'agents'
  | 'inbox';

export function parseStoredTopTab(value: string | null): TopPanelTab | null {
  if (
    value === 'changes' ||
    value === 'files' ||
    value === 'screenshots' ||
    value === 'periodic-task' ||
    value === 'agents' ||
    value === 'inbox'
  ) {
    return value;
  }
  if (value === 'child-workspaces') {
    return 'agents';
  }
  if (
    value === 'tasks' ||
    value === 'unstaged' ||
    value === 'diff-vs-main' ||
    value === 'auto-iteration'
  ) {
    return 'changes';
  }
  return null;
}

/** A stored top tab, mapping retired tabs onto their replacements. */
export const StoredTopTabSchema = z
  .string()
  .transform(parseStoredTopTab)
  .pipe(z.enum(['changes', 'files', 'screenshots', 'periodic-task', 'agents', 'inbox']));

/**
 * The top tab to show. Without a stored choice a scheduled-automation
 * workspace opens its automation and others open Changes. A stored
 * periodic-task choice falls back to Changes once the workspace has loaded
 * without one; the stored choice is kept until the user picks a tab.
 */
export function resolveTopTab(
  stored: TopPanelTab | null,
  workspace: { periodicTaskId?: string | null } | undefined
): TopPanelTab {
  const periodicTaskId = workspace?.periodicTaskId ?? null;
  if (stored === null) {
    return periodicTaskId ? 'periodic-task' : 'changes';
  }
  if (stored === 'periodic-task' && workspace !== undefined && !periodicTaskId) {
    return 'changes';
  }
  return stored;
}
