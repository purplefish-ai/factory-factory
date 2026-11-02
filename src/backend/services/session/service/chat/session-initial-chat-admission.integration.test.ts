import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { enqueueAutoMessage } from '@/backend/orchestration/workspace-initial-chat-admission';
import { ChatIntentAccessor } from '@/backend/services/session/resources/chat-intent.accessor';
import { SessionChatIntentService } from '@/backend/services/session/service/chat/session-chat-intent.service';
import {
  SessionDomainService,
  sessionDomainService,
} from '@/backend/services/session/service/session-domain.service';
import {
  clearIntegrationDatabase,
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';

let db: IntegrationDatabase;
let owner: SessionChatIntentService;
let local: SessionDomainService;
beforeAll(async () => {
  db = await createIntegrationDatabase();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: { id: 'p', name: 'P', slug: 'p', repoPath: '/tmp', worktreeBasePath: '/tmp' },
  });
  await db.prisma.workspace.create({ data: { id: 'w', projectId: 'p', name: 'W' } });
  await db.prisma.agentSession.create({
    data: { id: 's', workspaceId: 'w', provider: 'CLAUDE', workflow: 'implement' },
  });
  local = new SessionDomainService();
  owner = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), local);
  local.chatIntent = owner;
  vi.spyOn(sessionDomainService, 'enqueueInitialMessageDurably').mockImplementation((...args) =>
    local.enqueueInitialMessageDurably(...args)
  );
  vi.spyOn(sessionDomainService, 'cancelInitialMessageDurably').mockImplementation((...args) =>
    local.cancelInitialMessageDurably(...args)
  );
  vi.spyOn(sessionDomainService, 'emitDelta').mockImplementation(() => undefined);
});

it('does not cancel the winning initial intent when another initializer submits conflicting content', async () => {
  const signal = new AbortController().signal;
  await enqueueAutoMessage('s', 'winning task', 'sonnet', undefined, signal);
  await expect(
    enqueueAutoMessage('s', 'conflicting task', 'sonnet', undefined, signal)
  ).rejects.toThrow('durably prepare');
  expect((await owner.store.find('s', 'auto-init-s'))?.status).toBe('queued');
  expect((await owner.store.find('s', 'auto-init-s'))?.message.text).toBe('winning task');
  expect(sessionDomainService.cancelInitialMessageDurably).not.toHaveBeenCalled();
});

it('does not cancel an identical earlier acceptance when a replay caller is already stale', async () => {
  const signal = new AbortController().signal;
  await enqueueAutoMessage('s', 'winning task', 'sonnet', undefined, signal);
  const stopped = new AbortController();
  stopped.abort();
  await expect(
    enqueueAutoMessage('s', 'winning task', 'sonnet', undefined, stopped.signal)
  ).rejects.toThrow('cancelled');
  expect((await owner.store.find('s', 'auto-init-s'))?.status).toBe('queued');
});

it('still cancels its own freshly accepted initial input if its caller stops after acceptance', async () => {
  const stopped = new AbortController();
  const enqueue = local.enqueueInitialMessageDurably.bind(local);
  vi.mocked(sessionDomainService.enqueueInitialMessageDurably).mockImplementationOnce(
    async (...args) => {
      const accepted = await enqueue(...args);
      stopped.abort();
      return accepted;
    }
  );
  await expect(
    enqueueAutoMessage('s', 'fresh task', 'sonnet', undefined, stopped.signal)
  ).rejects.toThrow('cancelled');
  expect((await owner.store.find('s', 'auto-init-s'))?.status).toBe('cancelled');
});
