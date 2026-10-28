import { z } from 'zod';

export const SearchInputSchema = z.object({
  query: z.string().trim().max(200).default(''),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(30),
});

export const SearchResultSchema = z.object({
  kind: z.enum(['project', 'workspace', 'session']),
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  projectSlug: z.string(),
  workspaceId: z.string().nullable(),
  sessionId: z.string().nullable(),
  archived: z.union([z.boolean(), z.number(), z.bigint()]).transform(Boolean),
});

export type SearchResult = z.output<typeof SearchResultSchema>;
