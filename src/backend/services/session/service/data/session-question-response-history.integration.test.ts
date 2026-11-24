import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { sessionQuestionResponseAccessor } from '@/backend/services/session/resources/session-question-response.accessor';
import { createPermissionResponseHandler } from '@/backend/services/session/service/chat/chat-message-handlers/handlers/permission-response.handler';
import { createSessionLoadService } from '@/backend/services/session/service/composition/session-services';
import { SessionPermissionService } from '@/backend/services/session/service/events/session.permission.service';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import type { PrismaClient } from '@prisma-gen/client';
import {
  createSessionTranscriptHydrator,
  hydrateQuestionResponseHistory,
  persistQuestionResponse,
} from './session-question-response-history';

const database = vi.hoisted(() => ({ prisma: undefined as PrismaClient | undefined }));
vi.mock('@/backend/db', () => ({
  get prisma() {
    return database.prisma;
  },
}));

let db: IntegrationDatabase;

beforeAll(async () => {
  db = await createIntegrationDatabase();
  database.prisma = db.prisma;
  await db.prisma.project.create({
    data: {
      id: 'project',
      name: 'Project',
      slug: 'project',
      repoPath: '/tmp/p',
      worktreeBasePath: '/tmp/w',
    },
  });
  await db.prisma.workspace.create({
    data: {
      id: 'workspace',
      projectId: 'project',
      name: 'Workspace',
      status: 'READY',
      agentSessions: {
        create: {
          id: 'session',
          workflow: 'implement',
          provider: 'CODEX',
          providerSessionId: 'provider-1',
        },
      },
    },
  });
});

afterAll(async () => {
  await destroyIntegrationDatabase(db);
});

it('reopens a completed question from SQLite at its provider tool position', async () => {
  const live = new SessionDomainService();
  const restored = new SessionDomainService();
  const tool = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool', name: 'AskUserQuestion', input: {} },
    },
  } as const;
  live.appendClaudeEvent('session', tool);
  const recorded = live.upsertQuestionResponse('session', 0, {
    type: 'question_response',
    questionResponse: {
      toolUseId: 'tool',
      requestId: 'request',
      status: 'answered',
      questions: [{ question: 'What is the priority?', answers: ['Run tests'], note: 'API only' }],
    },
  });
  await persistQuestionResponse('session', 'provider-1', recorded);

  const nativeTool = restored.appendClaudeEvent('session', tool);
  restored.appendClaudeEvent('session', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'I will run tests.' }] },
  });
  restored.appendClaudeEvent('session', {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Done' }],
    },
  });

  await hydrateQuestionResponseHistory(restored, 'session', 'provider-1');
  await hydrateQuestionResponseHistory(restored, 'session', 'provider-1');
  expect(restored.getTranscriptSnapshot('session')).toMatchObject([
    {
      id: nativeTool.messageId,
      order: nativeTool.order,
      message: {
        type: 'question_response',
        questionResponse:
          recorded.message?.type === 'question_response' ? recorded.message.questionResponse : null,
        questionToolDetails: { result: 'Done' },
      },
    },
    { message: { type: 'assistant' } },
  ]);

  const withoutProviderHistory = new SessionDomainService();
  await hydrateQuestionResponseHistory(withoutProviderHistory, 'session', 'provider-1');
  expect(withoutProviderHistory.getTranscriptSnapshot('session')).toMatchObject([
    {
      message: {
        type: 'question_response',
        questionResponse: { toolUseId: 'tool', status: 'answered' },
      },
    },
  ]);
  const newlyConnected = new SessionDomainService();
  await hydrateQuestionResponseHistory(newlyConnected, 'session', 'provider-1');
  const newEvent = newlyConnected.appendClaudeEvent('session', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing the session.' }] },
  });
  expect(Number.isInteger(newEvent.order)).toBe(true);

  const passive = new SessionDomainService();
  passive.appendClaudeEvent('session', {
    type: 'assistant',
    timestamp: new Date(Date.parse(recorded.timestamp) + 1000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'Following the answer.' }] },
  });
  const load = createSessionLoadService({
    domain: passive,
    config: {
      getSessionConfigProjection: async () => ({
        currentProjection: () => ({ capabilities: EMPTY_CHAT_BAR_CAPABILITIES, configOptions: [] }),
      }),
    },
    hydrateLifecycleEvents: async () => undefined,
    getRuntimeSnapshot: (id) => passive.getRuntimeSnapshot(id),
    tryDispatchNextMessage: async () => undefined,
  });
  const prepared = await load.prepareLoad({ sessionId: 'session' });
  if (prepared.status !== 'ready') {
    throw new Error('Expected successful passive session load');
  }
  expect(
    load.captureReplay(prepared).replayEvents.filter((event) => event.type === 'agent_message')
  ).toMatchObject([
    { order: -0.5, data: { type: 'question_response', questionResponse: { toolUseId: 'tool' } } },
    { order: 0, data: { type: 'assistant' } },
  ]);

  const fallback = withoutProviderHistory.getTranscriptSnapshot('session');
  const provider = {
    id: 'provider-row',
    source: 'agent',
    order: 7,
    timestamp: recorded.timestamp,
    message: tool,
  } as const;
  withoutProviderHistory.replaceTranscript('session', [...fallback, provider]);
  await hydrateQuestionResponseHistory(withoutProviderHistory, 'session', 'provider-1');
  expect(withoutProviderHistory.getTranscriptSnapshot('session')).toMatchObject([
    {
      id: provider.id,
      order: provider.order,
      message: {
        type: 'question_response',
        questionResponse: { toolUseId: 'tool', status: 'answered' },
      },
    },
  ]);
});

