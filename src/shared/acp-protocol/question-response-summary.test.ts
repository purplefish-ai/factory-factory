import { expect, it } from 'vitest';
import { hasSecretQuestion } from './question-input';
import { summarizeQuestionResponse } from './question-response-summary';

it('uses a submitted custom note as the answer to its parent question', () => {
  const custom = 'None of the above';
  const input = {
    questions: [
      { id: 'choice', question: 'Which processes?', options: [{ label: 'All processes' }] },
      {
        id: 'note',
        question: 'Additional note',
        companionNote: { questionId: 'choice', revealOnValue: custom },
      },
    ],
  };
  expect(
    summarizeQuestionResponse(input, { toolUseId: 'tool' }, 'answered', {
      choice: [custom],
      note: ['Only processes from active workspaces'],
    }).questions
  ).toEqual([
    {
      id: 'choice',
      question: 'Which processes?',
      answers: [],
      note: 'Only processes from active workspaces',
    },
  ]);
});

it('merges all submitted companion notes in question order', () => {
  const input = {
    questions: [
      { id: 'choice', question: 'Which processes?' },
      {
        id: 'first-note',
        question: 'First note',
        companionNote: { questionId: 'choice', revealOnValue: 'custom' },
      },
      {
        id: 'second-note',
        question: 'Second note',
        companionNote: { questionId: 'choice', revealOnValue: 'other' },
      },
      {
        id: 'empty-note',
        question: 'Empty note',
        companionNote: { questionId: 'choice', revealOnValue: 'manual' },
      },
    ],
  };
  expect(
    summarizeQuestionResponse(input, { toolUseId: 'tool' }, 'answered', {
      choice: ['custom', 'CPU', 'other', 'manual'],
      'second-note': ['Second'],
      'first-note': ['First line', 'Next line'],
    }).questions
  ).toEqual([
    {
      id: 'choice',
      question: 'Which processes?',
      answers: ['CPU', 'manual'],
      note: 'First line\nNext line\nSecond',
    },
  ]);
});

it.each([
  { isSecret: 'true' },
  { secret: null },
  { writeOnly: undefined },
  { format: false },
  { _meta: { codex: { isSecret: 1, role: false } } },
])('redacts an answer when a secret flag is malformed (%j)', (flags) => {
  expect(
    summarizeQuestionResponse(
      { questions: [{ id: 'token', question: 'Token', ...flags }] },
      { toolUseId: 'tool' },
      'answered',
      { token: ['private value'] }
    ).questions
  ).toEqual([{ id: 'token', question: 'Token', answers: [], redacted: true }]);
});

it('detects a private field independently of invalid question display data', () => {
  expect(
    hasSecretQuestion({
      questions: [
        { question: 'Public choice', options: false },
        { id: 'token', isSecret: true, _meta: 2 },
      ],
    })
  ).toBe(true);
});

it('allows public answers with explicit false flags and unrelated malformed metadata', () => {
  expect(
    hasSecretQuestion({
      questions: [
        { isSecret: false, secret: false, writeOnly: false, format: 'uri', _meta: { codex: 2 } },
        { _meta: { codex: { isSecret: false, role: 42 } } },
      ],
    })
  ).toBe(false);
});
