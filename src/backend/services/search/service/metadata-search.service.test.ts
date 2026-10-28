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
  it('uses complete legacy SQLite timestamps for recency before limiting', async () => {
    const { project } = await seed();
    const old = await db.prisma.workspace.create({
      data: { projectId: project.id, name: 'Old result' },
    });
    const recent = await db.prisma.workspace.create({
      data: { projectId: project.id, name: 'Recent result' },
    });
    await db.prisma
      .$executeRaw`UPDATE Workspace SET updatedAt = '2026-01-01 10:00:00' WHERE id = ${old.id}`;
    await db.prisma
      .$executeRaw`UPDATE Workspace SET updatedAt = '2026-10-28 10:00:00' WHERE id = ${recent.id}`;
    expect((await search.search({ query: 'result', limit: 1 })).map((r) => r.id)).toEqual([
      recent.id,
    ]);
  });

  it('filters Unicode in the database and bounds returned candidates before hydration', async () => {
    const { project } = await seed();
    await db.prisma.workspace.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({ projectId: project.id, name: `Цель ${i}` })),
    });
    const target = await db.prisma.workspace.create({
      data: { projectId: project.id, name: 'Цель' },
    });
    const { metadataSearchAccessor } = await vi.importActual<
      typeof import('@/backend/services/search/resources/metadata-search.accessor')
    >('@/backend/services/search/resources/metadata-search.accessor');
    const candidates = await metadataSearchAccessor.search({
      query: 'цель',
      includeArchived: false,
      limit: 1,
    });
    expect(candidates.map((r) => r.id)).toEqual([target.id]);
  });

  it('keeps snippet edges well formed when the window splits emoji', async () => {
    const { workspace } = await seed();
    await db.prisma.workspace.update({
      where: { id: workspace.id },
      data: { description: `😀${'a'.repeat(39)}needle${'b'.repeat(133)}😀tail` },
    });
    const [result] = await search.search({ query: 'needle' });
    expect(result?.matchSnippet).toBe(`…${'a'.repeat(39)}needle${'b'.repeat(133)}…`);
  });

  it('excludes issue and PR URL boilerplate and exposes the matched metadata snippet', async () => {
    const { workspace } = await seed();
    expect(await search.search({ query: 'github' })).toEqual([]);
    expect(await search.search({ query: 'pull' })).toEqual([]);
    expect(await search.search({ query: 'omnibox' })).toEqual([
      expect.objectContaining({
        id: workspace.id,
        matchSnippet: expect.stringContaining('Omnibox'),
      }),
    ]);
    expect(await search.search({ query: 'keyboard' })).toEqual([
      expect.objectContaining({
        id: workspace.id,
        matchSnippet: expect.stringContaining('Keyboard'),
      }),
    ]);
  });

  it('matches decomposed Unicode names and query terms', async () => {
    const { project } = await seed();
    const workspace = await db.prisma.workspace.create({
      data: { projectId: project.id, name: 'E\u0301clair' },
    });
    expect(await search.search({ query: 'éclair' })).toEqual([
      expect.objectContaining({ id: workspace.id }),
    ]);
    expect(await search.search({ query: 'e\u0301clair' })).toEqual([
      expect.objectContaining({ id: workspace.id }),
    ]);
  });
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
