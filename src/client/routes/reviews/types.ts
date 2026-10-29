import type { PRWithFullDetails } from '@/shared/github-types';

export type ReviewRequest = {
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
