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
