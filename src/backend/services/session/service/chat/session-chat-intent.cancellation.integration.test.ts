import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ChatIntentAccessor } from '@/backend/services/session/resources/chat-intent.accessor';
import { createDeferred } from '@/backend/services/session/service/acp/acp-runtime-manager.test-helpers';
import { setupAuthority } from '@/backend/services/session/service/lifecycle/session-config-authority.test-helpers';
import { SessionDomainService } from '@/backend/services/session/service/session-domain.service';
import {
  createIntegrationDatabase,
  clearIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { createQueueMessageHandler } from './chat-message-handlers/handlers/queue-message.handler';
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

it('retains an acknowledged intent when identical replay projection publication throws', async () => {
  const emit = vi.spyOn(domain, 'emitDelta');
  const handler = createQueueMessageHandler({
    domain,
    chatIntent: intents,
    backgroundDelivery: {
      captureResumeGuard: () => () => true,
      userResume: () => Promise.resolve(),
    },
    tryDispatchNextMessage: () => Promise.resolve(),
  });
  const frame = { type: 'queue_message' as const, id: 'acknowledged', text: 'keep this input' };
  const context = { sessionId: 's', workingDir: '/tmp' };
  await handler(context, frame);
  expect(emit).toHaveBeenCalledWith(
    's',
    expect.objectContaining({ id: frame.id, newState: 'ACCEPTED' })
  );
  const original = domain.getQueueSnapshot('s')[0];
  const enqueue = domain.enqueue.bind(domain);
  vi.spyOn(domain, 'enqueue').mockImplementationOnce((...args) => {
    enqueue(...args);
    throw new Error('retry snapshot failed');
  });
  const reject = vi.spyOn(domain, 'rejectMessage');
  await handler(context, frame);
  expect(reject).not.toHaveBeenCalled();
  expect((await intents.store.find('s', frame.id))?.status).toBe('queued');
  expect(domain.getQueueSnapshot('s')).toEqual([original]);
  domain.clearAllSessions();
  const restarted = new SessionChatIntentService(new ChatIntentAccessor(db.prisma), domain);
  await restarted.hydrate('s');
  expect(domain.getQueueSnapshot('s').map((item) => item.id)).toEqual([frame.id]);
});

it.each(['snapshot failure', 'runtime handoff'] as const)(
  'keeps durable desired settings unchanged after inactive %s',
  async (failure) => {
    const queued = { ...message('older'), settings: { ...settings, selectedModel: 'first' } };
    await intents.accept('s', queued);
    const h = setupAuthority(undefined, {
      override: (_id, at, patch) => intents.override('s', at, patch),
    });
    await h.service.persistAcpConfigSnapshot('session', {
      provider: 'CODEX',
      providerSessionId: 'thread',
      configOptions: h.handle.configOptions,
    });
    h.runtime.getClient.mockReturnValue(undefined);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    if (failure === 'snapshot failure') {
      h.hooks.cas = () => Promise.reject(new Error('snapshot unavailable'));
    } else {
      const persist = h.repository.updateSession.bind(h.repository);
      vi.spyOn(h.repository, 'updateSession').mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return persist(...args);
      });
      h.connection.setSessionConfigOption.mockRejectedValueOnce(
        new Error('provider rejected edit')
      );
    }
    const pending = h.service.setSessionModel('session', 'second', 'user');
    const rejected = expect(pending).rejects.toThrow(
      failure === 'snapshot failure' ? 'snapshot unavailable' : 'provider rejected edit'
    );
    if (failure === 'runtime handoff') {
      await entered.promise;
      h.runtime.getClient.mockReturnValue(h.handle);
      release.resolve();
    }
    await rejected;
    expect((await intents.store.find('s', queued.id))?.message.settings.selectedModel).toBe(
      'first'
    );
    expect(h.service.resolveQueuedMessageSettings('session', queued).selectedModel).toBe('first');
    h.hooks.cas = () => Promise.resolve();
    h.runtime.getClient.mockReturnValue(h.handle);
    await h.service.configureQueuedMessage('session', queued);
    expect(h.handle.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
      'first'
    );
  }
);
