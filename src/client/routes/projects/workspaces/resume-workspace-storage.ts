import { resumeWorkspaceIdsSchema } from '@/shared/schemas/persisted-stores.schema';

const RESUME_WORKSPACE_IDS_KEY = 'ff_resume_workspace_ids';

export function readResumeWorkspaceIds(): string[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(RESUME_WORKSPACE_IDS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    const validated = resumeWorkspaceIdsSchema.parse(parsed);
    return validated;
  } catch {
    return [];
  }
}

function writeResumeWorkspaceIds(ids: string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(RESUME_WORKSPACE_IDS_KEY, JSON.stringify(ids));
  } catch {
    // Non-blocking: ignore localStorage failures.
  }
}

export function rememberResumeWorkspace(workspaceId: string) {
  const existing = readResumeWorkspaceIds();
  if (!existing.includes(workspaceId)) {
    existing.push(workspaceId);
  }
  const trimmed = existing.slice(-200);
  writeResumeWorkspaceIds(trimmed);
}

export function forgetResumeWorkspace(workspaceId: string) {
  const existing = readResumeWorkspaceIds().filter((id) => id !== workspaceId);
  writeResumeWorkspaceIds(existing);
}

export function isResumeWorkspace(workspaceId: string): boolean {
  const existing = readResumeWorkspaceIds();
  return existing.includes(workspaceId);
}
