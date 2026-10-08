import { z } from 'zod';
import { CIStatus, PRState } from '@/shared/core';

export const WorkspacePullRequestSchema = z.object({
  id: z.string(),
  url: z.string(),
  number: z.number().int().positive().nullable(),
  title: z.string().nullable(),
  headRefName: z.string().nullable(),
  baseRefName: z.string().nullable(),
  state: z.nativeEnum(PRState),
  reviewState: z.string().nullable(),
  ciStatus: z.nativeEnum(CIStatus),
  hasMergeConflict: z.boolean(),
  syncedAt: z.string().nullable(),
  ratchet: z.object({
    lastCheckedAt: z.string().nullable(),
    dispatchOutcome: z.enum(['RUNNING', 'COMPLETED', 'DIED']).nullable(),
    dispatchRetryCount: z.number().int().nonnegative(),
    dispatchStalled: z.boolean(),
  }),
});
export type WorkspacePullRequest = z.infer<typeof WorkspacePullRequestSchema>;
