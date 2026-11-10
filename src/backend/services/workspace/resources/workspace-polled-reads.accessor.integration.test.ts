import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';
import { projectAccessor } from './project.accessor';
import { workspacePrDiscoveryAccessor } from './workspace-pr-discovery.accessor';
import { workspacePrMonitoringAccessor } from './workspace-pr-monitoring.accessor';
import { workspacePrAccessor } from './workspace-pr.accessor';
import { workspaceAccessor } from './workspace.accessor';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));

// Periodic and polled reads must not load these: a large base64 attachment, a
// long startup log, a provider config snapshot and a PR observation.
const creationMetadata = {
  initialPrompt: 'Describe this screenshot',
  initialAttachments: [
    { id: 'a', name: 'shot.png', type: 'image/png', size: 1, data: 'A'.repeat(2 * 1024 * 1024) },
  ],
};
const blobs = { initOutput: 'installing...\n'.repeat(3000), creationMetadata };
const providerMetadata = { configSnapshot: { blob: 'x'.repeat(64 * 1024) } };
const observation = { reviews: [{ body: 'r'.repeat(64 * 1024) }] };
const SMALL = 16 * 1024;

let db: IntegrationDatabase;
beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'p',
      name: 'P',
      slug: 'p',
      repoPath: '/tmp/p',
      worktreeBasePath: '/tmp/w',
      githubOwner: 'o',
      githubRepo: 'r',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'parent',
      projectId: 'p',
      name: 'Parent',
      status: 'READY',
      branchName: 'feature/parent',
      ...blobs,
      prMonitoring: { create: { enabled: true } },
      prDiscovery: { create: {} },
      prs: {
        create: { id: 'pr', url: 'https://github.com/o/r/pull/1', state: 'OPEN', observation },
      },
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'child',
      projectId: 'p',
      parentWorkspaceId: 'parent',
      name: 'Child',
      status: 'READY',
      ...blobs,
      agentSessions: {
        create: { id: 's', workflow: 'implement', provider: 'CLAUDE', providerMetadata },
      },
    },
  });
}, 30_000);
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('serves the project row without its newest workspaces', async () => {
  for (const project of [
    await projectAccessor.findById('p'),
    await projectAccessor.findBySlug('p'),
  ]) {
    expect(project).toMatchObject({ id: 'p', slug: 'p' });
    expect(project).not.toHaveProperty('workspaces');
  }
});

it('reads child workspaces for the status panel without blob columns', async () => {
  const [child, ...rest] = await workspaceAccessor.findChildrenWithStatus('parent');

  expect(rest).toEqual([]);
  expect(child).toMatchObject({ id: 'child', project: { slug: 'p' } });
  expect(child?.agentSessions).toEqual([expect.objectContaining({ id: 's' })]);
  expect(child).not.toHaveProperty('creationMetadata');
  expect(child).not.toHaveProperty('initOutput');
  expect(child?.agentSessions[0]).not.toHaveProperty('providerMetadata');
  expect(JSON.stringify(child).length).toBeLessThan(SMALL);
});

it('lists enabled monitoring with PR presence flags instead of workspace rows and observations', async () => {
  const [config, ...rest] = await workspacePrMonitoringAccessor.listEnabled();

  expect(rest).toEqual([]);
  expect(config).toMatchObject({ workspaceId: 'parent', enabled: true });
  expect(Object.keys(config?.workspace ?? {})).toEqual(['prs']);
  expect(config?.workspace.prs).toEqual([
    expect.objectContaining({ id: 'pr', hasObservation: true }),
  ]);
  expect(config?.workspace.prs[0]).not.toHaveProperty('observation');
  expect(JSON.stringify(config).length).toBeLessThan(SMALL);
});

it('returns stale PR sync candidates as identifiers only', async () => {
  await expect(workspacePrAccessor.findNeedingSync()).resolves.toEqual([
    { id: 'parent', prId: 'pr', prUrl: 'https://github.com/o/r/pull/1' },
  ]);
});

it('reads PR discovery candidates without blob columns', async () => {
  const [candidate, ...rest] = await workspacePrDiscoveryAccessor.findNeedingDiscovery(
    10,
    new Date()
  );

  expect(rest).toEqual([]);
  expect(candidate).toMatchObject({
    id: 'parent',
    branchName: 'feature/parent',
    project: { githubOwner: 'o', githubRepo: 'r' },
    prDiscoveryRetryCount: 0,
    prDiscoveryNextCheckAt: null,
  });
  expect(candidate).not.toHaveProperty('creationMetadata');
  expect(candidate).not.toHaveProperty('initOutput');
  expect(JSON.stringify(candidate).length).toBeLessThan(SMALL);
});
