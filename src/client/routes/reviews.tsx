import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { HeaderLeftExtraSlot, useAppHeader } from '@/client/components/app-header-context';
import { PRDetailPanel } from '@/client/components/pr-detail-panel';
import { PRInboxItem } from '@/client/components/pr-inbox-item';
import { trpc } from '@/client/lib/trpc';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { WorkspacesBackLink } from '@/components/workspace';
import { useIsMobile } from '@/hooks/use-mobile';
import type { PRWithFullDetails } from '@/shared/github-types';

type ReviewRequest = {
  number: number;
  title: string;
  url: string;
  author: { login: string };
  repository: { nameWithOwner: string };
  createdAt: string;
  isDraft: boolean;
  reviewDecision: PRWithFullDetails['reviewDecision'];
  additions: number;
  deletions: number;
  changedFiles: number;
};

export default function ReviewsPage() {
  return (
    <Suspense fallback={<ReviewsDashboardSkeleton />}>
      <ReviewsPageContent />
    </Suspense>
  );
}

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
    <div className="flex-1 overflow-auto p-2 space-y-2">
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
  useEffect(() => {
    if (!(initialRepo && initialPR) || prs.length === 0) {
      return;
    }

    const prNum = Number.parseInt(initialPR, 10);
    const index = prs.findIndex(
      (pr) => pr.repository.nameWithOwner === initialRepo && pr.number === prNum
    );
    if (index >= 0) {
      setSelectedIndex(index);
    }
  }, [initialRepo, initialPR, prs, setSelectedIndex]);
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
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      const actionByKey: Partial<Record<string, () => void>> = {
        j: () => setSelectedIndex((prev) => Math.min(prev + 1, prsLength - 1)),
        k: () => setSelectedIndex((prev) => Math.max(prev - 1, 0)),
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
            onFetchDiff={onFetchDiff}
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
          onFetchDiff={onFetchDiff}
          onOpenGitHub={onOpenGitHub}
          onApprove={onApprove}
          approving={approving}
        />
      </div>
    </div>
  );
}

function useReviewActions({
  selectedPR,
  selectedKey,
  selectedDetails,
  diffs,
  setPrDetails,
  setDiffs,
  setDiffLoading,
}: {
  selectedPR: ReviewRequest | undefined;
  selectedKey: string | null;
  selectedDetails: PRWithFullDetails | null;
  diffs: Map<string, string>;
  setPrDetails: React.Dispatch<React.SetStateAction<Map<string, PRWithFullDetails>>>;
  setDiffs: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  setDiffLoading: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const utils = trpc.useUtils();

  const approveMutation = trpc.prReview.submitReview.useMutation({
    onSuccess: () => {
      toast.success('PR approved successfully');
      utils.prReview.listReviewRequests.invalidate();
      if (!(selectedKey && selectedDetails)) {
        return;
      }
      const updated = { ...selectedDetails, reviewDecision: 'APPROVED' as const };
      setPrDetails((prev) => new Map(prev).set(selectedKey, updated));
    },
    onError: (err) => {
      toast.error(`Failed to approve PR: ${err.message}`);
    },
  });

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
  }, [selectedPR, selectedKey, diffs, setDiffLoading, setDiffs, utils.client.prReview.getDiff]);

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

  const handleOpenGitHub = useCallback(() => {
    if (!selectedPR) {
      return;
    }
    window.open(selectedPR.url, '_blank');
  }, [selectedPR]);

  return {
    fetchDiff,
    handleApprove,
    handleOpenGitHub,
    approving: approveMutation.isPending,
  };
}

function ReviewsPageContent() {
  useAppHeader({ title: 'Reviews' });

  const [searchParams] = useSearchParams();
  const initialRepo = searchParams.get('repo');
  const initialPR = searchParams.get('pr');

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [prDetails, setPrDetails] = useState<Map<string, PRWithFullDetails>>(new Map());
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
  const [diffLoading, setDiffLoading] = useState(false);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const isMobile = useIsMobile();

  // Fetch review requests list
  const { data, isLoading } = trpc.prReview.listReviewRequests.useQuery(undefined, {
    refetchInterval: 30_000,
  });
  const { data: projects } = trpc.project.list.useQuery();
  const projectSlug = projects?.[0]?.slug;
  const headerBackLink = projectSlug ? (
    <HeaderLeftExtraSlot>
      <WorkspacesBackLink projectSlug={projectSlug} />
    </HeaderLeftExtraSlot>
  ) : null;

  const prs: ReviewRequest[] = data?.prs ?? [];

  // Get details for selected PR
  const selectedPR = prs[selectedIndex];
  const selectedKey = selectedPR
    ? `${selectedPR.repository.nameWithOwner}#${selectedPR.number}`
    : null;
  const selectedDetails = selectedKey ? (prDetails.get(selectedKey) ?? null) : null;
  const selectedDiff = selectedKey ? (diffs.get(selectedKey) ?? null) : null;

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
    details: detailsQuery.data,
    selectedKey,
    hasSelectedDetails: !!selectedDetails,
    setPrDetails,
  });
  useInitialReviewSelection({
    initialRepo,
    initialPR,
    prs,
    setSelectedIndex,
  });
  const { fetchDiff, handleApprove, handleOpenGitHub, approving } = useReviewActions({
    selectedPR,
    selectedKey,
    selectedDetails,
    diffs,
    setPrDetails,
    setDiffs,
    setDiffLoading,
  });

  useReviewKeyboardShortcuts({
    prsLength: prs.length,
    onOpenGitHub: handleOpenGitHub,
    onApprove: handleApprove,
    reviewDecision: selectedDetails?.reviewDecision,
    setSelectedIndex,
  });
  useScrollToSelectedReview(itemRefs, selectedIndex);

  if (isLoading) {
    return (
      <>
        {headerBackLink}
        {isMobile ? <ReviewsDashboardMobileSkeleton /> : <ReviewsDashboardSkeleton />}
      </>
    );
  }

  if (prs.length === 0) {
    return (
      <>
        {headerBackLink}
        <ReviewsEmptyState />
      </>
    );
  }

  const content = isMobile ? (
    <ReviewsMobileLayout
      prs={prs}
      prDetails={prDetails}
      selectedIndex={selectedIndex}
      itemRefs={itemRefs}
      onSelect={(index) => {
        setSelectedIndex(index);
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
      selectedIndex={selectedIndex}
      itemRefs={itemRefs}
      onSelect={setSelectedIndex}
      selectedDetails={selectedDetails}
      selectedDiff={selectedDiff}
      diffLoading={diffLoading}
      onFetchDiff={fetchDiff}
      onOpenGitHub={handleOpenGitHub}
      onApprove={handleApprove}
      approving={approving}
    />
  );

  return (
    <>
      {headerBackLink}
      {content}
    </>
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

function ReviewsDashboardMobileSkeleton() {
  return (
    <div className="h-full p-2 space-y-2">
      {Array.from({ length: 8 }, (_, i) => `mobile-skeleton-${i}`).map((id) => (
        <Skeleton key={id} className="h-16 w-full" />
      ))}
    </div>
  );
}
