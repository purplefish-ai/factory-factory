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
 * The top tab to show. Without a stored choice an automation workspace
 * (scheduled, or event-run with a retained origin run) opens its Runs tab and
 * others open Changes. The `periodic-task` key is the Runs tab for both kinds.
 * A stored Runs choice falls back to Changes once the workspace has loaded
 * without an origin; the stored choice is kept until the user picks a tab.
 */
export function resolveTopTab(
  stored: TopPanelTab | null,
  workspace: { periodicTaskId?: string | null } | undefined,
  hasEventOrigin = false
): TopPanelTab {
  const hasRuns = !!workspace?.periodicTaskId || hasEventOrigin;
  if (stored === null) {
    return hasRuns ? 'periodic-task' : 'changes';
  }
  if (stored === 'periodic-task' && workspace !== undefined && !hasRuns) {
    return 'changes';
  }
  return stored;
}
