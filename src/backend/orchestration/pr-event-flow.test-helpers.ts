import { vi } from 'vitest';
import { createIntegrationDatabase } from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';

const state = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined, busy: false }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    if (!state.prisma) {
      throw new Error('Missing test database');
    }
    return state.prisma;
  },
}));
vi.mock('@/backend/services/session', () => ({
  acpRuntimeManager: { isSessionPromptInFlight: () => state.busy },
  sessionDomainService: { getPendingInteractiveRequest: () => null },
  sessionLifecycleService: {},
  sessionDataService: {
    findPRDedicatedSession: async ({
      workspaceId,
      prId,
    }: {
      workspaceId: string;
      prId: string;
    }) => {
      const bound = await state.prisma?.workspacePRDedicatedSession.findUnique({
        where: { prId },
        include: { session: { include: { workspace: true } } },
      });
      return bound?.session?.workspaceId === workspaceId ? bound.session : null;
    },
    findAgentSessionById: (id: string) =>
      state.prisma?.agentSession.findUnique({ where: { id }, include: { workspace: true } }),
  },
  sessionBackgroundDeliveryService: {
    enqueue: vi.fn(() => ({ queued: true })),
    invalidate: vi.fn(),
  },
  sessionDispatchService: { tryDispatchNextMessage: vi.fn(async () => undefined) },
  findPRDeliveryReceipt: vi.fn(),
}));

vi.mock('./pr-delivery-readiness', () => ({ recipientCanDispatch: vi.fn(async () => true) }));
vi.mock('@/backend/services/settings', () => ({
  userSettingsService: { get: vi.fn(async () => ({ ratchetReplyToPrComments: true })) },
}));

export function getPRFlowTestState() {
  return state;
}

export async function createPRFlowIntegrationDatabase() {
  const db = await createIntegrationDatabase();
  state.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/repo',
      worktreeBasePath: '/tmp/worktrees',
    },
  });
  return db;
}
