/**
 * Guard for the child-workspace depth-1 invariant, which lives in SQLite
 * triggers rather than in the Prisma schema.
 *
 * SQLite drops triggers together with the table they are attached to, so every
 * migration that redefines "Workspace" (Prisma's `RedefineTables` pattern, used
 * for any column drop) silently removes them. That has now happened twice, and
 * the only guard was a comment in an earlier migration. This test applies the
 * real migration chain and asserts the invariant still holds afterwards, so a
 * future table rebuild that forgets the triggers fails here instead of in
 * production.
 *
 * The violation cases go through raw SQL on purpose: Prisma reports a trigger
 * ABORT as a generic constraint failure, which a plain foreign key rejection
 * would also satisfy. The raw path surfaces `SQLITE_CONSTRAINT_TRIGGER` and the
 * trigger's own message, so these assertions can only pass if the triggers
 * themselves are present.
 */

import type { PrismaClient } from '@prisma-gen/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  prisma = db.prisma;

  await prisma.project.create({
    data: {
      id: 'depth-project',
      name: 'depth-project',
      slug: 'depth-project',
      repoPath: '/tmp/depth-project',
      worktreeBasePath: '/tmp/depth-project-worktrees',
    },
  });
  await prisma.workspace.create({
    data: { id: 'depth-root', name: 'depth-root', projectId: 'depth-project' },
  });
  await prisma.workspace.create({
    data: {
      id: 'depth-child',
      name: 'depth-child',
      projectId: 'depth-project',
      parentWorkspaceId: 'depth-root',
    },
  });
}, 30_000);

afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function insertWorkspace(id: string, parentWorkspaceId: string) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO "Workspace" (id, projectId, name, createdAt, updatedAt, parent_workspace_id)
     VALUES (?, 'depth-project', ?, datetime('now'), datetime('now'), ?)`,
    id,
    id,
    parentWorkspaceId
  );
}

describe('workspace depth-1 triggers survive the migration chain', () => {
  it('installs both depth triggers', async () => {
    const triggers = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name
    `;

    expect(triggers.map((trigger) => trigger.name)).toEqual([
      'enforce_workspace_depth_1',
      'enforce_workspace_depth_1_update',
    ]);
  });

  it('blocks inserting a grandchild', async () => {
    await expect(insertWorkspace('depth-grandchild', 'depth-child')).rejects.toThrow(
      /SQLITE_CONSTRAINT_TRIGGER[\s\S]*Child workspaces cannot have children \(max depth 1\)/
    );
  });

  it('blocks a workspace parenting itself', async () => {
    await expect(insertWorkspace('depth-self', 'depth-self')).rejects.toThrow(
      /SQLITE_CONSTRAINT_TRIGGER[\s\S]*A workspace cannot be its own parent/
    );
  });

  it('blocks re-parenting a workspace that already has children', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Workspace" SET parent_workspace_id = 'depth-child' WHERE id = 'depth-root'`
      )
    ).rejects.toThrow(/SQLITE_CONSTRAINT_TRIGGER/);
  });

  it('still allows a first-level child', async () => {
    await prisma.workspace.create({
      data: {
        id: 'depth-child-2',
        name: 'depth-child-2',
        projectId: 'depth-project',
        parentWorkspaceId: 'depth-root',
      },
    });

    const child = await prisma.workspace.findUniqueOrThrow({ where: { id: 'depth-child-2' } });
    expect(child.parentWorkspaceId).toBe('depth-root');
  });
});
