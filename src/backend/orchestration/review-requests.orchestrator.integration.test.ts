import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { ReviewRequestedPR } from '@/backend/services/github';
import { workspaceQueryService } from '@/backend/services/workspace';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { prReviewRouter } from '@/backend/trpc/pr-review.trpc';
import type { PrismaClient } from '@prisma-gen/client';
import { listVisibleReviewRequests } from './review-requests.orchestrator';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!database.prisma) {
      throw new Error('Missing database');
    }
    return database.prisma;
  },
}));

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  await db.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp/p', worktreeBasePath: '/tmp/w' },
  });
  for (const [id, status, numbers] of [
    ['archived', 'ARCHIVED', [1, 2, 4]],
    ['archiving', 'ARCHIVING', [3]],
    ['live', 'READY', [4, 5]],
  ] as const) {
    await db.prisma.workspace.create({
      data: {
        id,
        projectId: 'p',
        name: id,
        status,
        prs: {
          create: numbers.map((number) => ({ url: `https://github.com/o/r/pull/${number}` })),
        },
      },
    });
  }
  await db.prisma.workspacePR.create({
    data: {
      workspaceId: 'archived',
      url: 'https://github.com/o/r/pull/7',
      detachedAt: new Date(),
    },
  });
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('excludes all PRs attached only to archived or archiving workspaces from Reviews', async () => {
  const prs: ReviewRequestedPR[] = [1, 2, 3, 4, 5, 6, 7].map((number) => ({
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `PR ${number}`,
    repository: { nameWithOwner: 'o/r' },
    author: { login: 'author' },
    createdAt: '2026-01-01T00:00:00Z',
    isDraft: false,
    reviewDecision: number === 5 ? 'APPROVED' : 'REVIEW_REQUIRED',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
  }));
  prs.push({ ...prs[0]!, url: 'https://github.com/other/repo/pull/1' });
  const services = {
    githubCLIService: {
      checkHealth: async () => ({ isInstalled: true, isAuthenticated: true }),
      listReviewRequests: async () => prs,
    },
    workspaceQueryService,
  };
  const caller = prReviewRouter.createCaller({
    appContext: {
      services: {
        ...services,
        listVisibleReviewRequests: () => listVisibleReviewRequests(services),
      },
    },
  } as never);

  const result = await caller.listReviewRequests();
  expect(result.error).toBeNull();
  expect(result.prs.map((pr) => pr.url)).toEqual([
    'https://github.com/o/r/pull/4',
    'https://github.com/o/r/pull/5',
    'https://github.com/o/r/pull/6',
    'https://github.com/o/r/pull/7',
    'https://github.com/other/repo/pull/1',
  ]);

  workspaceQueryService.configure({
    github: {
      checkHealth: services.githubCLIService.checkHealth,
      listReviewRequests: () => listVisibleReviewRequests(services),
    },
    session: { getAllPendingRequests: () => new Map(), getRuntimeSnapshot: vi.fn() },
    prSnapshot: { refreshWorkspace: async () => ({ success: true }) },
  });
  expect(await workspaceQueryService.refreshReviewCount()).toBe(4);

  await db.prisma.workspace.update({ where: { id: 'archived' }, data: { status: 'READY' } });
  expect((await caller.listReviewRequests()).prs.map((pr) => pr.url)).toContain(
    'https://github.com/o/r/pull/1'
  );
  expect(await workspaceQueryService.refreshReviewCount()).toBe(6);
});
