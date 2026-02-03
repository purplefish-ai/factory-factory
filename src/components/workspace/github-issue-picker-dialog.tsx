import { AlertCircle, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { GitHubIssue } from '@/backend/services/github-cli.service';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

interface GitHubIssuePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (issue: GitHubIssue) => void;
  workspaceId: string;
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return 'today';
  }
  if (diffDays === 1) {
    return 'yesterday';
  }
  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  }
  return date.toLocaleDateString();
}

interface IssueListContentProps {
  issues: GitHubIssue[];
  filteredIssues: GitHubIssue[];
  selectedIssue: GitHubIssue | null;
  filterText: string;
  isRefetching: boolean;
  onlyMyIssues: boolean;
  authenticatedUser: string | null;
  onFilterChange: (value: string) => void;
  onSelectIssue: (issue: GitHubIssue) => void;
  onRefetch: () => void;
  onOnlyMyIssuesChange: (checked: boolean) => void;
}

function IssueListContent({
  filteredIssues,
  selectedIssue,
  filterText,
  isRefetching,
  onlyMyIssues,
  authenticatedUser,
  onFilterChange,
  onSelectIssue,
  onRefetch,
  onOnlyMyIssuesChange,
}: IssueListContentProps) {
  return (
    <>
      {/* Only my issues filter */}
      {authenticatedUser && (
        <div className="flex items-center gap-2 mb-3">
          <Checkbox
            id="only-my-issues"
            checked={onlyMyIssues}
            onCheckedChange={(checked) => onOnlyMyIssuesChange(checked === true)}
          />
          <Label htmlFor="only-my-issues" className="text-sm cursor-pointer">
            Only my issues
          </Label>
        </div>
      )}

      {/* Search and Refresh bar */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter issues..."
            value={filterText}
            onChange={(e) => onFilterChange(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button variant="ghost" size="icon" onClick={onRefetch} disabled={isRefetching}>
          {isRefetching ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      {/* Issues list */}
      <div className="flex-1 overflow-y-auto border rounded-md">
        {filteredIssues.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-center">
            <p className="text-sm text-muted-foreground">No issues match your filter</p>
          </div>
        ) : (
          <div className="divide-y">
            {filteredIssues.map((issue) => (
              <button
                type="button"
                key={issue.number}
                onClick={() => onSelectIssue(issue)}
                className={cn(
                  'w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors',
                  selectedIssue?.number === issue.number && 'bg-primary/10 hover:bg-primary/10'
                )}
              >
                <div className="flex items-start gap-3">
                  <span className="text-muted-foreground text-sm font-mono">#{issue.number}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{issue.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      opened {formatDate(issue.createdAt)} by {issue.author.login}
                    </p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function GitHubIssuePickerDialog({
  open,
  onOpenChange,
  onSelect,
  workspaceId,
}: GitHubIssuePickerDialogProps) {
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null);
  const [filterText, setFilterText] = useState('');
  const [onlyMyIssues, setOnlyMyIssues] = useState(true);

  const {
    data,
    isLoading,
    error: queryError,
    refetch,
    isRefetching,
  } = trpc.github.listIssuesForWorkspace.useQuery(
    { workspaceId },
    {
      enabled: open,
      staleTime: 0, // Always fetch fresh
      refetchOnWindowFocus: false,
    }
  );

  const issues = data?.issues ?? [];
  const error = queryError?.message ?? data?.error;
  const authenticatedUser = data?.authenticatedUser ?? null;

  // Filter issues by text (searches title, number, and author) and author filter
  const filteredIssues = useMemo(() => {
    let result = issues;

    // Apply "only my issues" filter
    if (onlyMyIssues && authenticatedUser) {
      result = result.filter(
        (issue) => issue.author.login.toLowerCase() === authenticatedUser.toLowerCase()
      );
    }

    // Apply text filter
    if (filterText.trim()) {
      const searchLower = filterText.toLowerCase();
      result = result.filter(
        (issue) =>
          issue.title.toLowerCase().includes(searchLower) ||
          issue.number.toString().includes(searchLower) ||
          issue.author.login.toLowerCase().includes(searchLower)
      );
    }

    return result;
  }, [issues, filterText, onlyMyIssues, authenticatedUser]);

  const handleConfirm = () => {
    if (selectedIssue) {
      onSelect(selectedIssue);
      onOpenChange(false);
      setSelectedIssue(null);
      setFilterText('');
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
    setSelectedIssue(null);
    setFilterText('');
    setOnlyMyIssues(true);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md flex flex-col">
        <SheetHeader>
          <SheetTitle>Import from GitHub Issues</SheetTitle>
          <SheetDescription>
            Select an issue to work on. The issue details will be sent to Claude when the session
            starts.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-hidden flex flex-col min-h-0 py-4">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner className="h-6 w-6" />
              <span className="ml-2 text-sm text-muted-foreground">Loading issues...</span>
            </div>
          ) : issues.length === 0 && !error ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-muted-foreground">No open issues found</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isRefetching}
                className="mt-4"
              >
                {isRefetching ? (
                  <Spinner className="mr-2 h-4 w-4" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Refresh
              </Button>
            </div>
          ) : (
            <IssueListContent
              issues={issues}
              filteredIssues={filteredIssues}
              selectedIssue={selectedIssue}
              filterText={filterText}
              isRefetching={isRefetching}
              onlyMyIssues={onlyMyIssues}
              authenticatedUser={authenticatedUser}
              onFilterChange={setFilterText}
              onSelectIssue={setSelectedIssue}
              onRefetch={() => refetch()}
              onOnlyMyIssuesChange={setOnlyMyIssues}
            />
          )}
        </div>

        <SheetFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!selectedIssue}>
            Select Issue
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
