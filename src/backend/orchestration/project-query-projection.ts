import {
  type PublicIssueTrackerConfig,
  sanitizeIssueTrackerConfig,
} from '@/shared/schemas/issue-tracker-config.schema';

/** Project reads remain raw internally. Apply this only to public project responses. */
export function toPublicProject<T extends { issueTrackerConfig: unknown }>(
  project: T
): Omit<T, 'issueTrackerConfig'> & { issueTrackerConfig: PublicIssueTrackerConfig | null } {
  return {
    ...project,
    issueTrackerConfig: sanitizeIssueTrackerConfig(project.issueTrackerConfig),
  };
}
