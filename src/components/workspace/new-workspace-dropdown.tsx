import { FileText, GitPullRequestDraft, Loader2, Plus } from 'lucide-react';
import { useState } from 'react';

import type { GitHubIssue } from '@/backend/services/github-cli.service';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

import { GitHubIssuePickerForProject } from './github-issue-picker-for-project';
import { type UseCreateWorkspaceOptions, useCreateWorkspace } from './use-create-workspace';

// =============================================================================
// Types
// =============================================================================

export interface NewWorkspaceDropdownProps extends UseCreateWorkspaceOptions {
  /** Button variant */
  variant?: 'default' | 'ghost' | 'outline';
  /** Button size */
  size?: 'default' | 'sm' | 'lg' | 'icon';
  /** Custom button content (replaces default) */
  children?: React.ReactNode;
  /** Additional class names for the trigger button */
  className?: string;
  /** Whether to show as icon-only (for compact layouts) */
  iconOnly?: boolean;
}

// =============================================================================
// Shared Components
// =============================================================================

function ButtonIcon({ isCreating, iconOnly }: { isCreating: boolean; iconOnly: boolean }) {
  const marginClass = iconOnly ? '' : 'mr-1';
  if (isCreating) {
    return <Loader2 className={cn('h-4 w-4 animate-spin', marginClass)} />;
  }
  return <Plus className={cn('h-4 w-4', marginClass)} />;
}

function NewWorkspaceMenuItems({
  onNewWorkspace,
  onFromGitHubIssues,
}: {
  onNewWorkspace: () => void;
  onFromGitHubIssues: () => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={onNewWorkspace}>
        <FileText className="h-4 w-4 mr-2" />
        New workspace
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onFromGitHubIssues}>
        <GitPullRequestDraft className="h-4 w-4 mr-2" />
        From GitHub Issues
      </DropdownMenuItem>
    </>
  );
}

// =============================================================================
// Component
// =============================================================================

export function NewWorkspaceDropdown({
  variant = 'default',
  size = 'sm',
  children,
  className,
  iconOnly = false,
  ...hookOptions
}: NewWorkspaceDropdownProps) {
  const [isIssueDialogOpen, setIsIssueDialogOpen] = useState(false);
  const { isCreating, createFromScratch, createFromGitHubIssue, showGitHubIssuesOption } =
    useCreateWorkspace(hookOptions);

  const handleIssueSelect = (issue: GitHubIssue) => {
    setIsIssueDialogOpen(false);
    createFromGitHubIssue(issue);
  };

  const buttonLabel = children ?? 'Workspace';
  const isDisabled = isCreating || !hookOptions.projectId;

  // If GitHub Issues option is not available, render a simple button
  if (!showGitHubIssuesOption) {
    return (
      <Button
        variant={variant}
        size={size}
        onClick={createFromScratch}
        disabled={isDisabled}
        className={className}
      >
        <ButtonIcon isCreating={isCreating} iconOnly={iconOnly} />
        {!iconOnly && buttonLabel}
      </Button>
    );
  }

  // Render dropdown with both options
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={variant} size={size} disabled={isDisabled} className={className}>
            <ButtonIcon isCreating={isCreating} iconOnly={iconOnly} />
            {!iconOnly && buttonLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <NewWorkspaceMenuItems
            onNewWorkspace={createFromScratch}
            onFromGitHubIssues={() => setIsIssueDialogOpen(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {hookOptions.projectId && (
        <GitHubIssuePickerForProject
          open={isIssueDialogOpen}
          onOpenChange={setIsIssueDialogOpen}
          onSelect={handleIssueSelect}
          projectId={hookOptions.projectId}
        />
      )}
    </>
  );
}

// =============================================================================
// Icon Button Variant (for sidebar/compact layouts)
// =============================================================================

export interface NewWorkspaceIconButtonProps extends UseCreateWorkspaceOptions {
  /** Additional class names */
  className?: string;
  /** Title for the button */
  title?: string;
}

export function NewWorkspaceIconButton({
  className,
  title = 'New Workspace',
  ...hookOptions
}: NewWorkspaceIconButtonProps) {
  const [isIssueDialogOpen, setIsIssueDialogOpen] = useState(false);
  const { isCreating, createFromScratch, createFromGitHubIssue, showGitHubIssuesOption } =
    useCreateWorkspace(hookOptions);

  const handleIssueSelect = (issue: GitHubIssue) => {
    setIsIssueDialogOpen(false);
    createFromGitHubIssue(issue);
  };

  const iconButtonClass = cn(
    'p-1 rounded hover:bg-sidebar-accent transition-colors text-sidebar-foreground/70 hover:text-sidebar-foreground disabled:opacity-50',
    className
  );

  const buttonIcon = isCreating ? (
    <Loader2 className="h-3.5 w-3.5 animate-spin" />
  ) : (
    <Plus className="h-3.5 w-3.5" />
  );

  // If GitHub Issues option is not available, render a simple icon button
  if (!showGitHubIssuesOption) {
    return (
      <button
        type="button"
        onClick={createFromScratch}
        disabled={isCreating || !hookOptions.projectId}
        className={iconButtonClass}
        title={title}
      >
        {buttonIcon}
      </button>
    );
  }

  // Render dropdown with both options
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={isCreating || !hookOptions.projectId}
            className={iconButtonClass}
            title={title}
          >
            {buttonIcon}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <NewWorkspaceMenuItems
            onNewWorkspace={createFromScratch}
            onFromGitHubIssues={() => setIsIssueDialogOpen(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {hookOptions.projectId && (
        <GitHubIssuePickerForProject
          open={isIssueDialogOpen}
          onOpenChange={setIsIssueDialogOpen}
          onSelect={handleIssueSelect}
          projectId={hookOptions.projectId}
        />
      )}
    </>
  );
}
