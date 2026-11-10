import { readStoredJson, writeStoredJson } from '@/client/lib/browser-storage';
import { resumeWorkspaceIdsSchema } from '@/shared/schemas/persisted-stores.schema';

const RESUME_WORKSPACE_IDS_KEY = 'ff_resume_workspace_ids';

export function readResumeWorkspaceIds(): string[] {
  return readStoredJson(RESUME_WORKSPACE_IDS_KEY, resumeWorkspaceIdsSchema) ?? [];
}

export function forgetResumeWorkspace(workspaceId: string) {
  writeStoredJson(
    RESUME_WORKSPACE_IDS_KEY,
    readResumeWorkspaceIds().filter((id) => id !== workspaceId)
  );
}

export function isResumeWorkspace(workspaceId: string): boolean {
  return readResumeWorkspaceIds().includes(workspaceId);
}