it('keeps a rolled-over conversation separate when it reuses a tool ID', async () => {
  const old = new SessionDomainService();
  const oldRow = old.upsertQuestionResponse('session', 0, {
    type: 'question_response',
    questionResponse: { toolUseId: 'tool', status: 'answered', questions: [] },
  });
  await persistQuestionResponse('session', 'old-provider', oldRow);

  const next = new SessionDomainService();
  next.appendClaudeEvent('session', {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tool', name: 'AskUserQuestion', input: {} },
    },
  });
  await hydrateQuestionResponseHistory(next, 'session', 'provider-2');
  expect(next.getTranscriptSnapshot('session')).toMatchObject([
    { message: { type: 'stream_event' } },
  ]);
});

it('marks history hydrated without a provider ID even when the domain is already bound', async () => {
  const domain = new SessionDomainService();
  domain.createProviderHistoryFence('session', 'provider-1');
  await createSessionTranscriptHydrator(domain)('session', {
    provider: 'CODEX',
    providerSessionId: null,
    providerMetadata: null,
    workspace: { worktreePath: null },
  });
  expect(domain.isHistoryHydrated('session')).toBe(true);
  expect(domain.getHistoryHydrationSource('session')).toBe('none');
});

function showQuestion(toolUseId: string) {
  const domain = new SessionDomainService();
  const permissions = new SessionPermissionService({
    sessionDomainService: domain,
    getProviderSessionId: () => 'provider-1',
    persistQuestionResponse,
  });
  const bridge = permissions.createPermissionBridge('session');
  const params = {
    sessionId: 'provider-1',
    toolCall: {
      toolCallId: toolUseId,
      title: 'AskUserQuestion',
      rawInput: { questions: [{ id: 'choice', question: 'Which option?' }] },
    },
    options: [{ optionId: 'allow', kind: 'allow_once' as const, name: 'Answer' }],
  };
  const requestId = `request-${toolUseId}`;
  const providerResponse = bridge.waitForUserResponse(requestId, params);
  permissions.handlePermissionRequest('session', {
    type: 'acp_permission_request',
    requestId,
    params,
  });
  const handler = createPermissionResponseHandler({ sessionPermissionService: permissions });
  const answer = () =>
    handler(
      { sessionId: 'session', workingDir: '/tmp/w' },
      {
        type: 'permission_response',
        requestId,
        optionId: 'allow',
        answers: { choice: ['Option A'] },
      }
    );
  return { domain, providerResponse, answer };
}

it('waits for the accepted answer write before settling the command or reloading history', async () => {
  const release = Promise.withResolvers<void>();
  const writeStarted = Promise.withResolvers<void>();
  const upsert = sessionQuestionResponseAccessor.upsert;
  const write = vi
    .spyOn(sessionQuestionResponseAccessor, 'upsert')
    .mockImplementationOnce(async (...args) => {
      writeStarted.resolve();
      await release.promise;
      await upsert(...args);
    });
  const read = vi.spyOn(sessionQuestionResponseAccessor, 'findBySessionId');
  const { providerResponse, answer } = showQuestion('delayed-write');
  const restored = new SessionDomainService();
  let commandFinished = false;
  const command = Promise.resolve(answer()).then((outcome) => {
    commandFinished = true;
    return outcome;
  });
  const reopen = hydrateQuestionResponseHistory(restored, 'session', 'provider-1');
  try {
    await writeStarted.promise;
    await expect(providerResponse).resolves.toMatchObject({ outcome: { outcome: 'selected' } });
    expect(commandFinished).toBe(false);
    expect(read).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.all([command, reopen]);
    write.mockRestore();
    read.mockRestore();
  }
  await expect(command).resolves.toEqual({ replies: [] });
  expect(restored.getTranscriptSnapshot('session')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.objectContaining({
          type: 'question_response',
          questionResponse: expect.objectContaining({
            toolUseId: 'delayed-write',
            status: 'answered',
          }),
        }),
      }),
    ])
  );
});

it('keeps the provider-accepted answer when the durable write fails', async () => {
  const write = vi
    .spyOn(sessionQuestionResponseAccessor, 'upsert')
    .mockRejectedValueOnce(new Error('SQLite write failed'));
  try {
    const { domain, providerResponse, answer } = showQuestion('failed-write');
    expect(await answer()).toEqual({ replies: [] });
    await expect(providerResponse).resolves.toMatchObject({ outcome: { outcome: 'selected' } });
    expect(domain.getTranscriptSnapshot('session')).toMatchObject([
      { message: { questionResponse: { toolUseId: 'failed-write', status: 'answered' } } },
    ]);
    expect(await answer()).toEqual({
      replies: [{ type: 'error', error: { kind: 'permission_not_pending' } }],
    });
    expect(write).toHaveBeenCalledOnce();
  } finally {
    write.mockRestore();
  }
});
