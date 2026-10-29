import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import type { PRWithFullDetails } from '@/shared/github-types';
import type { ReviewRequest } from './types';

export function useReviewActions({
  selectedPR,
  selectedKey,
  diffs,
  setPrDetails,
  setDiffs,
  setPendingDiffs,
}: {
  selectedPR: ReviewRequest | undefined;
  selectedKey: string | null;
  diffs: Map<string, string>;
  setPrDetails: React.Dispatch<React.SetStateAction<Map<string, PRWithFullDetails>>>;
  setDiffs: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  setPendingDiffs: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const utils = trpc.useUtils();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const approveMutation = trpc.prReview.submitReview.useMutation({
    onSuccess: (_data, variables) => {
      runInBackground(utils.prReview.listReviewRequests.invalidate(), 'Could not refresh data');
      if (!mounted.current) {
        return;
      }
      toast.success('PR approved successfully');

      const approvedKey = `${variables.repo}#${variables.number}`;
      setPrDetails((prev) => {
        const approvedDetails = prev.get(approvedKey);
        if (!approvedDetails) {
          return prev;
        }
        return new Map(prev).set(approvedKey, {
          ...approvedDetails,
          reviewDecision: 'APPROVED',
        });
      });
    },
    onError: (err) => {
      if (mounted.current) {
        toast.error(`Failed to approve PR: ${err.message}`);
      }
    },
  });

  const fetchDiff = useCallback(async () => {
    if (!(selectedPR && selectedKey) || diffs.has(selectedKey)) {
      return;
    }

    setPendingDiffs((prev) => new Set(prev).add(selectedKey));
    try {
      const result = await utils.client.prReview.getDiff.query({
        repo: selectedPR.repository.nameWithOwner,
        number: selectedPR.number,
      });
      if (mounted.current) {
        setDiffs((prev) => new Map(prev).set(selectedKey, result.diff));
      }
    } catch (_err) {
      if (mounted.current) {
        toast.error('Failed to load diff');
      }
    } finally {
      if (mounted.current) {
        setPendingDiffs((prev) => {
          const next = new Set(prev);
          next.delete(selectedKey);
          return next;
        });
      }
    }
  }, [selectedPR, selectedKey, diffs, setPendingDiffs, setDiffs, utils.client.prReview.getDiff]);

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
