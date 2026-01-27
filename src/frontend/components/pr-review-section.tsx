'use client';

import { AlertTriangle, Check, ExternalLink, GitPullRequest } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/components/ui/sidebar';
import { trpc } from '../lib/trpc';

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${diffDays}d ago`;
}

export function PRReviewSection() {
  const utils = trpc.useUtils();

  const { data, isLoading, error } = trpc.prReview.listReviewRequests.useQuery(undefined, {
    refetchInterval: 30_000, // Poll every 30 seconds
  });

  const approveMutation = trpc.prReview.approve.useMutation({
    onSuccess: () => {
      toast.success('PR approved successfully');
      utils.prReview.listReviewRequests.invalidate();
    },
    onError: (err) => {
      toast.error(`Failed to approve PR: ${err.message}`);
    },
  });

  const handleApprove = (pr: {
    number: number;
    repository: { nameWithOwner: string };
    title: string;
  }) => {
    const parts = pr.repository.nameWithOwner.split('/');
    if (parts.length !== 2) {
      toast.error('Invalid repository format');
      return;
    }
    const [owner, repo] = parts;
    approveMutation.mutate({
      owner,
      repo,
      prNumber: pr.number,
    });
  };

  const handleOpenPR = (url: string) => {
    window.open(url, '_blank');
  };

  // Don't render if gh CLI is not configured
  if (!isLoading && data?.health && !(data.health.isInstalled && data.health.isAuthenticated)) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Review Requests</SidebarGroupLabel>
        <SidebarGroupContent>
          <Alert variant="default" className="mx-2 my-1 py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {!data.health.isInstalled ? (
                <>
                  gh CLI not installed.{' '}
                  <a
                    href="https://cli.github.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Install it
                  </a>
                </>
              ) : (
                <>
                  gh CLI not authenticated.
                  <br />
                  Run <code className="text-xs bg-muted px-1 rounded">gh auth login</code>
                </>
              )}
            </AlertDescription>
          </Alert>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Review Requests</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {[1, 2, 3].map((i) => (
              <SidebarMenuItem key={i}>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  // Error state (tRPC error or API error)
  const apiError = data?.error;
  if (error || apiError) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Review Requests</SidebarGroupLabel>
        <SidebarGroupContent>
          <Alert variant="destructive" className="mx-2 my-1 py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Failed to load review requests.{' '}
              <button
                type="button"
                onClick={() => utils.prReview.listReviewRequests.invalidate()}
                className="underline"
              >
                Retry
              </button>
            </AlertDescription>
          </Alert>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  const prs = data?.prs ?? [];

  // Empty state
  if (prs.length === 0) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>Review Requests</SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="px-2 py-4 text-xs text-muted-foreground text-center">
            No reviews requested
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="flex items-center justify-between">
        Review Requests
        <SidebarMenuBadge className="relative top-0 right-0">{prs.length}</SidebarMenuBadge>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {prs.map((pr) => {
            const isApproving =
              approveMutation.isPending &&
              approveMutation.variables?.prNumber === pr.number &&
              `${approveMutation.variables?.owner}/${approveMutation.variables?.repo}` ===
                pr.repository.nameWithOwner;

            return (
              <SidebarMenuItem key={`${pr.repository.nameWithOwner}-${pr.number}`}>
                <SidebarMenuButton
                  onClick={() => handleOpenPR(pr.url)}
                  className="h-auto py-2 pr-8"
                  title={`Open PR #${pr.number} in browser`}
                >
                  <div className="flex flex-col gap-0.5 w-0 flex-1 overflow-hidden">
                    <div className="flex items-center gap-1.5">
                      <GitPullRequest className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium text-sm">
                        {pr.title}
                        {pr.isDraft && (
                          <span className="ml-1 text-xs text-muted-foreground">(draft)</span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="truncate">{pr.repository.nameWithOwner}</span>
                      <span>·</span>
                      <span className="shrink-0">{formatRelativeTime(pr.createdAt)}</span>
                    </div>
                  </div>
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-50" />
                </SidebarMenuButton>
                <SidebarMenuAction
                  showOnHover
                  onClick={(e) => {
                    e.stopPropagation();
                    handleApprove(pr);
                  }}
                  disabled={isApproving}
                  title="Approve PR"
                >
                  <Check className={isApproving ? 'animate-pulse' : ''} />
                </SidebarMenuAction>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
