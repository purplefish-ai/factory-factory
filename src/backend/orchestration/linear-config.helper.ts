/**
 * Shared helpers for decrypting a project's Linear configuration.
 * Used by orchestrators that need to call Linear API methods.
 */

import { workspaceAccessor } from '@/backend/resource_accessors/workspace.accessor';
import { cryptoService } from '@/backend/services/crypto.service';
import { IssueTrackerConfigSchema } from '@/shared/schemas/issue-tracker-config.schema';

export function getDecryptedLinearConfig(
  issueTrackerConfig: unknown
): { apiKey: string; teamId: string } | null {
  const parsed = IssueTrackerConfigSchema.safeParse(issueTrackerConfig);
  if (!(parsed.success && parsed.data.linear)) {
    return null;
  }
  const { linear } = parsed.data;
  return { apiKey: cryptoService.decrypt(linear.apiKey), teamId: linear.teamId };
}

/**
 * Look up a workspace + project, then return the Linear config if the workspace
 * is linked to a Linear issue. Returns null if workspace not found, has no
 * Linear issue, or project has no Linear config.
 */
export async function getWorkspaceLinearContext(
  workspaceId: string
): Promise<{ apiKey: string; linearIssueId: string } | null> {
  const workspace = await workspaceAccessor.findByIdWithProject(workspaceId);
  if (!workspace?.linearIssueId) {
    return null;
  }

  const linearConfig = getDecryptedLinearConfig(workspace.project.issueTrackerConfig);
  if (!linearConfig) {
    return null;
  }

  return { apiKey: linearConfig.apiKey, linearIssueId: workspace.linearIssueId };
}
