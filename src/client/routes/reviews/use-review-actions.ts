import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import type { PRWithFullDetails } from '@/shared/github-types';
import type { ReviewRequest } from './types';

function getDiffFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Couldn't load pull request diff";
}

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
  const [diffErrors, setDiffErrors] = useState<Map<string, string>>(new Map());
  // Toasts outlive the dashboard; a request that settles after it closes stays quiet.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const { mutate: submitApproval, isPending: approving } = trpc.prReview.submitReview.useMutation({
    onSuccess: (_data, variables) => {
      runInBackground(utils.prReview.listReviewRequests.invalidate(), "Couldn't refresh data.");
      if (!mounted.current) {
        return;
      }
      toast.success('PR approved');

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
        toast.error(`Couldn't approve PR. ${err.message}`);
      }
    },
  });

  const fetchDiff = useCallback(async () => {
    if (!(selectedPR && selectedKey) || diffs.has(selectedKey)) {
      return;
    }

    setDiffErrors((prev) => {
      const next = new Map(prev);
      next.delete(selectedKey);
      return next;
    });
    setPendingDiffs((prev) => new Set(prev).add(selectedKey));
    try {
      const result = await utils.client.prReview.getDiff.query({
        repo: selectedPR.repository.nameWithOwner,
        number: selectedPR.number,
      });
      setDiffs((prev) => new Map(prev).set(selectedKey, result.diff));
    } catch (error) {
      const message = getDiffFailureMessage(error);
      setDiffErrors((prev) => new Map(prev).set(selectedKey, message));
      if (mounted.current) {
        toast.error("Couldn't load diff.");
      }
    } finally {
      setPendingDiffs((prev) => {
        const next = new Set(prev);
        next.delete(selectedKey);
        return next;
      });
    }
  }, [selectedPR, selectedKey, diffs, setPendingDiffs, setDiffs, utils.client.prReview.getDiff]);

  const handleApprove = useCallback(() => {
    if (!selectedPR || approving) {
      return;
    }
    submitApproval({
      repo: selectedPR.repository.nameWithOwner,
      number: selectedPR.number,
      action: 'approve',
    });
  }, [selectedPR, submitApproval, approving]);

  const handleOpenGitHub = useCallback(() => {
    if (!selectedPR) {
      return;
    }
    window.open(selectedPR.url, '_blank', 'noopener,noreferrer');
  }, [selectedPR]);

  return {
    diffError: selectedKey ? (diffErrors.get(selectedKey) ?? null) : null,
    fetchDiff,
    handleApprove,
    handleOpenGitHub,
    approving,
  };
}
