import { z } from 'zod';
import { prisma } from '@/backend/db';
import { Prisma } from '@prisma-gen/client';

/**
 * Large per-workspace data that ARCHIVED workspaces no longer need.
 *
 * `creationMetadata.initialAttachments` (base64 images) is kept until archive
 * so Retry after a failed setup can resend the original attachments; ARCHIVED
 * is terminal, so nothing reads it afterwards. `initOutput` is reduced to a
 * short tail when setup failed or warned (`initErrorMessage` set) and dropped
 * otherwise.
 *
 * Every statement re-checks `status = 'ARCHIVED'`, so an ARCHIVING row (which
 * can still roll back to READY or FAILED) is never touched. The rewrite runs in
 * SQL so the blobs are never loaded into Node. `creationMetadata` is a Prisma
 * `Json` column, which SQLite stores as JSON text, so `json_remove` keeps every
 * other key, SQL NULL stays NULL, and non-object or malformed values are left
 * alone. `updatedAt` is deliberately unchanged: this is storage maintenance,
 * not workspace activity.
 */

const TRUNCATION_MARKER = '[...truncated...]\n';

function hasAttachments() {
  return Prisma.sql`(CASE WHEN json_valid("creationMetadata")
    THEN json_type("creationMetadata", '$.initialAttachments') END) IS NOT NULL`;
}

function initOutputOverLimit(tailChars: number) {
  return Prisma.sql`("initOutput" IS NOT NULL
    AND ("initErrorMessage" IS NULL OR length("initOutput") > ${tailChars}))`;
}

/** Every statement builds this predicate before it runs, so the guard covers them all. */
function releasable(tailChars: number) {
  // A tail no longer than the marker would make the "truncated" log longer
  // than the one it replaces, and it would grow again on every run.
  if (!Number.isInteger(tailChars) || tailChars <= TRUNCATION_MARKER.length) {
    throw new RangeError(`initOutput tail must exceed ${TRUNCATION_MARKER.length} characters`);
  }
  return Prisma.sql`"status" = 'ARCHIVED'
    AND (${hasAttachments()} OR ${initOutputOverLimit(tailChars)})`;
}

function releaseAssignments(tailChars: number) {
  return Prisma.sql`
    "creationMetadata" = CASE WHEN ${hasAttachments()}
      THEN json_remove("creationMetadata", '$.initialAttachments')
      ELSE "creationMetadata" END,
    "initOutput" = CASE
      WHEN "initErrorMessage" IS NULL THEN NULL
      WHEN length("initOutput") <= ${tailChars} THEN "initOutput"
      ELSE ${TRUNCATION_MARKER} || substr("initOutput", -(${tailChars} - ${TRUNCATION_MARKER.length}))
    END`;
}

const idRowsSchema = z.array(z.object({ id: z.string() }));

class WorkspaceArchivedBlobsAccessor {
  /** Release one workspace's data if it is ARCHIVED. Returns the updated row count. */
  async releaseOne(id: string, tailChars: number): Promise<number> {
    const count = await prisma.$executeRaw`
      UPDATE "Workspace" SET ${releaseAssignments(tailChars)}
      WHERE "id" = ${id} AND ${releasable(tailChars)}
    `;
    return Number(count);
  }

  /**
   * Release one bounded batch of ARCHIVED workspaces, in id order after
   * `afterId`. Only ids are selected; the update re-applies the predicate.
   * Returns how many rows were selected and the last selected id, which the
   * caller passes back as the next cursor.
   */
  async releaseBatch(input: {
    afterId: string;
    limit: number;
    tailChars: number;
  }): Promise<{ selected: number; released: number; lastId: string | null }> {
    const rows = idRowsSchema.parse(
      await prisma.$queryRaw`
        SELECT "id" FROM "Workspace"
        WHERE "id" > ${input.afterId} AND ${releasable(input.tailChars)}
        ORDER BY "id"
        LIMIT ${input.limit}
      `
    );
    const lastId = rows.at(-1)?.id ?? null;
    if (!lastId) {
      return { selected: 0, released: 0, lastId };
    }
    const released = await prisma.$executeRaw`
      UPDATE "Workspace" SET ${releaseAssignments(input.tailChars)}
      WHERE "id" IN (${Prisma.join(rows.map((row) => row.id))})
        AND ${releasable(input.tailChars)}
    `;
    return { selected: rows.length, released: Number(released), lastId };
  }
}

export const workspaceArchivedBlobsAccessor = new WorkspaceArchivedBlobsAccessor();
