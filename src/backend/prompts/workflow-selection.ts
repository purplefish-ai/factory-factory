/**
 * Workflow selection logic based on context (issue labels, creation source, etc.)
 */

/**
 * Determine the appropriate workflow for a GitHub issue based on its labels.
 *
 * Logic:
 * - If issue has a "bug" label (case-insensitive): use bugfix-orchestrated
 * - Otherwise: use feature-orchestrated
 *
 * @param labels - Array of label objects from GitHub issue
 * @returns Workflow ID to use
 */
export function selectWorkflowForGitHubIssue(labels: Array<{ name: string }>): string {
  const hasBugLabel = labels.some((label) => label.name.toLowerCase() === 'bug');
  return hasBugLabel ? 'bugfix-orchestrated' : 'feature-orchestrated';
}

/**
 * Get the default workflow for a new workspace based on creation source.
 *
 * @param creationSource - How the workspace was created
 * @param issueLabels - If from GitHub issue, the labels on that issue
 * @returns Workflow ID to use for the default session
 */
export function getDefaultWorkflowForWorkspace(
  creationSource: 'MANUAL' | 'RESUME_BRANCH' | 'GITHUB_ISSUE',
  issueLabels?: Array<{ name: string }>
): string {
  if (creationSource === 'GITHUB_ISSUE') {
    // For GitHub issues, select workflow based on labels
    return issueLabels ? selectWorkflowForGitHubIssue(issueLabels) : 'feature-orchestrated';
  }

  // For manual/resumed workspaces, use followup workflow
  // (users will provide their own direction in chat)
  return 'followup';
}
