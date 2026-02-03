import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import type { GitHubIssue } from '@/backend/services/github-cli.service';
import { trpc } from '@/frontend/lib/trpc';
import { generateUniqueWorkspaceName } from '@/shared/workspace-words';

// =============================================================================
// Types
// =============================================================================

export interface UseCreateWorkspaceOptions {
  /** Project ID to create workspace in */
  projectId: string | undefined;
  /** Project slug for navigation */
  projectSlug: string;
  /** Existing workspace names (for unique name generation) */
  existingNames?: string[];
  /** Callback when creation starts (for optimistic UI) */
  onCreatingStart?: (name: string) => void;
  /** Callback when creation fails (for optimistic UI rollback) */
  onCreatingError?: () => void;
}

export interface UseCreateWorkspaceReturn {
  /** Whether a workspace is currently being created */
  isCreating: boolean;
  /** Create a new workspace from scratch with default workflow */
  createFromScratch: () => Promise<void>;
  /** Create a new workspace from a GitHub issue */
  createFromGitHubIssue: (issue: GitHubIssue) => Promise<void>;
  /** Whether GitHub Issues option should be shown */
  showGitHubIssuesOption: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Default workflow for new workspaces */
const DEFAULT_WORKFLOW = 'feature';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate a prompt from a GitHub issue to send as the first message.
 */
function generateIssuePrompt(issue: GitHubIssue): string {
  return `I want to work on the following GitHub issue:

## Issue #${issue.number}: ${issue.title}

${issue.body || 'No description provided.'}

---
Issue URL: ${issue.url}

Please analyze this issue and help me implement a solution.`;
}

// =============================================================================
// Hook
// =============================================================================

export function useCreateWorkspace({
  projectId,
  projectSlug,
  existingNames = [],
  onCreatingStart,
  onCreatingError,
}: UseCreateWorkspaceOptions): UseCreateWorkspaceReturn {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [isCreating, setIsCreating] = useState(false);

  // Mutations
  const createWorkspace = trpc.workspace.create.useMutation();
  const createSession = trpc.session.createClaudeSession.useMutation();

  // Check if project has GitHub repo configured
  const { data: hasGitHubRepo } = trpc.github.hasGitHubRepoForProject.useQuery(
    { projectId: projectId ?? '' },
    { enabled: !!projectId, staleTime: 60_000 }
  );

  // Check GitHub auth status
  const { data: githubHealth } = trpc.github.checkHealth.useQuery(undefined, {
    staleTime: 60_000,
  });

  // Show GitHub Issues option if user is authenticated and project has a GitHub repo
  const showGitHubIssuesOption = githubHealth?.isAuthenticated === true && hasGitHubRepo === true;

  /**
   * Core creation logic shared between both flows
   */
  const createWorkspaceWithSession = async (
    initialPrompt: string
  ): Promise<{ workspaceId: string; sessionId: string } | null> => {
    if (!projectId || isCreating) {
      return null;
    }

    const name = generateUniqueWorkspaceName(existingNames);
    setIsCreating(true);
    onCreatingStart?.(name);

    try {
      // Step 1: Create the workspace
      const workspace = await createWorkspace.mutateAsync({
        projectId,
        name,
      });

      // Step 2: Create a session with the default workflow
      const session = await createSession.mutateAsync({
        workspaceId: workspace.id,
        workflow: DEFAULT_WORKFLOW,
        name: 'Chat 1',
      });

      // Step 3: Store the initial prompt to be sent when session connects
      // We'll use sessionStorage to pass this to the workspace detail page
      if (initialPrompt) {
        sessionStorage.setItem(`pending-prompt-${session.id}`, initialPrompt);
      }

      // Invalidate caches
      utils.workspace.list.invalidate({ projectId });
      utils.workspace.getProjectSummaryState.invalidate({ projectId });
      utils.session.listClaudeSessions.invalidate({ workspaceId: workspace.id });

      setIsCreating(false);
      return { workspaceId: workspace.id, sessionId: session.id };
    } catch (error) {
      setIsCreating(false);
      onCreatingError?.();
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast.error(`Failed to create workspace: ${message}`);
      return null;
    }
  };

  /**
   * Create a new workspace from scratch with default workflow (no initial message)
   */
  const createFromScratch = async (): Promise<void> => {
    const result = await createWorkspaceWithSession('');
    if (result) {
      navigate(`/projects/${projectSlug}/workspaces/${result.workspaceId}`);
    }
  };

  /**
   * Create a new workspace from a GitHub issue
   */
  const createFromGitHubIssue = async (issue: GitHubIssue): Promise<void> => {
    const issuePrompt = generateIssuePrompt(issue);
    const result = await createWorkspaceWithSession(issuePrompt);
    if (result) {
      navigate(`/projects/${projectSlug}/workspaces/${result.workspaceId}`);
    }
  };

  return {
    isCreating,
    createFromScratch,
    createFromGitHubIssue,
    showGitHubIssuesOption,
  };
}
