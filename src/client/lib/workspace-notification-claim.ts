import { z } from 'zod';

interface WorkspaceCompletionIdentity {
  workspaceId: string;
  finishedAt: string;
}

const RECENT_COMPLETIONS_KEY = 'factoryfactory_recent_workspace_completions';
const MAX_RECENT_COMPLETIONS = 1000;
const recentCompletionsSchema = z
  .array(
    z.object({
      workspaceId: z.string().min(1),
      finishedAt: z.iso.datetime(),
    })
  )
  .max(MAX_RECENT_COMPLETIONS);

/** Called only while the origin-wide exclusive Web Lock is held. */
function claimStoredCompletion(identity: WorkspaceCompletionIdentity): boolean {
  const text = localStorage.getItem(RECENT_COMPLETIONS_KEY) ?? '[]';
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const parsed = recentCompletionsSchema.safeParse(raw);
  const recent = parsed.success ? parsed.data : [];
  if (
    recent.some(
      (item) => item.workspaceId === identity.workspaceId && item.finishedAt === identity.finishedAt
    )
  ) {
    return false;
  }
  localStorage.setItem(
    RECENT_COMPLETIONS_KEY,
    JSON.stringify(
      [...recent, { workspaceId: identity.workspaceId, finishedAt: identity.finishedAt }].slice(
        -MAX_RECENT_COMPLETIONS
      )
    )
  );
  return true;
}

/**
 * Atomically elect one tab to deliver an origin's recent completion alert.
 * Without Web Locks or usable storage, preserve per-tab alerts; the manager's
 * bounded in-memory set still suppresses repeats in that tab. Never request
 * browser permission as part of claiming a completion.
 */
export async function claimWorkspaceCompletion(
  identity: WorkspaceCompletionIdentity,
  isActive: () => boolean = () => true
): Promise<boolean> {
  try {
    if (!isActive()) {
      return false;
    }
    if (!navigator.locks?.request) {
      return true;
    }
    return await navigator.locks.request(
      'factoryfactory-workspace-completion',
      () => isActive() && claimStoredCompletion(identity)
    );
  } catch {
    return isActive();
  }
}
