import { z } from 'zod';

/**
 * Zod schemas for gh CLI JSON responses
 */
const statusCheckRollupItemSchema = z
  .object({
    status: z.string().optional(),
    conclusion: z.string().optional(),
    state: z.string().optional(),
  })
  .refine((item) => item.status !== undefined || item.state !== undefined, {
    message: 'statusCheckRollup items must include status or state',
  });

/**
 * Transform empty string to null for reviewDecision field.
 * The gh CLI returns "" (empty string) when a PR has no review decision,
 * as the Go backend serializes GraphQL null enum values as empty strings.
 */
const reviewDecisionSchema = z.preprocess(
  (val) => (val === '' ? null : val),
  z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable()
);

export const prStatusSchema = z.object({
  number: z.number(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  reviewDecision: reviewDecisionSchema,
  mergedAt: z.string().nullable(),
  updatedAt: z.string(),
  statusCheckRollup: z.array(statusCheckRollupItemSchema).nullable(),
});

const authorSchema = z.object({
  login: z.string(),
});

const repositorySchema = z.object({
  nameWithOwner: z.string(),
});

export const basePRSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  repository: repositorySchema,
  author: authorSchema,
  createdAt: z.string(),
  isDraft: z.boolean(),
});

export const prDetailsSchema = z.object({
  reviewDecision: reviewDecisionSchema,
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changedFiles: z.number().optional(),
});

export const prListItemSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.string(),
});

const fullPRCheckRunSchema = z.object({
  __typename: z.enum(['CheckRun', 'StatusContext']).optional(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  detailsUrl: z.string().optional(),
});

const fullPRStatusContextSchema = z.object({
  __typename: z.enum(['CheckRun', 'StatusContext']).optional(),
  context: z.string(),
  state: z.string(),
  targetUrl: z.string().optional(),
  detailsUrl: z.string().optional(),
});

export const fullPRDetailsSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: authorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  reviewDecision: reviewDecisionSchema,
  statusCheckRollup: z.array(z.union([fullPRCheckRunSchema, fullPRStatusContextSchema])).nullable(),
  reviews: z.array(
    z
      .object({
        id: z.string(),
        author: z.object({ login: z.string() }),
        state: z.string(),
        submittedAt: z.string(),
        body: z.string().optional(),
      })
      .passthrough()
  ),
  comments: z.array(
    z
      .object({
        id: z.string(),
        author: z.object({ login: z.string() }),
        body: z.string(),
        createdAt: z.string(),
        updatedAt: z.string().nullish(),
        url: z.string(),
      })
      .passthrough()
  ),
  labels: z.array(
    z
      .object({
        name: z.string(),
        color: z.string(),
      })
      .passthrough()
  ),
  additions: z.number().optional(),
  deletions: z.number().optional(),
  changedFiles: z.number().optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  mergeStateStatus: z
    .enum(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'])
    .optional(),
});

export const issueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  createdAt: z.string(),
  author: authorSchema,
});

export const reviewCommentSchema = z.object({
  id: z.number(),
  user: z.object({
    login: z.string(),
  }),
  body: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  html_url: z.string(),
});
