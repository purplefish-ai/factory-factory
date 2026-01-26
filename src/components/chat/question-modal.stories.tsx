import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { createUserQuestion } from '@/lib/claude-fixtures';

import { QuestionModal } from './question-modal';

const meta = {
  title: 'Chat/QuestionModal',
  component: QuestionModal,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    question: {
      control: 'object',
      description: 'The user question request to display, or null to hide the modal',
    },
    onAnswer: {
      action: 'onAnswer',
      description: 'Callback when user submits their answers',
    },
  },
  args: {
    onAnswer: fn(),
  },
} satisfies Meta<typeof QuestionModal>;

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
      {
        question: 'Would you like to include TypeScript types?',
        options: [
          {
            label: 'Yes',
            description: 'Include full TypeScript interface definitions',
          },
          {
            label: 'No',
            description: 'Plain JavaScript without type annotations',
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

export const QuestionsWithDescriptions: Story = {
  args: {
    question: createUserQuestion([
      {
        question: 'How should the API endpoint be structured?',
        options: [
          {
            label: 'REST API',
            description:
              'Traditional REST endpoints with GET, POST, PUT, DELETE methods. Good for simple CRUD operations.',
          },
          {
            label: 'GraphQL',
            description:
              'Single endpoint with flexible queries. Best for complex data requirements and frontend-driven development.',
          },
          {
            label: 'tRPC',
            description:
              'End-to-end typesafe APIs. Excellent for TypeScript projects with shared types between client and server.',
          },
          {
            label: 'Server Actions',
            description:
              'Next.js 14+ server actions. Simplest option for form submissions and mutations.',
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
        story: 'When question is null, the modal is hidden and nothing is rendered.',
      },
    },
  },
};
