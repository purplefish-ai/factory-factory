import { expect, it } from 'vitest';
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
