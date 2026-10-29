import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PRDetailPanel } from '@/client/components/pr-detail-panel';
import { PRInboxItem } from '@/client/components/pr-inbox-item';
import {
  useProjectReviewRequests,
  type ReviewProject,
} from '@/client/hooks/use-project-review-requests';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/use-mobile';
import type { PRWithFullDetails } from '@/shared/github-types';
import { ReviewRouteState } from './route-state';
import type { ReviewRequest } from './types';
import { useReviewActions } from './use-review-actions';

function toPRData(pr: ReviewRequest, details: PRWithFullDetails | undefined): PRWithFullDetails {
  if (details) {
    return details;
  }
  const repoName = pr.repository.nameWithOwner.split('/')[1] || pr.repository.nameWithOwner;
  return {
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
}

function ReviewsListPanel({
  prs,
  prDetails,
  selectedIndex,
  itemRefs,
  onSelect,
}: {
  prs: ReviewRequest[];
  prDetails: Map<string, PRWithFullDetails>;
  selectedIndex: number;
  itemRefs: React.MutableRefObject<Map<number, HTMLButtonElement>>;
  onSelect: (index: number) => void;
}) {
  return (
    <div data-review-list="" className="flex-1 overflow-auto p-2 space-y-2">
      {prs.map((pr, index) => {
        const key = `${pr.repository.nameWithOwner}#${pr.number}`;
        const details = prDetails.get(key);
        return (
          <PRInboxItem
            key={key}
            ref={(el) => {
              if (el) {
                itemRefs.current.set(index, el);
              }
            }}
            pr={toPRData(pr, details)}
            isSelected={index === selectedIndex}
            onSelect={() => onSelect(index)}
          />
        );
      })}
    </div>
  );
}

function useCacheSelectedDetails({
  details,
  selectedKey,
  hasSelectedDetails,
  setPrDetails,
}: {
  details: PRWithFullDetails | undefined;
  selectedKey: string | null;
  hasSelectedDetails: boolean;
  setPrDetails: React.Dispatch<React.SetStateAction<Map<string, PRWithFullDetails>>>;
}) {
  useEffect(() => {
    if (!(details && selectedKey) || hasSelectedDetails) {
      return;
    }
    setPrDetails((prev) => new Map(prev).set(selectedKey, details));
  }, [details, selectedKey, hasSelectedDetails, setPrDetails]);
}

function useInitialReviewSelection({
  initialRepo,
  initialPR,
  prs,
  setSelectedIndex,
}: {
  initialRepo: string | null;
  initialPR: string | null;
  prs: ReviewRequest[];
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
}) {
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const identity = `${initialRepo}#${initialPR}`;
    if (applied.current === identity || !(initialRepo && initialPR) || prs.length === 0) {
      return;
    }
    if (!/^[1-9]\d*$/.test(initialPR)) {
      return;
    }
    const prNum = Number(initialPR);
    if (!Number.isSafeInteger(prNum)) {
      return;
    }
    const index = prs.findIndex(
      (pr) =>
        pr.repository.nameWithOwner.toLowerCase() === initialRepo.toLowerCase() &&
        pr.number === prNum
    );
    if (index >= 0) {
      applied.current = identity;
      setSelectedIndex(index);
    }
  }, [initialRepo, initialPR, prs, setSelectedIndex]);
  return useCallback(() => {
    applied.current = `${initialRepo}#${initialPR}`;
  }, [initialRepo, initialPR]);
}

function shouldIgnoreReviewShortcut(event: KeyboardEvent): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return true;
  }
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (
    target?.closest(
      'input, textarea, select, dialog, [contenteditable]:not([contenteditable="false"]), ' +
        '[role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="menubar"], ' +
        '[role^="menuitem"], [role="dialog"], [role="alertdialog"], [role="textbox"], [role="searchbox"]'
    )
  ) {
    return true;
  }
  const control = target?.closest('button, a[href]');
  return !!control && !control.matches('[data-review-list] > button');
}

function moveReviewSelection(previous: number, count: number, step: number): number {
  const last = Math.max(0, count - 1);
  const current = Math.max(0, Math.min(previous, last));
  return Math.max(0, Math.min(current + step, last));
}

function useReviewKeyboardShortcuts({
  prsLength,
  onOpenGitHub,
  onApprove,
  reviewDecision,
  setSelectedIndex,
}: {
  prsLength: number;
  onOpenGitHub: () => void;
  onApprove: () => void;
  reviewDecision: PRWithFullDetails['reviewDecision'] | null | undefined;
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreReviewShortcut(event)) {
        return;
      }

      const actionByKey: Partial<Record<string, () => void>> = {
        j: () => setSelectedIndex((prev) => moveReviewSelection(prev, prsLength, 1)),
        k: () => setSelectedIndex((prev) => moveReviewSelection(prev, prsLength, -1)),
        o: onOpenGitHub,
        a: () => {
          if (reviewDecision !== 'APPROVED') {
            onApprove();
          }
        },
      };

      const action = actionByKey[event.key];
      if (!action) {
        return;
      }
      event.preventDefault();
      action();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prsLength, onOpenGitHub, onApprove, reviewDecision, setSelectedIndex]);
}

