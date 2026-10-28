import { z } from 'zod';

export const SearchInputSchema = z.object({
  query: z.string().trim().max(200).default(''),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(30),
});

const resultFields = {
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  projectSlug: z.string(),
  archived: z.union([z.boolean(), z.number(), z.bigint()]).transform(Boolean),
  matchSnippet: z.string().nullable().optional(),
};

export const SearchResultSchema = z.discriminatedUnion('kind', [
  z.object({
    ...resultFields,
    kind: z.literal('project'),
    workspaceId: z.null(),
    sessionId: z.null(),
  }),
  z.object({
    ...resultFields,
    kind: z.literal('workspace'),
    workspaceId: z.string().min(1),
    sessionId: z.null(),
  }),
  z.object({
    ...resultFields,
    kind: z.literal('session'),
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
]);

export type SearchResult = z.output<typeof SearchResultSchema>;
