import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let search: typeof import('@/backend/services/search/service/metadata-search.service').metadataSearchService;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  ({ metadataSearchService: search } = await vi.importActual<
    typeof import('@/backend/services/search/service/metadata-search.service')
  >('@/backend/services/search/service/metadata-search.service'));
}, 30_000);
afterEach(async () => clearIntegrationDatabase(db.prisma));
afterAll(async () => destroyIntegrationDatabase(db));

async function seed() {
  const project = await db.prisma.project.create({
    data: {
      name: 'Factory',
      slug: 'factory',
      repoPath: '/repos/factory',
      worktreeBasePath: '/worktrees',
    },
  });
  const workspace = await db.prisma.workspace.create({
    data: {
      projectId: project.id,
      name: 'Search polish',
      description: 'Keyboard navigation',
      branchName: 'feature/global-search',
      githubIssueNumber: 123,
      linearIssueIdentifier: 'ENG-456',
      status: 'READY',
    },
  });
  const session = await db.prisma.agentSession.create({
    data: {
      workspaceId: workspace.id,
      name: 'Accessibility review',
      provider: 'CODEX',
      workflow: 'review',
    },
  });
  await db.prisma.workspacePR.create({
    data: {
      workspaceId: workspace.id,
      url: 'https://github.com/org/repo/pull/789',
      number: 789,
      title: 'Omnibox support',
    },
  });
  return { project, workspace, session };
}

describe('metadata search', () => {
  it.each(['Éclair', 'ПРОЕКТ', 'ΑΘΗΝΑ'])(
    'matches Unicode names case-insensitively and ranks exact names first: %s',
    async (name) => {
      const { project } = await seed();
      await db.prisma.workspace.createMany({
        data: [
          { projectId: project.id, name: `${name} extra` },
          { projectId: project.id, name },
        ],
      });
      expect((await search.search({ query: name.toLowerCase() })).map((r) => r.title)).toEqual([
        name,
        `${name} extra`,
      ]);
    }
  );
  it('finds projects and named conversations with precise navigation identities', async () => {
    const { project, workspace, session } = await seed();
    expect(await search.search({ query: 'factory' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'project', id: project.id, projectSlug: 'factory' }),
      ])
    );
    expect(await search.search({ query: 'ACCESSIBILITY' })).toEqual([
      expect.objectContaining({
        kind: 'session',
        id: session.id,
        workspaceId: workspace.id,
        sessionId: session.id,
      }),
    ]);
  });

  it.each(['keyboard', 'global-search', '#123', 'ENG-456', 'omnibox', '#789'])(
    'matches workspace metadata: %s',
    async (query) => {
      const { workspace } = await seed();
      expect(await search.search({ query })).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'workspace', id: workspace.id })])
      );
    }
  );

  it('matches all words across fields and normalizes whitespace', async () => {
    const { workspace } = await seed();
    expect(await search.search({ query: '  search   keyboard  ' })).toEqual([
      expect.objectContaining({ kind: 'workspace', id: workspace.id }),
    ]);
    expect(await search.search({ query: 'search nonexistent' })).toEqual([]);
  });

  it('ranks exact names before newer partial or metadata matches', async () => {
    const { project } = await seed();
    for (const [index, name] of ['target', 'target extra', 'Other'].entries()) {
      await db.prisma.workspace.create({
        data: {
          projectId: project.id,
          name,
          description: 'target',
          updatedAt: new Date(2026, 0, index + 1),
        },
      });
    }
    expect((await search.search({ query: 'target' })).map((r) => r.title)).toEqual([
      'target',
      'target extra',
      'Other',
    ]);
  });

  it('hides archived workspaces and projects unless explicitly included', async () => {
    const { project, workspace } = await seed();
    await db.prisma.workspace.update({ where: { id: workspace.id }, data: { status: 'ARCHIVED' } });
    expect(await search.search({ query: 'search' })).toEqual([]);
    expect(await search.search({ query: 'accessibility' })).toEqual([]);
    expect(await search.search({ query: 'search', includeArchived: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: workspace.id, archived: true })])
    );
    await db.prisma.project.update({ where: { id: project.id }, data: { isArchived: true } });
    expect(await search.search({ query: '' })).toEqual([]);
    expect(await search.search({ query: 'factory', includeArchived: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: project.id, archived: true })])
    );
  });

  it('treats wildcard and SQL characters literally', async () => {
    await seed();
    for (const query of ['%', '_', "' OR 1=1 --", '"', '*']) {
      expect(await search.search({ query })).toEqual([]);
    }
  });

  it('returns recent results for empty input, with stable limits', async () => {
    const { project } = await seed();
    await db.prisma.workspace.create({
      data: {
        projectId: project.id,
        name: 'Most recent',
        updatedAt: new Date(2099, 0, 1),
      },
    });
    expect(await search.search({ query: ' ', limit: 1 })).toEqual([
      expect.objectContaining({ title: 'Most recent' }),
    ]);
  });
});
