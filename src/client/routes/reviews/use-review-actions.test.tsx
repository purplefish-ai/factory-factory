// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PRWithFullDetails } from '@/shared/github-types';
import { unsafeCoerce } from '@/test-utils/unsafe-coerce';
import type { ReviewRequest } from './types';
import { useReviewActions } from './use-review-actions';
const query = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      client: { prReview: { getDiff: { query } } },
      prReview: { listReviewRequests: { invalidate: vi.fn() } },
    }),
    prReview: { submitReview: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) } },
  },
}));
let root: Root;
let selectedKey: string;
let actions: ReturnType<typeof useReviewActions>;
function Harness() {
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
  const [, setPendingDiffs] = useState<Set<string>>(new Set());
  const [, setPrDetails] = useState<Map<string, PRWithFullDetails>>(new Map());
  actions = useReviewActions({
    selectedKey,
    selectedPR: unsafeCoerce<ReviewRequest>({
      repository: { nameWithOwner: 'owner/repo' },
      number: selectedKey.endsWith('1') ? 1 : 2,
    }),
    diffs,
    setDiffs,
    setPendingDiffs,
    setPrDetails,
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.mockReset();
  selectedKey = 'owner/repo#1';
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it('retains the failed diff error only for its owning pull request', async () => {
  query.mockRejectedValue(new Error('Offline'));
  await act(() => root.render(<Harness />));
  await act(async () => actions.fetchDiff());
  expect(actions.diffError).toBe('Offline');
  selectedKey = 'owner/repo#2';
  await act(() => root.render(<Harness />));
  expect(actions.diffError).toBeNull();
  selectedKey = 'owner/repo#1';
  await act(() => root.render(<Harness />));
  expect(actions.diffError).toBe('Offline');
});
it('keeps empty error messages recoverable and clears the error after a successful retry', async () => {
  query.mockRejectedValueOnce(new Error('')).mockResolvedValueOnce({ diff: 'patch' });
  await act(() => root.render(<Harness />));
  await act(async () => actions.fetchDiff());
  expect(actions.diffError).toBe("Couldn't load pull request diff");
  await act(async () => actions.fetchDiff());
  expect(actions.diffError).toBeNull();
  await act(async () => actions.fetchDiff());
  expect(query).toHaveBeenCalledTimes(2);
});
