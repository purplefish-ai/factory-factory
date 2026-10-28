import Database from 'better-sqlite3';
import { z } from 'zod';
import { configService } from '@/backend/services/config.service';
import { type SearchInputSchema, SearchResultSchema } from '@/shared/search';

const CandidateFieldsSchema = z.object({ snippetText: z.string(), updatedAt: z.number() });
const fold = (value: string) => value.normalize('NFC').toLowerCase();

function epoch(value: unknown): number {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Number(value);
  }
  const text = z.string().parse(value);
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const iso = text.replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`;
  return z.number().parse(Date.parse(zoned));
}

// A short-lived read-only connection registers Unicode-aware SQL functions.
// Matching and ranking happen before LIMIT; only bounded results enter JS.
export const metadataSearchAccessor = {
  search({ query, includeArchived, limit }: z.output<typeof SearchInputSchema>) {
    const words = query.split(' ').filter(Boolean);
    const db = new Database(configService.getDatabasePath(), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      db.function('search_matches', { deterministic: true }, (value: string) => {
        const text = fold(value);
        return Number(words.every((word) => text.includes(word)));
      });
      db.function('search_rank', { deterministic: true }, (value: string) => {
        if (!query) {
          return 0;
        }
        const text = fold(value);
        if (text === query) {
          return 100;
        }
        if (text.startsWith(query)) {
          return 80;
        }
        return text.includes(query) ? 60 : 20;
      });
      db.function('search_epoch', { deterministic: true }, epoch);
      const rows = db
        .prepare(`
      WITH pr_metadata AS (
        SELECT workspaceId,
          group_concat(coalesce(title, '') || ' #' || coalesce(number, ''), ' ') AS text
        FROM WorkspacePR WHERE detachedAt IS NULL GROUP BY workspaceId
      ), workspace_metadata AS (
        SELECT w.*, p.name AS projectName, p.slug AS projectSlug,
          (p.isArchived OR w.status = 'ARCHIVED') AS archived,
          coalesce(w.branchName, '') || ' ' || coalesce(w.description, '') || ' ' ||
          CASE WHEN w.githubIssueNumber IS NULL THEN '' ELSE '#' || w.githubIssueNumber END || ' ' ||
          coalesce(w.linearIssueIdentifier, '') || ' ' || coalesce(pr.text, '') AS metadata
        FROM Workspace w JOIN Project p ON p.id = w.projectId
        LEFT JOIN pr_metadata pr ON pr.workspaceId = w.id
      ), candidates AS (
        SELECT 'project' AS kind, p.id, p.name AS title, p.repoPath AS subtitle,
          p.slug AS projectSlug, NULL AS workspaceId, NULL AS sessionId,
          p.isArchived AS archived, p.updatedAt, p.slug AS snippetText,
          p.name || ' ' || p.slug || ' ' || p.repoPath AS searchText
        FROM Project p
        UNION ALL
        SELECT 'workspace', w.id, w.name,
          w.projectName || CASE WHEN w.branchName IS NULL THEN '' ELSE ' · ' || w.branchName END ||
          CASE WHEN w.linearIssueIdentifier IS NULL THEN '' ELSE ' · ' || w.linearIssueIdentifier END ||
          CASE WHEN w.githubIssueNumber IS NULL THEN '' ELSE ' · #' || w.githubIssueNumber END,
          w.projectSlug, w.id, NULL, w.archived, w.updatedAt,
          coalesce(w.description, '') || char(10) || coalesce(pr.text, ''),
          w.name || ' ' || w.projectName || ' ' || w.metadata
        FROM workspace_metadata w LEFT JOIN pr_metadata pr ON pr.workspaceId = w.id
        UNION ALL
        SELECT 'session', s.id, s.name, w.projectName || ' · ' || w.name,
          w.projectSlug, w.id, s.id, w.archived, s.updatedAt, '',
          s.name || ' ' || w.name || ' ' || w.projectName
        FROM AgentSession s JOIN workspace_metadata w ON w.id = s.workspaceId
        WHERE s.name IS NOT NULL AND trim(s.name) <> ''
      )
      SELECT kind, id, title, subtitle, projectSlug, workspaceId, sessionId, archived,
        snippetText, search_epoch(updatedAt) AS updatedAt, search_rank(title) AS relevance
      FROM candidates
      WHERE (@includeArchived OR NOT archived) AND search_matches(searchText)
      ORDER BY relevance DESC, updatedAt DESC, kind, id LIMIT @limit
      `)
        .all({ includeArchived: Number(includeArchived), limit });
      return rows.map((row) => ({
        ...SearchResultSchema.parse(row),
        ...CandidateFieldsSchema.parse(row),
      }));
    } finally {
      db.close();
    }
  },
};
