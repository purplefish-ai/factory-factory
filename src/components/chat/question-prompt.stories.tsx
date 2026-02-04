import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { createUserQuestion } from '@/lib/claude-fixtures';

import { QuestionPrompt } from './question-prompt';

const meta = {
  title: 'Chat/QuestionPrompt',
  component: QuestionPrompt,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Use the option list to answer quickly, or type a custom response in the main chat input and send it.',
      },
    },
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-2xl border rounded-lg overflow-hidden">
        <div className="p-4 bg-background min-h-[100px]">
          <p className="text-sm text-muted-foreground">Chat messages would appear above...</p>
        </div>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    question: {
      control: 'object',
      description: 'The user question request to display, or null to hide the prompt',
    },
    onAnswer: {
      action: 'onAnswer',
      description: 'Callback when user submits their answers',
    },
  },
  args: {
    onAnswer: fn(),
  },
} satisfies Meta<typeof QuestionPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleQuestion: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'What type of component would you like to create?',
        options: [
          {
            label: 'Functional Component',
            description: 'Modern React function component with hooks',
          },
          {
            label: 'Class Component',
            description: 'Traditional React class-based component',
          },
        ],
      },
    ]),
  },
};

export const SingleQuestionMultiSelect: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'Which features would you like to include?',
        multiSelect: true,
        options: [
          {
            label: 'TypeScript',
            description: 'Add TypeScript type definitions',
          },
          {
            label: 'Testing',
            description: 'Include unit test file',
          },
          {
            label: 'Storybook',
            description: 'Add Storybook story file',
          },
          {
            label: 'CSS Modules',
            description: 'Use CSS modules for styling',
          },
        ],
      },
    ]),
  },
};

export const MultipleQuestions: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'What type of component would you like to create?',
        options: [
          {
            label: 'Functional Component',
            description: 'Modern React function component with hooks',
          },
          {
            label: 'Class Component',
            description: 'Traditional React class-based component',
          },
        ],
      },
      {
        question: 'Where should the component be placed?',
        options: [
          {
            label: 'src/components',
            description: 'Main components directory',
          },
          {
            label: 'src/components/ui',
            description: 'UI primitives directory',
          },
          {
            label: 'src/components/shared',
            description: 'Shared components directory',
          },
        ],
      },
    ]),
  },
};

export const QuestionsWithHeaders: Story = {
  args: {
    question: createUserQuestion([
      {
        header: 'Component Configuration',
        question: 'Select the component type:',
        options: [
          {
            label: 'Server Component',
            description: 'React Server Component (RSC)',
          },
          {
            label: 'Client Component',
            description: "Client-side component with 'use client' directive",
          },
        ],
      },
      {
        header: 'Styling Options',
        question: 'Choose a styling approach:',
        options: [
          {
            label: 'Tailwind CSS',
            description: 'Utility-first CSS framework',
          },
          {
            label: 'CSS Modules',
            description: 'Scoped CSS with module imports',
          },
          {
            label: 'Styled Components',
            description: 'CSS-in-JS with styled-components',
          },
        ],
      },
    ]),
  },
};

export const ManyOptions: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'How should the API endpoint be structured?',
        options: [
          {
            label: 'REST API',
            description: 'Traditional REST endpoints with GET, POST, PUT, DELETE methods',
          },
          {
            label: 'GraphQL',
            description: 'Single endpoint with flexible queries',
          },
          {
            label: 'tRPC',
            description: 'End-to-end typesafe APIs for TypeScript projects',
          },
          {
            label: 'Server Actions',
            description: 'Next.js 14+ server actions for form submissions',
          },
        ],
      },
    ]),
  },
};

export const NoQuestion: Story = {
  args: {
    question: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'When question is null, the prompt is hidden and nothing is rendered.',
      },
    },
  },
};
