import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { IssueProvider, WorkspaceStatus } from '@/shared/core/enums';

let db: IntegrationDatabase;
let projectAccessor: typeof import('@/backend/services/workspace/resources/project.accessor').projectAccessor;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ projectAccessor } = await vi.importActual<
    typeof import('@/backend/services/workspace/resources/project.accessor')
  >('@/backend/services/workspace/resources/project.accessor'));
}, 30_000);
afterEach(async () => {
  await clearIntegrationDatabase(db.prisma);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

function createProject(slug = 'demo') {
  return projectAccessor.create(
    {
      repoPath: `/repos/${slug}`,
      defaultBranch: 'release',
      githubOwner: 'org',
      githubRepo: slug,
      startupScriptCommand: 'pnpm dev',
      startupScriptPath: null,
      startupScriptTimeout: 120,
    },
    () => ({ name: `Project ${slug}`, slug, worktreeBasePath: `/worktrees/${slug}` })
  );
}

describe('project persistence contracts', () => {
  it('reads the same persisted project by id and slug with only its ten newest workspaces', async () => {
    const project = await createProject();
    const other = await createProject('other');
    await db.prisma.workspace.createMany({
      data: Array.from({ length: 12 }, (_, index) => ({
        projectId: project.id,
        name: `workspace-${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
      })),
    });
    await db.prisma.workspace.create({ data: { projectId: other.id, name: 'foreign workspace' } });

    const byId = await projectAccessor.findById(project.id);
    const bySlug = await projectAccessor.findBySlug(project.slug);
    expect(byId).toEqual(bySlug);
    expect(byId).toMatchObject({
      id: project.id,
      name: 'Project demo',
      slug: 'demo',
      repoPath: '/repos/demo',
      worktreeBasePath: '/worktrees/demo',
      defaultBranch: 'release',
      githubOwner: 'org',
      githubRepo: 'demo',
      startupScriptCommand: 'pnpm dev',
      startupScriptPath: null,
      startupScriptTimeout: 120,
    });
    expect(byId?.workspaces.map((workspace) => workspace.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `workspace-${11 - index}`)
    );
    await expect(projectAccessor.findById('missing')).resolves.toBeNull();
    await expect(projectAccessor.findBySlug('missing')).resolves.toBeNull();
  });

  it('lists projects by latest update, filters archive state, paginates, and counts live workspaces', async () => {
    const oldest = await createProject('oldest');
    const archived = await createProject('archived');
    const newest = await createProject('newest');
    await projectAccessor.archive(archived.id);
    for (const [index, project] of [oldest, archived, newest].entries()) {
      await db.prisma.project.update({
        where: { id: project.id },
        data: { updatedAt: new Date(Date.UTC(2026, 0, index + 1)) },
      });
    }
    await db.prisma.workspace.createMany({
      data: [
        WorkspaceStatus.NEW,
        WorkspaceStatus.READY,
        WorkspaceStatus.ARCHIVING,
        WorkspaceStatus.ARCHIVED,
      ].map((status, index) => ({ projectId: newest.id, name: `workspace-${index}`, status })),
    });

    const all = await projectAccessor.list();
    expect(all.map((project) => project.id)).toEqual([newest.id, archived.id, oldest.id]);
    expect(all.map((project) => project._count.workspaces)).toEqual([2, 0, 0]);
    expect(
      (await projectAccessor.list({ isArchived: false })).map((project) => project.id)
    ).toEqual([newest.id, oldest.id]);
    expect((await projectAccessor.list({ isArchived: true })).map((project) => project.id)).toEqual(
      [archived.id]
    );
    expect(
      (await projectAccessor.list({ limit: 1, offset: 1 })).map((project) => project.id)
    ).toEqual([archived.id]);
    expect(
      (await projectAccessor.list({ isArchived: false, limit: 1, offset: 1 })).map(
        (project) => project.id
      )
    ).toEqual([oldest.id]);
    await expect(projectAccessor.list({ offset: 3 })).resolves.toEqual([]);
  });

  it('updates project configuration while preserving omitted values and clearing nullable values', async () => {
    const project = await createProject();
    const issueTrackerConfig = {
      linear: {
        apiKey: 'encrypted-test-key',
        teamId: 'team-1',
        teamName: 'Platform',
        viewerName: 'Fixture user',
      },
    };
    const configured = await projectAccessor.update(project.id, {
      name: 'Renamed project',
      repoPath: '/repos/moved',
      defaultBranch: 'develop',
      githubOwner: 'new-org',
      githubRepo: 'renamed',
      startupScriptCommand: null,
      startupScriptPath: 'scripts/start.sh',
      startupScriptTimeout: 45,
      issueProvider: IssueProvider.LINEAR,
      issueTrackerConfig,
    });
    expect(configured).toMatchObject({
      name: 'Renamed project',
      repoPath: '/repos/moved',
      defaultBranch: 'develop',
      githubOwner: 'new-org',
      githubRepo: 'renamed',
      startupScriptCommand: null,
      startupScriptPath: 'scripts/start.sh',
      startupScriptTimeout: 45,
      issueProvider: IssueProvider.LINEAR,
      issueTrackerConfig,
    });
    await projectAccessor.update(project.id, { name: 'Only the name changes' });
    const retained = await projectAccessor.findById(project.id);
    expect(retained).toMatchObject({
      name: 'Only the name changes',
      issueTrackerConfig,
      startupScriptPath: 'scripts/start.sh',
      startupScriptTimeout: 45,
      slug: project.slug,
      worktreeBasePath: project.worktreeBasePath,
    });
    await projectAccessor.update(project.id, { issueTrackerConfig: null, startupScriptPath: null });
    expect(await projectAccessor.findById(project.id)).toMatchObject({
      issueTrackerConfig: null,
      startupScriptCommand: null,
      startupScriptPath: null,
      startupScriptTimeout: 45,
    });
    await expect(projectAccessor.update('missing', { name: 'No project' })).rejects.toMatchObject({
      code: 'P2025',
    });
  });

  it('archives only the requested project and retains it for lookup and archived lists', async () => {
    const project = await createProject();
    const other = await createProject('other');
    const archived = await projectAccessor.archive(project.id);
    expect(archived).toMatchObject({
      id: project.id,
      isArchived: true,
      slug: project.slug,
      repoPath: project.repoPath,
      worktreeBasePath: project.worktreeBasePath,
    });
    expect(await projectAccessor.findBySlug(project.slug)).toMatchObject({
      id: project.id,
      isArchived: true,
    });
    expect(await projectAccessor.findById(other.id)).toMatchObject({ isArchived: false });
    expect((await projectAccessor.list({ isArchived: true })).map((project) => project.id)).toEqual(
      [project.id]
    );
    await expect(projectAccessor.archive('missing')).rejects.toMatchObject({ code: 'P2025' });
  });
});