function useScrollToSelectedReview(
  itemRefs: React.MutableRefObject<Map<number, HTMLButtonElement>>,
  selectedIndex: number
) {
  useEffect(() => {
    const ref = itemRefs.current.get(selectedIndex);
    if (ref) {
      ref.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [itemRefs, selectedIndex]);
}

function ReviewsHeader({ count, className }: { count: number; className: string }) {
  return (
    <div className={className}>
      <h1 className="text-sm font-semibold">Review Requests</h1>
      <p className="text-xs text-muted-foreground">
        {count} PR{count !== 1 ? 's' : ''} awaiting your review
      </p>
    </div>
  );
}

function ReviewsEmptyState() {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground">
      <div className="text-center">
        <p className="text-sm font-medium">No review requests</p>
        <p className="text-xs">You have no pending PR reviews</p>
      </div>
    </div>
  );
}

function ReviewsMobileLayout({
  prs,
  prDetails,
  selectedIndex,
  itemRefs,
  onSelect,
  mobileDetailsOpen,
  setMobileDetailsOpen,
  selectedPR,
  selectedDetails,
  selectedDiff,
  diffLoading,
  onFetchDiff,
  onOpenGitHub,
  onApprove,
  approving,
}: {
  prs: ReviewRequest[];
  prDetails: Map<string, PRWithFullDetails>;
  selectedIndex: number;
  itemRefs: React.MutableRefObject<Map<number, HTMLButtonElement>>;
  onSelect: (index: number) => void;
  mobileDetailsOpen: boolean;
  setMobileDetailsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedPR: ReviewRequest | undefined;
  selectedDetails: PRWithFullDetails | null;
  selectedDiff: string | null;
  diffLoading: boolean;
  onFetchDiff: () => Promise<void>;
  onOpenGitHub: () => void;
  onApprove: () => void;
  approving: boolean;
}) {
  return (
    <div className="h-full flex flex-col">
      <ReviewsHeader count={prs.length} className="px-3 py-3 border-b bg-muted/30" />
      <ReviewsListPanel
        prs={prs}
        prDetails={prDetails}
        selectedIndex={selectedIndex}
        itemRefs={itemRefs}
        onSelect={onSelect}
      />

      <Sheet open={mobileDetailsOpen && !!selectedPR} onOpenChange={setMobileDetailsOpen}>
        <SheetContent side="bottom" className="h-[92dvh] w-full max-w-none p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Pull Request Details</SheetTitle>
            <SheetDescription>Review request details and actions</SheetDescription>
          </SheetHeader>
          <PRDetailPanel
            pr={selectedDetails ?? null}
            diff={selectedDiff ?? null}
            diffLoading={diffLoading}
            onFetchDiff={() => {
              runInBackground(onFetchDiff(), 'Could not load pull request diff');
            }}
            onOpenGitHub={onOpenGitHub}
            onApprove={onApprove}
            approving={approving}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ReviewsDesktopLayout({
  prs,
  prDetails,
  selectedIndex,
  itemRefs,
  onSelect,
  selectedDetails,
  selectedDiff,
  diffLoading,
  onFetchDiff,
  onOpenGitHub,
  onApprove,
  approving,
}: {
  prs: ReviewRequest[];
  prDetails: Map<string, PRWithFullDetails>;
  selectedIndex: number;
  itemRefs: React.MutableRefObject<Map<number, HTMLButtonElement>>;
  onSelect: (index: number) => void;
  selectedDetails: PRWithFullDetails | null;
  selectedDiff: string | null;
  diffLoading: boolean;
  onFetchDiff: () => Promise<void>;
  onOpenGitHub: () => void;
  onApprove: () => void;
  approving: boolean;
}) {
  return (
    <div className="h-full grid grid-cols-[minmax(380px,440px)_1fr] gap-0">
      <div className="border-r flex flex-col h-full overflow-hidden">
        <ReviewsHeader count={prs.length} className="px-4 py-3 border-b bg-muted/30" />
        <ReviewsListPanel
          prs={prs}
          prDetails={prDetails}
          selectedIndex={selectedIndex}
          itemRefs={itemRefs}
          onSelect={onSelect}
        />
      </div>

      <div className="h-full overflow-hidden">
        <PRDetailPanel
          pr={selectedDetails ?? null}
          diff={selectedDiff ?? null}
          diffLoading={diffLoading}
          onFetchDiff={() => {
            runInBackground(onFetchDiff(), 'Could not load pull request diff');
          }}
          onOpenGitHub={onOpenGitHub}
          onApprove={onApprove}
          approving={approving}
        />
      </div>
    </div>
  );
}

function getSelectedReview(
  prs: ReviewRequest[],
  selectedIndex: number,
  prDetails: Map<string, PRWithFullDetails>,
  diffs: Map<string, string>,
  pendingDiffs: Set<string>
) {
  const boundedIndex = Math.min(selectedIndex, Math.max(0, prs.length - 1));
  const selectedPR = prs[boundedIndex];
  const selectedKey = selectedPR
    ? `${selectedPR.repository.nameWithOwner}#${selectedPR.number}`
    : null;
  const selectedDetails = selectedKey ? (prDetails.get(selectedKey) ?? null) : null;
  const selectedDiff = selectedKey ? (diffs.get(selectedKey) ?? null) : null;
  const diffLoading = !!selectedKey && pendingDiffs.has(selectedKey);

  return { boundedIndex, selectedPR, selectedKey, selectedDetails, selectedDiff, diffLoading };
}

function getMatchingDetails(
  details: PRWithFullDetails | undefined,
  selectedPR: ReviewRequest | undefined
) {
  if (
    details?.number !== selectedPR?.number ||
    details?.repository.nameWithOwner.toLowerCase() !==
      selectedPR?.repository.nameWithOwner.toLowerCase()
  ) {
    return undefined;
  }
  return details;
}

export function ReviewDashboard({ project }: { project: ReviewProject }) {
  const [searchParams] = useSearchParams();
  const initialRepo = searchParams.get('repo');
  const initialPR = searchParams.get('pr');

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [prDetails, setPrDetails] = useState<Map<string, PRWithFullDetails>>(new Map());
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
  const [pendingDiffs, setPendingDiffs] = useState<Set<string>>(new Set());
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const isMobile = useIsMobile();

  const { prs, isLoading, error, data, refetch } = useProjectReviewRequests(project);

  // Get details for selected PR
  const { boundedIndex, selectedPR, selectedKey, selectedDetails, selectedDiff, diffLoading } =
    getSelectedReview(prs, selectedIndex, prDetails, diffs, pendingDiffs);

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

  useCacheSelectedDetails({
    details: getMatchingDetails(detailsQuery.data, selectedPR),
    selectedKey,
    hasSelectedDetails: !!selectedDetails,
    setPrDetails,
  });
  const markUserSelection = useInitialReviewSelection({
    initialRepo,
    initialPR,
    prs,
    setSelectedIndex,
  });
  const selectReview = useCallback(
    (update: React.SetStateAction<number>) => {
      markUserSelection();
      setSelectedIndex(update);
    },
    [markUserSelection]
  );
  const { fetchDiff, handleApprove, handleOpenGitHub, approving } = useReviewActions({
    selectedPR,
    selectedKey,
    diffs,
    setPrDetails,
    setDiffs,
    setPendingDiffs,
  });

  useReviewKeyboardShortcuts({
    prsLength: prs.length,
    onOpenGitHub: handleOpenGitHub,
    onApprove: handleApprove,
    reviewDecision: selectedDetails?.reviewDecision,
    setSelectedIndex: selectReview,
  });
  useScrollToSelectedReview(itemRefs, selectedIndex);

  if (error || data?.error) {
    return (
      <ReviewRouteState
        error={error?.message ?? data?.error ?? 'Could not load reviews'}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }
  if (data?.health && !(data.health.isInstalled && data.health.isAuthenticated)) {
    return (
      <ReviewRouteState
        error="GitHub CLI must be installed and authenticated to load reviews"
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }
  if (isLoading) {
    return isMobile ? <ReviewsDashboardMobileSkeleton /> : <ReviewsDashboardSkeleton />;
  }
  if (prs.length === 0) {
    return <ReviewsEmptyState />;
  }

  const content = isMobile ? (
    <ReviewsMobileLayout
      prs={prs}
      prDetails={prDetails}
      selectedIndex={boundedIndex}
      itemRefs={itemRefs}
      onSelect={(index) => {
        selectReview(index);
        setMobileDetailsOpen(true);
      }}
      mobileDetailsOpen={mobileDetailsOpen}
      setMobileDetailsOpen={setMobileDetailsOpen}
      selectedPR={selectedPR}
      selectedDetails={selectedDetails}
      selectedDiff={selectedDiff}
      diffLoading={diffLoading}
      onFetchDiff={fetchDiff}
      onOpenGitHub={handleOpenGitHub}
      onApprove={handleApprove}
      approving={approving}
    />
  ) : (
    <ReviewsDesktopLayout
      prs={prs}
      prDetails={prDetails}
      selectedIndex={boundedIndex}
      itemRefs={itemRefs}
      onSelect={selectReview}
      selectedDetails={selectedDetails}
      selectedDiff={selectedDiff}
      diffLoading={diffLoading}
      onFetchDiff={fetchDiff}
      onOpenGitHub={handleOpenGitHub}
      onApprove={handleApprove}
      approving={approving}
    />
  );

  return content;
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

function ReviewsDashboardMobileSkeleton() {
  return (
    <div className="h-full p-2 space-y-2">
      {Array.from({ length: 8 }, (_, i) => `mobile-skeleton-${i}`).map((id) => (
        <Skeleton key={id} className="h-16 w-full" />
      ))}
    </div>
  );
}
