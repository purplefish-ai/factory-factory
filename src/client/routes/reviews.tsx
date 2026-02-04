import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import type { PRWithFullDetails } from '@/shared/github-types';
import { PRDetailPanel } from '../../frontend/components/pr-detail-panel';
import { PRInboxItem } from '../../frontend/components/pr-inbox-item';
import { trpc } from '../../frontend/lib/trpc';

export default function ReviewsPage() {
  return (
    <Suspense fallback={<ReviewsDashboardSkeleton />}>
      <ReviewsPageContent />
    </Suspense>
  );
}

function ReviewsPageContent() {
  const [searchParams] = useSearchParams();
  const initialRepo = searchParams.get('repo');
  const initialPR = searchParams.get('pr');

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [prDetails, setPrDetails] = useState<Map<string, PRWithFullDetails>>(new Map());
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
  const [diffLoading, setDiffLoading] = useState(false);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const utils = trpc.useUtils();

  // Fetch review requests list
  const { data, isLoading } = trpc.prReview.listReviewRequests.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const prs = data?.prs ?? [];

  // Get details for selected PR
  const selectedPR = prs[selectedIndex];
  const selectedKey = selectedPR
    ? `${selectedPR.repository.nameWithOwner}#${selectedPR.number}`
    : null;
  const selectedDetails = selectedKey ? prDetails.get(selectedKey) : null;
  const selectedDiff = selectedKey ? diffs.get(selectedKey) : null;

  // Fetch PR details query
  const detailsQuery = trpc.prReview.getPRDetails.useQuery(
    {
      repo: selectedPR?.repository.nameWithOwner ?? '',
      number: selectedPR?.number ?? 0,
    },
    {
      enabled: !!selectedPR && !selectedDetails,
      staleTime: 60_000,
    }
  );

  // Update details map when query returns
  useEffect(() => {
    if (detailsQuery.data && selectedKey && !prDetails.has(selectedKey)) {
      setPrDetails((prev) => new Map(prev).set(selectedKey, detailsQuery.data));
    }
  }, [detailsQuery.data, selectedKey, prDetails]);

  // Auto-select PR from URL params on initial load
  useEffect(() => {
    if (initialRepo && initialPR && prs.length > 0) {
      const prNum = Number.parseInt(initialPR, 10);
      const index = prs.findIndex(
        (pr) => pr.repository.nameWithOwner === initialRepo && pr.number === prNum
      );
      if (index >= 0) {
        setSelectedIndex(index);
      }
    }
  }, [initialRepo, initialPR, prs]);

  // Approve mutation
  const approveMutation = trpc.prReview.submitReview.useMutation({
    onSuccess: () => {
      toast.success('PR approved successfully');
      utils.prReview.listReviewRequests.invalidate();
      // Update local details cache
      if (selectedKey && selectedDetails) {
        const updated = { ...selectedDetails, reviewDecision: 'APPROVED' as const };
        setPrDetails((prev) => new Map(prev).set(selectedKey, updated));
      }
    },
    onError: (err) => {
      toast.error(`Failed to approve PR: ${err.message}`);
    },
  });

  // Fetch diff
  const fetchDiff = useCallback(async () => {
    if (!(selectedPR && selectedKey) || diffs.has(selectedKey)) {
      return;
    }

    setDiffLoading(true);
    try {
      const result = await utils.client.prReview.getDiff.query({
        repo: selectedPR.repository.nameWithOwner,
        number: selectedPR.number,
      });
      setDiffs((prev) => new Map(prev).set(selectedKey, result.diff));
    } catch (_err) {
      toast.error('Failed to load diff');
    } finally {
      setDiffLoading(false);
    }
  }, [selectedPR, selectedKey, diffs, utils.client.prReview.getDiff]);

  // Handle approve
  const handleApprove = useCallback(() => {
    if (!selectedPR) {
      return;
    }
    approveMutation.mutate({
      repo: selectedPR.repository.nameWithOwner,
      number: selectedPR.number,
      action: 'approve',
    });
  }, [selectedPR, approveMutation]);

  // Handle open in GitHub
  const handleOpenGitHub = useCallback(() => {
    if (selectedPR) {
      window.open(selectedPR.url, '_blank');
    }
  }, [selectedPR]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case 'j':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, prs.length - 1));
          break;
        case 'k':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'o':
          e.preventDefault();
          handleOpenGitHub();
          break;
        case 'a':
          e.preventDefault();
          if (selectedDetails?.reviewDecision !== 'APPROVED') {
            handleApprove();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prs.length, handleOpenGitHub, handleApprove, selectedDetails?.reviewDecision]);

  // Scroll selected item into view
  useEffect(() => {
    const ref = itemRefs.current.get(selectedIndex);
    if (ref) {
      ref.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  if (isLoading) {
    return <ReviewsDashboardSkeleton />;
  }

  if (prs.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm font-medium">No review requests</p>
          <p className="text-xs">You have no pending PR reviews</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full grid grid-cols-[minmax(380px,440px)_1fr] gap-0">
      {/* Left panel - PR list */}
      <div className="border-r flex flex-col h-full overflow-hidden">
        <div className="px-4 py-3 border-b bg-muted/30">
          <h1 className="text-sm font-semibold">Review Requests</h1>
          <p className="text-xs text-muted-foreground">
            {prs.length} PR{prs.length !== 1 ? 's' : ''} awaiting your review
          </p>
        </div>
        <div className="flex-1 overflow-auto p-2 space-y-2">
          {prs.map((pr, index) => {
            const key = `${pr.repository.nameWithOwner}#${pr.number}`;
            const details = prDetails.get(key);
            // Extract repo name from nameWithOwner
            const repoName =
              pr.repository.nameWithOwner.split('/')[1] || pr.repository.nameWithOwner;
            // Merge basic PR data with full details if available
            // Use reviewDecision and stats from list data if no full details yet
            const prData: PRWithFullDetails = details ?? {
              number: pr.number,
              title: pr.title,
              url: pr.url,
              author: pr.author,
              repository: {
                name: repoName,
                nameWithOwner: pr.repository.nameWithOwner,
              },
              createdAt: pr.createdAt,
              updatedAt: pr.createdAt,
              isDraft: pr.isDraft,
              state: 'OPEN',
              reviewDecision: pr.reviewDecision,
              statusCheckRollup: null,
              reviews: [],
              comments: [],
              labels: [],
              additions: pr.additions,
              deletions: pr.deletions,
              changedFiles: pr.changedFiles,
              headRefName: '',
              baseRefName: '',
              mergeStateStatus: 'UNKNOWN',
            };

            return (
              <PRInboxItem
                key={key}
                ref={(el) => {
                  if (el) {
                    itemRefs.current.set(index, el);
                  }
                }}
                pr={prData}
                isSelected={index === selectedIndex}
                onSelect={() => setSelectedIndex(index)}
              />
            );
          })}
        </div>
      </div>

      {/* Right panel - Detail view */}
      <div className="h-full overflow-hidden">
        <PRDetailPanel
          pr={selectedDetails ?? null}
          diff={selectedDiff ?? null}
          diffLoading={diffLoading}
          onFetchDiff={fetchDiff}
          onOpenGitHub={handleOpenGitHub}
          onApprove={handleApprove}
          approving={approveMutation.isPending}
        />
      </div>
    </div>
  );
}

function ReviewsDashboardSkeleton() {
  return (
    <div className="h-full grid grid-cols-[minmax(380px,440px)_1fr] gap-0">
      <div className="border-r p-2 space-y-2">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 8 }, (_, i) => `skeleton-${i}`).map((id) => (
          <Skeleton key={id} className="h-16 w-full" />
        ))}
      </div>
      <div className="p-4">
        <Skeleton className="h-20 w-full mb-4" />
        <Skeleton className="h-8 w-full mb-2" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
