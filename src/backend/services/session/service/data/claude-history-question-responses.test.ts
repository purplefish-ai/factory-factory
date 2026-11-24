import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@/backend/services/config.service';
import { buildTranscriptFromHistory } from '@/backend/services/session/service/store/session-transcript';
import { claudeSessionHistoryLoaderService } from './session-history-loader.service';

function writeQuestionHistory(params: {
  directory: string;
  providerSessionId: string;
  entries: Record<string, unknown>[];
}) {
  const project = join(params.directory, 'projects', '-work');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `${params.providerSessionId}.jsonl`),
    params.entries.map((entry) => JSON.stringify(entry)).join('\n'),
    'utf-8'
  );
}

describe('Claude question response history', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ff-claude-question-history-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    configService.reload();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    configService.reload();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('restores structured Claude answers at the tool call without guessing from prose', async () => {
    const question = 'What should the resource details show?';
    const options = [{ label: 'Top processes, whole machine (Recommended)', description: '' }];
    const questions = [{ question, header: 'Why view', options }];
    writeQuestionHistory({
      directory: tempDir,
      providerSessionId: 'answered-question',
      entries: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'AskUserQuestion', id: 'q-1', input: { questions } },
              { type: 'text', text: 'An unrelated message' },
              { type: 'tool_use', name: 'AskUserQuestion', id: 'q-1', input: { questions } },
              { type: 'tool_use', name: 'AskUserQuestion', id: 'q-2', input: { questions } },
              { type: 'tool_use', name: 'AskUserQuestion', id: 'q-3', input: { questions } },
            ],
          },
        },
        {
          type: 'user',
          toolUseResult: { questions, answers: { [question]: options[0]!.label } },
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'q-1', content: 'Initial answer' }],
          },
        },
        {
          type: 'user',
          toolUseResult: {
            questions,
            answers: { [question]: options[0]!.label },
            annotations: {
              [question]: { notes: 'Include information for the current workspace.' },
            },
          },
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'q-1', content: 'Answer summary' }],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'q-2', content: 'User selected something' },
              {
                type: 'tool_result',
                tool_use_id: 'q-3',
                content: [
                  { type: 'text', text: "The user doesn't want to proceed with this tool use." },
                  { type: 'text', text: 'The tool use was rejected.' },
                ],
                is_error: true,
              },
              {
                type: 'tool_result',
                tool_use_id: 'q-3',
                content: 'Result repeated',
                is_error: true,
              },
            ],
          },
        },
      ],
    });
    const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: 'answered-question',
      workingDir: '/work',
    });

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      return;
    }
    const rows = buildTranscriptFromHistory(result.history);
    expect(rows.map((row) => row.message?.type)).toEqual([
      'question_response',
      'assistant',
      'question_response',
      'question_response',
    ]);
    expect(rows[0]?.message).toMatchObject({
      questionResponse: {
        toolUseId: 'q-1',
        status: 'answered',
        questions: [
          {
            question,
            header: 'Why view',
            answers: [options[0]!.label],
            note: 'Include information for the current workspace.',
          },
        ],
      },
      questionToolDetails: { result: 'Answer summary' },
    });
    expect(rows[2]?.message).toMatchObject({
      questionResponse: {
        toolUseId: 'q-2',
        status: 'answered',
        questions: [{ question, answers: [] }],
      },
    });
    expect(rows[3]?.message).toMatchObject({
      questionResponse: { toolUseId: 'q-3', status: 'cancelled' },
    });
  });

  it('keeps malformed question tools visible and hides private Claude results', async () => {
    const question = 'Enter private input';
    const questions = [{ question, options: [], writeOnly: true }];
    const secret = 'fake-private-answer';
    writeQuestionHistory({
      directory: tempDir,
      providerSessionId: 'private-question',
      entries: [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                id: 'malformed',
                input: { questions: [{ header: 'Missing label' }] },
              },
              { type: 'tool_use', name: 'AskUserQuestion', id: 'private', input: { questions } },
              {
                type: 'tool_use',
                name: 'AskUserQuestion',
                id: 'malformed-private',
                input: { questions: [{ writeOnly: true }] },
              },
            ],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'malformed', content: 'Original result' },
            ],
          },
        },
        {
          type: 'user',
          toolUseResult: {
            questions,
            answers: { [question]: secret },
            annotations: { [question]: { notes: secret } },
          },
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'private', content: secret }],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'malformed-private', content: secret }],
          },
        },
      ],
    });

    const result = await claudeSessionHistoryLoaderService.loadSessionHistory({
      providerSessionId: 'private-question',
      workingDir: '/work',
    });

    expect(result.status).toBe('loaded');
    if (result.status !== 'loaded') {
      return;
    }
    expect(result.history).toMatchObject([
      { type: 'tool_use', toolId: 'malformed' },
      {
        type: 'question_response',
        questionResponse: {
          toolUseId: 'private',
          status: 'answered',
          questions: [{ question, redacted: true, answers: [] }],
        },
      },
      {
        type: 'question_response',
        questionResponse: {
          toolUseId: 'malformed-private',
          status: 'unavailable',
          questions: [],
        },
      },
      { type: 'tool_result', toolId: 'malformed', content: 'Original result' },
    ]);
    expect(JSON.stringify(result.history)).not.toContain(secret);
  });
});
