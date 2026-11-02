import { z } from 'zod';
import { CIStatus, PRState } from '@/shared/core';

export const WorkspacePullRequestSchema = z.object({
  id: z.string(),
  /** Only scalar compatibility adapters mark display-only identities. */
  identitySource: z.literal('legacy-snapshot').optional(),
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
});
export type WorkspacePullRequest = z.infer<typeof WorkspacePullRequestSchema>;

/** Optional on older summary/snapshot payloads; current producers derive both from prs. */
export const WorkspacePRSelectionSchema = z.object({
  selectedPrId: z.string().nullable().optional(),
  selectedPr: WorkspacePullRequestSchema.nullable().optional(),
});

/** Existing selection rule: ID order, first nonterminal (including NONE), else first historical. */
export function selectWorkspacePR<T extends { id: string; state: PRState }>(
  prs: readonly T[]
): T | undefined {
  const ordered = [...prs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ordered.find((pr) => pr.state !== 'MERGED' && pr.state !== 'CLOSED') ?? ordered[0];
}

export function deriveWorkspacePRSelection(prs: readonly WorkspacePullRequest[]) {
  const selectedPr = selectWorkspacePR(prs) ?? null;
  return { selectedPrId: selectedPr?.id ?? null, selectedPr };
}
