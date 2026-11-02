import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ChatIntentAccessor } from '@/backend/services/session/resources/chat-intent.accessor';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  createIntegrationDatabase,
  clearIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { SessionChatIntentService } from './session-chat-intent.service';

let db: IntegrationDatabase;
let intents: SessionChatIntentService;
const domain = new SessionDomainService();
const settings = {
  selectedModel: 'sonnet',
  reasoningEffort: null,
  thinkingEnabled: false,
  planModeEnabled: false,
};
const message = (id: string): QueuedMessage => ({
  id,
  text: id,
  timestamp: new Date(0).toISOString(),
  settings: { ...settings },
});
beforeAll(async () => {
  db = await createIntegrationDatabase();
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  domain.clearAllSessions();
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: { id: 'p', name: 'Project', slug: 'p', worktreeBasePath: '/tmp', repoPath: '/tmp' },
  });
  await db.prisma.workspace.create({ data: { id: 'w', projectId: 'p', name: 'Workspace' } });
  await db.prisma.agentSession.create({
    data: { id: 's', workspaceId: 'w', workflow: 'implement', provider: 'CLAUDE' },
  });
  intents = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
});

it('settles an accepted intent when projection publication throws after inserting it', async () => {
  const enqueue = domain.enqueue.bind(domain);
  vi.spyOn(domain, 'enqueue').mockImplementationOnce((...args) => {
    enqueue(...args);
    throw new Error('snapshot publication failed');
  });
  await expect(intents.accept('s', message('publication-failed'))).rejects.toThrow(
    'snapshot publication failed'
  );
  expect((await intents.store.find('s', 'publication-failed'))?.status).toBe('cancelled');
  expect(domain.getQueueLength('s')).toBe(0);
  domain.clearAllSessions();
  await intents.hydrate('s');
  expect(domain.getQueueLength('s')).toBe(0);
});

it.each(['cancelled', 'failed'] as const)(
  'holds surviving input after failed %s persistence until cancellation can be reconciled',
  async (status) => {
    await intents.accept('s', message('stop-failed'));
    const cancel = vi
      .spyOn(intents.store, 'cancel')
      .mockRejectedValue(new Error('cancel database unavailable'));
    await expect(intents.cancel('s', undefined, status)).rejects.toThrow(
      'cancel database unavailable'
    );
    domain.clearAllSessions();
    await expect(intents.hydrate('s')).rejects.toThrow('cancel database unavailable');
    expect(domain.getQueueLength('s')).toBe(0);
    await expect(
      intents.claim('s', [message('stop-failed')], 'stop-failed', settings, 1)
    ).rejects.toThrow('cancel database unavailable');
    expect(await db.prisma.promptDispatchAttempt.count()).toBe(0);
    cancel.mockRestore();
    await intents.hydrate('s');
    expect((await intents.store.find('s', 'stop-failed'))?.status).toBe(status);
    expect(domain.getQueueLength('s')).toBe(0);
  }
);

it('cancels stale initial identity even after its runtime projection was evicted', async () => {
  const local = new SessionDomainService();
  const owner = new SessionChatIntentService(intents.store, local);
  local.chatIntent = owner;
  await owner.acceptInitial('s', message('evicted-initial'));
  local.clearAllSessions();
  await local.cancelInitialMessageDurably('s', 'evicted-initial');
  expect((await intents.store.find('s', 'evicted-initial'))?.status).toBe('cancelled');
  await owner.hydrate('s');
  expect(local.getQueueLength('s')).toBe(0);
});
