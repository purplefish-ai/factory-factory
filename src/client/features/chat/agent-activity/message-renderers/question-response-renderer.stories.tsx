import type { Meta, StoryObj } from '@storybook/react';
import { expect, userEvent, within } from 'storybook/test';
import { QuestionResponseRenderer } from './question-response-renderer';

const meta = {
  title: 'Chat/Transcript/QuestionResponseRenderer',
  component: QuestionResponseRenderer,
  parameters: { layout: 'padded' },
  args: {
    message: {
      type: 'question_response',
      questionResponse: {
        toolUseId: 'ask-resource-view',
        status: 'answered',
        questions: [
          {
            header: 'Why view',
            question: 'What should the resource details show?',
            answers: ['Top processes, whole machine (Recommended)'],
            note: 'Include the workspace name when available.',
          },
          {
            question: 'Which metrics should the list include?',
            answers: ['CPU usage', 'Memory usage'],
          },
        ],
      },
      questionToolDetails: {
        toolName: 'AskUserQuestion',
        result: 'The user selected CPU usage and memory usage.',
      },
    },
  },
} satisfies Meta<typeof QuestionResponseRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Answered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('region', { name: 'Answered' })).toBeVisible();
    await expect(canvas.getByText('Include the workspace name when available.')).toBeVisible();
    await expect(canvas.getAllByRole('listitem')).toHaveLength(2);
    const detail = canvas.getByText('Raw tool details');
    await expect(detail.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(detail);
    await expect(detail.closest('details')).toHaveAttribute('open');
  },
};

export const UnavailableOutcome: Story = {
  args: {
    message: {
      type: 'question_response',
      questionResponse: {
        toolUseId: 'ask-resource-view',
        status: 'unavailable',
        questions: [{ question: 'What should the resource details show?', answers: [] }],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole('region', {
      name: 'Question outcome unavailable',
    });
    await expect(region).toBeVisible();
    await expect(within(region).getByText('What should the resource details show?')).toBeVisible();
  },
};

export const Cancelled: Story = {
  args: {
    message: {
      type: 'question_response',
      questionResponse: {
        toolUseId: 'ask-resource-view',
        status: 'cancelled',
        questions: [{ question: 'What should the resource details show?', answers: [] }],
      },
    },
  },
};

export const AnsweredOnPhone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
};

export const AsyncAnswerWithPreview: Story = {
  args: {
    message: {
      type: 'question_response',
      questionResponse: {
        toolUseId: 'preview-review',
        status: 'answered',
        questions: [
          {
            question: 'Does the [preview](https://example.com/preview) look ready?',
            answers: ['Approve the wording'],
          },
        ],
      },
      questionToolDetails: { toolName: 'request_user_input_async', result: '{"accepted":true}' },
    },
  },
  play: async ({ canvasElement }) => {
    const region = within(canvasElement).getByRole('region', { name: 'Answered' });
    await expect(within(region).getByRole('link', { name: 'preview' })).toBeVisible();
    await expect(within(region).getByText('Approve the wording')).toBeVisible();
    await expect(within(region).queryByText('Raw tool details')).not.toBeInTheDocument();
  },
};

export const PrivateAnswer: Story = {
  args: {
    message: {
      type: 'question_response',
      questionResponse: {
        toolUseId: 'ask-access-token',
        status: 'answered',
        questions: [{ question: 'What is the access token?', answers: [], redacted: true }],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Private answer hidden')).toBeVisible();
    await expect(canvas.queryByText('Raw tool details')).not.toBeInTheDocument();
  },
};
