import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  createIntegrationDatabase,
  clearIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { QueuedMessage } from '@/shared/acp-protocol';
import { ChatIntentAccessor } from './chat-intent.accessor';

let db: IntegrationDatabase;
let store: ChatIntentAccessor;
const message = (id = 'human'): QueuedMessage => ({
  id,
  text: 'hello',
  timestamp: '2026-11-02T00:00:00Z',
  settings: {
    selectedModel: 'sonnet',
    reasoningEffort: null,
    thinkingEnabled: false,
    planModeEnabled: false,
  },
  attachments: [
    {
      id: 'a',
      name: 'note.txt',
      type: 'text/plain',
      contentType: 'text',
      size: 7,
      data: 'durable',
    },
  ],
});
beforeAll(async () => {
  db = await createIntegrationDatabase();
  store = new ChatIntentAccessor(db.prisma);
});
afterAll(async () => {
  await destroyIntegrationDatabase(db);
});
beforeEach(async () => {
  await clearIntegrationDatabase(db.prisma);
  await db.prisma.project.create({
    data: {
      id: 'p',
      name: 'Project',
      slug: 'project',
      worktreeBasePath: '/tmp/worktrees',
      repoPath: '/tmp/repo',
    },
  });
  await db.prisma.workspace.create({
    data: { id: 'w', projectId: 'p', name: 'Workspace', branchName: 'topic' },
  });
  await db.prisma.agentSession.create({
    data: { id: 's', workspaceId: 'w', workflow: 'implement', provider: 'CLAUDE' },
  });
});
it('concurrent identical acceptance records one immutable payload including attachment bytes, even at capacity on retry', async () => {
  const results = await Promise.all(
    Array.from({ length: 4 }, () => store.accept('s', message(), false))
  );
  expect(results.every((r) => r.status === 'queued')).toBe(true);
  expect(await db.prisma.chatIntent.count()).toBe(1);
  expect((await store.accept('s', message(), true)).status).toBe('queued');
  expect((await store.read('s'))[0]?.message.attachments?.[0]?.data).toBe('durable');
});
it('rejects conflicting concurrent IDs without overwriting the accepted payload', async () => {
  const results = await Promise.allSettled([
    store.accept('s', message(), false),
    store.accept('s', { ...message(), text: 'other' }, false),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const winner = results.find((r) => r.status === 'fulfilled');
  expect((await store.find('s', 'human'))?.message).toEqual(
    winner?.status === 'fulfilled' ? winner.value.message : undefined
  );
});
it('keeps later settings separate from the immutable submission across accessor restart', async () => {
  await store.accept('s', message(), false);
  await store.override('s', Date.parse('2026-11-03'), {
    selectedModel: 'opus',
    planModeEnabled: true,
  });
  store = new ChatIntentAccessor(db.prisma);
  const retry = await store.accept('s', message(), true);
  expect(retry.message.settings.selectedModel).toBe('opus');
  expect(retry.message.settings.planModeEnabled).toBe(true);
  expect((await db.prisma.chatIntent.findFirstOrThrow()).submitted).toEqual(message());
});
it('freezes a full mixed batch and atomically excludes all human members from replay before invocation', async () => {
  await store.accept('s', message('one'), false);
  await store.accept('s', message('two'), false);
  const messages = [
    message('one'),
    message('two'),
    {
      ...message('pr-event-background'),
      source: { type: 'pr_event', request: { workspaceId: 'w', prId: 'pr', bindingRevision: 1 } },
    } as const,
  ];
  const attempt = await store.claim(
    's',
    messages,
    'hello\n\nhello\n\nbackground',
    message().settings,
    7
  );
  expect(attempt).not.toBeNull();
  store = new ChatIntentAccessor(db.prisma);
  expect((await store.read('s')).map((r) => r.status)).toEqual(['uncertain', 'uncertain']);
  await expect(store.claim('s', messages, 'retry', message().settings, 8)).rejects.toThrow();
  const frozen = await db.prisma.promptDispatchAttempt.findUniqueOrThrow({
    where: { id: attempt! },
  });
  expect(frozen.members).toEqual(
    messages.map((message, index) => ({
      messageId: message.id,
      owner: index < 2 ? 'human' : 'external',
      ...(index < 2 ? { revision: 0 } : {}),
      message,
    }))
  );
  expect(frozen.sendGeneration).toBe(7);
  await store.settle(attempt!, 'committed');
  expect((await store.read('s')).map((r) => r.status)).toEqual(['committed', 'committed']);
});
it('cancels queued humans on stop, preserves unresolved attempts, and cascades explicit session deletion', async () => {
  await store.accept('s', message('one'), false);
  await store.accept('s', message('two'), false);
  await store.claim('s', [message('one')], 'hello', message().settings, 1);
  await store.cancel('s');
  expect((await store.read('s')).map((r) => r.status)).toEqual(['uncertain', 'cancelled']);
  await db.prisma.agentSession.delete({ where: { id: 's' } });
  expect(await db.prisma.chatIntent.count()).toBe(0);
  expect(await db.prisma.promptDispatchAttempt.count()).toBe(0);
});
it('resolves a whole human attempt only for its session, without making any member replayable', async () => {
  await store.accept('s', message('one'), false);
  await store.accept('s', message('two'), false);
  const id = await store.claim(
    's',
    [message('one'), message('two')],
    'one\n\ntwo',
    message().settings,
    1
  );
  await expect(store.resolve('other', id!, 'cancelled')).rejects.toThrow();
  await store.resolve('s', id!, 'cancelled');
  expect((await store.read('s')).map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
  expect(await store.hasUncertainAttempt('s')).toBe(false);
});

it('rejects cross-session attempt references in the database while preserving explicit session deletion', async () => {
  await db.prisma.agentSession.create({
    data: { id: 'other', workspaceId: 'w', workflow: 'implement', provider: 'CLAUDE' },
  });
  await store.accept('s', message('one'), false);
  await store.accept('other', message('two'), false);
  const otherAttempt = await store.claim('other', [message('two')], 'two', message().settings, 1);
  await expect(
    db.prisma.chatIntent.update({
      where: { sessionId_messageId: { sessionId: 's', messageId: 'one' } },
      data: { attemptId: otherAttempt },
    })
  ).rejects.toThrow();
  await db.prisma.agentSession.delete({ where: { id: 'other' } });
  expect(await store.find('s', 'one')).toBeDefined();
});
