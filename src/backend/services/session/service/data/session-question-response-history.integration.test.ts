import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { SessionDomainService } from '@/backend/services/session/service/store/session-domain.service';
import {
  createIntegrationDatabase,
  destroyIntegrationDatabase,
  type IntegrationDatabase,
} from '@/backend/testing/integration-db';
import type { PrismaClient } from '@prisma-gen/client';
import {
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
      agentSessions: { create: { id: 'session', workflow: 'implement', provider: 'CODEX' } },
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
