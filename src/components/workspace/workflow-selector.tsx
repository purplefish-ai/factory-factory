import type { inferRouterOutputs } from '@trpc/server';
import { Bug, Code, Compass, GitPullRequestDraft, MessageSquare, Play } from 'lucide-react';
import { useState } from 'react';

import type { GitHubIssue } from '@/backend/services/github-cli.service';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { GitHubIssuePickerDialog } from '@/components/workspace/github-issue-picker-dialog';
import { type AppRouter, trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

// Infer Workflow type from tRPC router to avoid duplication with backend
type RouterOutputs = inferRouterOutputs<AppRouter>;
type Workflow = RouterOutputs['session']['listWorkflows'][number];

// Special workflow ID for GitHub Issues
const GITHUB_ISSUES_WORKFLOW_ID = 'github-issues';

export interface WorkflowSelectorProps {
  workflows: Workflow[];
  recommendedWorkflow: string;
  onSelect: (workflowId: string, linkedIssue?: GitHubIssue) => void;
  disabled?: boolean;
  /** Warning message to show if workspace is not ready for sessions */
  warningMessage?: string;
  /** Workspace ID needed to fetch GitHub issues */
  workspaceId: string;
}

// =============================================================================
// Helpers
// =============================================================================

function getWorkflowIcon(workflowId: string) {
  switch (workflowId) {
    case 'feature':
      return Code;
    case 'bugfix':
      return Bug;
    case 'explore':
      return Compass;
    case 'followup':
      return MessageSquare;
    case GITHUB_ISSUES_WORKFLOW_ID:
      return GitPullRequestDraft;
    default:
      return Code;
  }
}

// =============================================================================
// Component
// =============================================================================

export function WorkflowSelector({
  workflows,
  recommendedWorkflow,
  onSelect,
  disabled = false,
  warningMessage,
  workspaceId,
}: WorkflowSelectorProps) {
  const [selectedWorkflow, setSelectedWorkflow] = useState(recommendedWorkflow);
  const [linkedIssue, setLinkedIssue] = useState<GitHubIssue | null>(null);
  const [isIssueDialogOpen, setIsIssueDialogOpen] = useState(false);

  // Check if project has GitHub repo configured
  const { data: hasGitHubRepo } = trpc.github.hasGitHubRepo.useQuery(
    { workspaceId },
    { staleTime: 60_000 }
  );

  // Check GitHub auth status to determine if we should show the GitHub Issues option
  const { data: githubHealth } = trpc.github.checkHealth.useQuery(undefined, {
    enabled: hasGitHubRepo === true,
    staleTime: 60_000, // Cache for 1 minute
  });

  const showGitHubIssuesOption = hasGitHubRepo && githubHealth?.isAuthenticated;

  // Handle workflow card click
  const handleWorkflowClick = (workflowId: string) => {
    if (disabled) {
      return;
    }

    if (workflowId === GITHUB_ISSUES_WORKFLOW_ID) {
      // Open the issue picker dialog instead of selecting this as a workflow
      setIsIssueDialogOpen(true);
    } else {
      setSelectedWorkflow(workflowId);
      // Clear linked issue if switching away from GitHub Issues
      if (linkedIssue) {
        setLinkedIssue(null);
      }
    }
  };

  // Handle issue selection from dialog
  const handleIssueSelect = (issue: GitHubIssue) => {
    setLinkedIssue(issue);
    // Auto-select the feature workflow when an issue is linked
    setSelectedWorkflow('feature');
  };

  // Check if GitHub Issues card should appear selected (when dialog is open or an issue is linked)
  const isGitHubIssuesSelected = isIssueDialogOpen || linkedIssue !== null;

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="max-w-2xl w-full space-y-6">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold">Start a Session</h2>
          <p className="text-muted-foreground">
            Choose a workflow to guide Claude through your task.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {workflows.map((workflow) => {
            const Icon = getWorkflowIcon(workflow.id);
            const isSelected = selectedWorkflow === workflow.id && !isGitHubIssuesSelected;
            const isRecommended = workflow.id === recommendedWorkflow;

            return (
              <Card
                key={workflow.id}
                className={cn(
                  'cursor-pointer transition-all hover:border-primary/50',
                  isSelected && 'border-primary ring-1 ring-primary',
                  disabled && 'opacity-50 cursor-not-allowed'
                )}
                onClick={() => handleWorkflowClick(workflow.id)}
              >
                <CardHeader className="p-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        'p-2 rounded-md',
                        isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted'
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <CardTitle className="text-base flex items-center gap-2">
                        {workflow.name}
                        {isRecommended && !isGitHubIssuesSelected && (
                          <span className="text-xs font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            Recommended
                          </span>
                        )}
                      </CardTitle>
                      <CardDescription className="text-sm">{workflow.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            );
          })}

          {/* GitHub Issues option - shown when GitHub is configured and authenticated */}
          {showGitHubIssuesOption && (
            <Card
              className={cn(
                'cursor-pointer transition-all hover:border-primary/50',
                isGitHubIssuesSelected && 'border-primary ring-1 ring-primary',
                disabled && 'opacity-50 cursor-not-allowed'
              )}
              onClick={() => handleWorkflowClick(GITHUB_ISSUES_WORKFLOW_ID)}
            >
              <CardHeader className="p-4">
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      'p-2 rounded-md',
                      isGitHubIssuesSelected ? 'bg-primary text-primary-foreground' : 'bg-muted'
                    )}
                  >
                    <GitPullRequestDraft className="h-4 w-4" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <CardTitle className="text-base flex items-center gap-2">
                      GitHub Issues
                    </CardTitle>
                    <CardDescription className="text-sm">
                      {linkedIssue
                        ? `#${linkedIssue.number}: ${linkedIssue.title}`
                        : 'Pull from GitHub issues to start a task'}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
            </Card>
          )}
        </div>

        {warningMessage && (
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-md text-sm">
            {warningMessage}
          </div>
        )}

        <div className="flex justify-center pt-2">
          <Button
            size="lg"
            onClick={() => {
              onSelect(selectedWorkflow, linkedIssue ?? undefined);
            }}
            disabled={disabled || !selectedWorkflow}
            className="gap-2"
          >
            <Play className="h-4 w-4" />
            Start Session
          </Button>
        </div>
      </div>

      <GitHubIssuePickerDialog
        open={isIssueDialogOpen}
        onOpenChange={setIsIssueDialogOpen}
        onSelect={handleIssueSelect}
        workspaceId={workspaceId}
      />
    </div>
  );
}
