import { z } from 'zod';
import { prisma } from '@/backend/db';
import { type SearchInputSchema, SearchResultSchema } from '@/shared/search';
import { Prisma } from '@prisma-gen/client';

const CandidateSchema = SearchResultSchema.extend({
  searchText: z.string(),
  updatedAt: z.coerce.number(),
});

// SQLite lower() is ASCII-only. Include non-ASCII candidates for consistent
// Unicode matching in the service; keep unrelated ASCII rows in the database.
export const metadataSearchAccessor = {
  async search({ query, includeArchived, limit }: z.output<typeof SearchInputSchema>) {
    const words = query.split(' ').filter(Boolean);
    const match = words.length
      ? Prisma.join(
          words.map((word) => Prisma.sql`instr(lower(searchText), ${word}) > 0`),
          ' AND '
        )
      : Prisma.sql`1 = 1`;
    const rows = await prisma.$queryRaw<unknown>(Prisma.sql`
      WITH pr_metadata AS (
        SELECT workspaceId,
          group_concat(coalesce(title, '') || ' #' || coalesce(number, '') || ' ' || url, ' ') AS text
        FROM WorkspacePR WHERE detachedAt IS NULL GROUP BY workspaceId
      ), workspace_metadata AS (
        SELECT w.*, p.name AS projectName, p.slug AS projectSlug,
          (p.isArchived OR w.status = 'ARCHIVED') AS archived,
          coalesce(w.branchName, '') || ' ' || coalesce(w.description, '') || ' ' ||
          CASE WHEN w.githubIssueNumber IS NULL THEN '' ELSE '#' || w.githubIssueNumber END || ' ' ||
          coalesce(w.githubIssueUrl, '') || ' ' || coalesce(w.linearIssueIdentifier, '') || ' ' ||
          coalesce(w.linearIssueUrl, '') || ' ' || coalesce(pr.text, '') AS metadata
        FROM Workspace w JOIN Project p ON p.id = w.projectId
        LEFT JOIN pr_metadata pr ON pr.workspaceId = w.id
      ), candidates AS (
        SELECT 'project' AS kind, p.id, p.name AS title, p.repoPath AS subtitle,
          p.slug AS projectSlug, NULL AS workspaceId, NULL AS sessionId,
          p.isArchived AS archived, p.updatedAt,
          p.name || ' ' || p.slug || ' ' || p.repoPath AS searchText
        FROM Project p
        UNION ALL
        SELECT 'workspace', w.id, w.name,
          w.projectName || CASE WHEN w.branchName IS NULL THEN '' ELSE ' · ' || w.branchName END ||
          CASE WHEN w.linearIssueIdentifier IS NULL THEN '' ELSE ' · ' || w.linearIssueIdentifier END ||
          CASE WHEN w.githubIssueNumber IS NULL THEN '' ELSE ' · #' || w.githubIssueNumber END,
          w.projectSlug, w.id, NULL, w.archived, w.updatedAt,
          w.name || ' ' || w.projectName || ' ' || w.metadata
        FROM workspace_metadata w
        UNION ALL
        SELECT 'session', s.id, s.name, w.projectName || ' · ' || w.name,
          w.projectSlug, w.id, s.id, w.archived, s.updatedAt,
          s.name || ' ' || w.name || ' ' || w.projectName
        FROM AgentSession s JOIN workspace_metadata w ON w.id = s.workspaceId
        WHERE s.name IS NOT NULL AND trim(s.name) <> ''
      )
      SELECT kind, id, title, subtitle, projectSlug, workspaceId, sessionId, archived,
        searchText, CAST(updatedAt AS INTEGER) AS updatedAt
      FROM candidates
      WHERE (${includeArchived} OR NOT archived)
        AND (${match} OR searchText GLOB '*[^ -~]*')
      ORDER BY updatedAt DESC, kind, id
      ${query ? Prisma.empty : Prisma.sql`LIMIT ${limit}`}
    `);
    return z.array(CandidateSchema).parse(rows);
  },
};
